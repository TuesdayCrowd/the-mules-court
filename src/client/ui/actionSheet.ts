/**
 * Playing a card (UIX §7.2) — the densest surface in the design.
 *
 * **Viewport-anchored, never card-anchored.** A bottom sheet on narrow layouts,
 * a right-edge panel on wide ones, decided by a live measurement passed in at
 * open time rather than a device sniff — so a rotated phone or an unfolded
 * screen simply re-evaluates next time. Interface rule 9: the layers share
 * design tokens, never geometry.
 *
 * **It evaluates no rule about the game.** Which opponents are eligible, and
 * why, is assembled by the caller from `view.players` and handed over; this
 * renders what it is given. What it *does* read is static card data — whether a
 * card takes a target at all is a property of the card, not of the position.
 */

import { CARD_CATALOG, EFFECT_DEFS } from '../../game/engine';
import type { CardInstanceId, CardTypeId, GuessValue, PlayerId } from '../../game/engine';
import { cardCopyFor, cardLabel } from '../content/cardCopy';
import { NO_LEGAL_TARGET, NOT_YOUR_TURN, forcedPlaySentence } from '../content/playability';
import { QUICK_REFERENCE } from '../content/quickReference';
import type { TargetableSeatStatus } from '../content/seatStatus';
import { seatStatusCopy } from '../content/seatStatus';
import { classifyTopology } from '../layout/topology';
import { panelSafeTop } from '../layout/tableMetrics';
import type { UnplayableReason } from '../store/targets';
import type { ClientState } from '../store/types';
import type { Surface } from './surface';

export interface SheetTarget {
    readonly playerId: PlayerId;
    readonly nickname: string;
    readonly eligible: boolean;
    /** Shown to explain a disabled button. Hiding the target would hide the rule. */
    readonly reason?: TargetableSeatStatus;
}

export interface SheetRequest {
    readonly cardId: CardTypeId;
    readonly cardInstanceId: CardInstanceId;
    readonly targets: readonly SheetTarget[];
    /**
     * Why the engine will not take this card, or absent when it will.
     *
     * Assembled by the caller from `legalPlays`; this never works it out. It was
     * a boolean, and a boolean cannot tell "wait your turn" from "another card
     * in your hand forces itself" — so the sheet gave the first answer to both,
     * and told a player mid-turn to wait for a turn they were already having.
     *
     * A card is still worth opening while unplayable: reading what it does is
     * the most ordinary thing a player wants, and it is most wanted exactly
     * when they cannot play it.
     */
    readonly unplayable?: UnplayableReason;
    /** Live viewport measurement. Never cached, never a device class. */
    readonly available: { readonly w: number; readonly h: number };
    /**
     * The y this sheet may start at without covering anything a player is
     * deciding *about* — `LayoutSpec.opponentsBottom`, handed over by the caller.
     *
     * Only the right-edge anchor uses it. A bottom sheet already leaves the top
     * of the table alone, and insetting it would push it off the bottom of the
     * screen.
     *
     * Optional, and absent means the old full-height behaviour: the sheet opens
     * over the menu and the lobby too, where there is no table to avoid and so
     * no layout to read a line off.
     */
    readonly safeTop?: number;
}

export interface PlayChoice {
    readonly cardInstanceId: CardInstanceId;
    readonly target?: PlayerId;
    readonly guess?: GuessValue;
}

export interface ActionSheetDeps {
    /** Returns false when the play was refused; the sheet then stays open. */
    readonly onPlay: (choice: PlayChoice) => boolean;
    readonly onCancel: () => void;
}

export interface ActionSheet extends Surface {
    open(request: SheetRequest): void;
    /**
     * The card on the sheet, or `null` when it is closed.
     *
     * The caller assembles requests, so it is the caller that must reassemble
     * one when the table changes — and it needs to know there is a sheet to
     * reassemble for.
     */
    showing(): CardInstanceId | null;
    /**
     * Re-render the open sheet from a freshly assembled request.
     *
     * The sheet used to snapshot everything at `open()` and then watch only the
     * socket, so a card opened while waiting still read "Not your turn" after
     * the turn arrived, with Play dead beneath it.
     */
    refresh(request: SheetRequest): void;
    close(): void;
}

const TITLE_ID = 'action-sheet-title';

/** Every guessable value, derived: the Informant's own value is a rule, not an omission. */
const GUESSABLE = QUICK_REFERENCE.filter(row => row.guessable)
    .map(row => row.value)
    .sort((a, b) => a - b);

function charactersAt(value: number): string {
    const row = QUICK_REFERENCE.find(entry => entry.value === value);
    return row === undefined ? '' : row.cards.map(card => card.displayName).join(', ');
}

export function createActionSheet(deps: ActionSheetDeps): ActionSheet {
    const container = document.createElement('div');
    container.dataset.role = 'action-sheet-host';

    let request: SheetRequest | null = null;
    let target: PlayerId | null = null;
    let guess: GuessValue | null = null;
    let expanded: number | null = null;

    /**
     * The nodes a choice can change, held so `refreshLive` can update them in place.
     *
     * Rebuilding the sheet on every tap would throw away focus: a player who
     * tabbed to a target and pressed Enter would land back at the document root
     * with the sheet still open. Only these few attributes actually change.
     */
    interface Live {
        readonly targets: Map<PlayerId, HTMLButtonElement>;
        readonly guesses: Map<number, HTMLButtonElement>;
        readonly hint: HTMLElement | null;
        readonly play: HTMLButtonElement;
    }
    let live: Live | null = null;
    /**
     * Whether the socket is up.
     *
     * A play cannot leave while it is not, and `store.playCard` refuses
     * silently — so without this the player presses Play, the sheet sits there,
     * and nothing explains why. Interface rule: show the reason.
     */
    let connected = true;

    const offline = document.createElement('p');
    offline.dataset.role = 'offline-note';
    offline.className = 'field-error';
    offline.textContent = 'Reconnecting — you can play as soon as the court answers.';

    /**
     * Tells the rest of the DOM layer that a sheet is up, and where.
     *
     * The quick-reference tab and the sheet's footer both want the bottom-right
     * corner — UIX §10 layers the tab above the sheet, UIX §7.2 pins Cancel and
     * Play to the sheet's bottom edge — so the tab covers the very buttons the
     * sheet exists to offer. One attribute lets CSS move the tab aside for as
     * long as the sheet is open, with no measurement and no coupling beyond it.
     */
    function announceAnchor(anchor: string | null): void {
        const host = container.parentElement;
        if (host === null) return;
        if (anchor === null) host.removeAttribute('data-sheet');
        else host.setAttribute('data-sheet', anchor);
    }

    function reset(): void {
        announceAnchor(null);
        request = null;
        target = null;
        guess = null;
        expanded = null;
        live = null;
        container.replaceChildren();
    }

    function needs(): { target: boolean; guess: boolean } {
        if (request === null) return { target: false, guess: false };
        // An unplayable card asks nothing. Off-turn the engine sends no legal
        // targets at all, so every seat reads ineligible — which is the shape of
        // a fizzle and means nothing of the kind.
        if (request.unplayable !== undefined) return { target: false, guess: false };

        const effect = EFFECT_DEFS[CARD_CATALOG[request.cardId].effectType];
        const anyEligible = request.targets.some(entry => entry.eligible);
        return {
            // A card that requires a target but has none legal is still a legal
            // play — it fizzles. Requiring a choice that cannot be made would
            // strand the turn (UIX §7.2).
            target: effect.requiresTarget && anyEligible,
            guess: effect.requiresGuess && anyEligible
        };
    }

    /**
     * Choose the only eligible seat, and forget one that stopped being eligible.
     *
     * Pre-selecting is not playing: Play stays a deliberate press, and the
     * Informant still waits on its guess. A card that plays itself on one tap is
     * how a player discards The Mule by accident.
     *
     * Also the guard for a state push that arrives mid-decision — a seat gaining
     * protection while the sheet is open would otherwise leave a selection the
     * engine now refuses.
     */
    function autoSelect(): void {
        if (request === null || !needs().target) return;

        const stillLegal = request.targets.some(entry => entry.playerId === target && entry.eligible);
        if (target !== null && stillLegal) return;

        const eligible = request.targets.filter(entry => entry.eligible);
        target = eligible.length === 1 ? eligible[0].playerId : null;
    }

    /**
     * What the sheet would have to be rebuilt to show.
     *
     * A `STATE_UPDATE` lands for reasons that have nothing to do with this
     * decision — a seat reconnecting, a pause — and rebuilding on each one would
     * throw away a half-made choice and the player's focus with it. Compared
     * rather than deep-equalled because only these fields reach the DOM.
     */
    function signature(next: SheetRequest): string {
        return JSON.stringify([
            next.cardId,
            next.unplayable ?? null,
            next.targets.map(entry => [entry.playerId, entry.nickname, entry.eligible, entry.reason ?? null])
        ]);
    }

    function refreshLive(): void {
        if (live === null) return;

        for (const [playerId, button] of live.targets) {
            button.setAttribute('aria-pressed', String(target === playerId));
        }
        for (const [value, button] of live.guesses) {
            button.setAttribute('aria-pressed', String(guess === value));
        }
        if (live.hint !== null) {
            live.hint.textContent = expanded === null ? 'Tap a value to see its cards' : charactersAt(expanded);
        }

        const required = needs();
        live.play.disabled =
            !connected ||
            request?.unplayable !== undefined ||
            (required.target && target === null) ||
            (required.guess && guess === null);

        if (connected) {
            offline.remove();
        } else if (offline.parentElement === null) {
            live.play.parentElement?.before(offline);
        }
    }

    function targetSection(targets: Map<PlayerId, HTMLButtonElement>): HTMLElement {
        const section = document.createElement('section');

        if (!needs().target) {
            // A legal move stated calmly, not an error. The card still plays; it
            // simply fizzles, and requiring a choice that cannot be made would
            // strand the turn (UIX §7.2).
            //
            // Only reachable for a card that really is playable — `build` skips
            // this section entirely when something else is stopping the play, so
            // the sentence can no longer be printed about a turn that has not
            // arrived.
            const note = document.createElement('p');
            note.textContent = NO_LEGAL_TARGET;
            section.appendChild(note);
            return section;
        }

        section.dataset.role = 'targets';

        const heading = document.createElement('h3');
        heading.textContent = 'Choose a target';
        section.appendChild(heading);

        /**
         * The names, and nothing else.
         *
         * The section used to be one `flex-wrap` row holding the heading and
         * every button together, so "Choose a target" sat inline with the first
         * name and the rest wrapped around it — a paragraph of controls rather
         * than a list of choices. A wrapper that owns the buttons alone is what
         * lets the heading keep its own line and the names keep theirs.
         */
        const list = document.createElement('div');
        list.dataset.role = 'target-list';
        section.appendChild(list);

        /** textContent: another player's free text. */
        function nameLine(nickname: string): HTMLElement {
            const line = document.createElement('span');
            line.dataset.role = 'target-name';
            line.textContent = nickname;
            return line;
        }

        /** The designed word for the state, shared with the table's seat chip. */
        function stateLine(status: TargetableSeatStatus): HTMLElement {
            const line = document.createElement('span');
            line.dataset.role = 'target-state';
            line.textContent = seatStatusCopy(status);
            return line;
        }

        for (const entry of request!.targets) {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.target = entry.playerId;
            button.disabled = !entry.eligible;
            button.setAttribute('aria-pressed', 'false');
            button.textContent = entry.nickname; // textContent: another player's free text
            targets.set(entry.playerId, button);

            if (!entry.eligible) {
                // Rendered and disabled, never hidden: hiding it would hide the
                // rule that made it ineligible.
                //
                // The reason goes INSIDE the button. It was a sibling `<span>`
                // appended to the section, which laid out as a loose word adrift
                // in the target grid — with three targets, nothing tied
                // "eliminated" to the name it was about. Inside, it is part of
                // the button's accessible name too, which a disabled button
                // needs: it is not focusable, so `aria-describedby` on it is
                // reached far less reliably than the name is.
                if (entry.reason !== undefined) {
                    button.dataset.state = entry.reason;
                    button.replaceChildren(nameLine(entry.nickname), stateLine(entry.reason));
                }
                list.appendChild(button);
                continue;
            }

            button.addEventListener('click', () => {
                target = entry.playerId;
                refreshLive();
            });
            list.appendChild(button);
        }

        return section;
    }

    function guessSection(guesses: Map<number, HTMLButtonElement>): { section: HTMLElement; hint: HTMLElement } {
        const section = document.createElement('section');
        section.dataset.role = 'guess';

        const heading = document.createElement('h3');
        heading.textContent = 'Guess a value';
        section.appendChild(heading);

        /**
         * The seven values wrap among THEMSELVES.
         *
         * Sharing one `flex-wrap` row with the heading and the hint is how
         * "Guess a value" ended up beside the 2 and "Tap a value to see its
         * cards" beside the 8: they were simply two more items in the flow.
         */
        const grid = document.createElement('div');
        grid.dataset.role = 'guesses';
        section.appendChild(grid);

        for (const value of GUESSABLE) {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.guess = String(value);
            button.textContent = String(value);
            button.setAttribute('aria-pressed', 'false');
            button.addEventListener('click', () => {
                guess = value as GuessValue;
                // Choosing also reveals which characters share the value.
                // Knowing that value 5 is both Darells is the whole game.
                expanded = value;
                refreshLive();
            });
            guesses.set(value, button);
            grid.appendChild(button);
        }

        const hint = document.createElement('p');
        hint.dataset.role = 'guess-hint';
        hint.textContent = 'Tap a value to see its cards';
        section.appendChild(hint);

        return { section, hint };
    }

    function footer(): { bar: HTMLElement; play: HTMLButtonElement } {
        const bar = document.createElement('div');
        bar.className = 'sheet-footer';

        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.dataset.action = 'cancel';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => {
            reset();
            deps.onCancel();
        });

        const copy = cardCopyFor(request!.cardId);
        const play = document.createElement('button');
        play.type = 'button';
        play.dataset.action = 'play';

        // The Mule gets no extra modal — raising the card is already deliberate
        // — but its button states the consequence exactly.
        if (copy.playWarning !== undefined) {
            play.textContent = copy.playWarning;
            play.dataset.variant = 'danger';
        } else {
            play.textContent = 'Play';
        }

        play.addEventListener('click', () => {
            if (play.disabled) return;
            const choice: PlayChoice = {
                cardInstanceId: request!.cardInstanceId,
                ...(target !== null ? { target } : {}),
                ...(guess !== null ? { guess } : {})
            };

            // Ask first, close second. Closing regardless is what made every
            // refusal — a socket mid-reconnect, a play already in flight —
            // indistinguishable from the button doing nothing at all.
            if (deps.onPlay(choice)) reset();
        });

        bar.append(cancel, play);
        return { bar, play };
    }

    function build(): void {
        if (request === null) return;
        const copy = cardCopyFor(request.cardId);
        const effect = EFFECT_DEFS[CARD_CATALOG[request.cardId].effectType];

        const sheet = document.createElement('div');
        sheet.dataset.role = 'action-sheet';
        sheet.setAttribute('role', 'dialog');
        sheet.setAttribute('aria-labelledby', TITLE_ID);
        sheet.className = 'action-sheet';
        // Measured now, not remembered: the same session can rotate or unfold.
        sheet.dataset.anchor = classifyTopology(request.available.w, request.available.h) === 'wide' ? 'right' : 'bottom';

        /**
         * Start the right-edge panel below the seats rather than at the top of
         * the viewport.
         *
         * Set inline rather than in `ui.css` because the line is a number the
         * layout computed for this viewport, and a stylesheet cannot read it.
         * Clamped so a short or badly-proportioned viewport can never inset the
         * sheet past half its own height — a panel starting below the fold is a
         * worse failure than a covered seat.
         */
        if (sheet.dataset.anchor === 'right' && request.safeTop !== undefined) {
            sheet.style.top = `${panelSafeTop(request.safeTop, request.available.h)}px`;
        }

        const title = document.createElement('h2');
        title.id = TITLE_ID;
        // One formatter, shared with the canvas card faces, so the sheet and
        // the card a player tapped can never disagree about what it is.
        title.textContent = cardLabel(request.cardId);

        const effectText = document.createElement('p');
        effectText.textContent = copy.effect;

        sheet.append(title, effectText);

        if (request.unplayable !== undefined) {
            // Show-reasons applies to the Play button as much as to a target —
            // and the reason has to be the real one.
            const why = document.createElement('p');
            why.dataset.role = 'not-playable';
            why.textContent =
                request.unplayable.kind === 'forced'
                    ? forcedPlaySentence(request.unplayable.mustPlay)
                    : NOT_YOUR_TURN;
            sheet.appendChild(why);
        }

        const targets = new Map<PlayerId, HTMLButtonElement>();
        const guesses = new Map<number, HTMLButtonElement>();
        let hint: HTMLElement | null = null;

        // No decision is offered while something else is stopping the play. The
        // reason line above is the whole answer, and a list of seats beneath it
        // — every one of them disabled, because the engine sent no legal targets
        // — would read as a rule about protection.
        if (request.unplayable === undefined && effect.requiresTarget) sheet.appendChild(targetSection(targets));
        if (needs().guess) {
            const built = guessSection(guesses);
            hint = built.hint;
            sheet.appendChild(built.section);
        }

        const built = footer();
        sheet.appendChild(built.bar);

        live = { targets, guesses, hint, play: built.play };
        container.replaceChildren(sheet);
        announceAnchor(sheet.dataset.anchor ?? 'bottom');
        refreshLive();
    }

    return {
        mount(parent) {
            parent.appendChild(container);
        },

        update(state: ClientState) {
            // Anything but the table closes it; a sheet outliving its round
            // would offer a play that no longer exists.
            if (state.screen !== 'table' && request !== null) reset();

            const up = state.connection === 'open';
            if (up === connected) return;
            connected = up;
            refreshLive();
        },

        open(next) {
            request = next;
            target = null;
            guess = null;
            expanded = null;
            autoSelect();
            build();
        },

        showing() {
            return request?.cardInstanceId ?? null;
        },

        refresh(next) {
            // A refresh is for the card already open. Anything else is a stale
            // caller, and swapping the sheet under the player's hand would be a
            // worse answer than ignoring it.
            if (request === null || request.cardInstanceId !== next.cardInstanceId) return;

            const changed = signature(next) !== signature(request);
            request = next;

            if (!changed) {
                // Nothing the DOM shows has moved. Rebuilding anyway would drop
                // focus and a half-made choice for a push about something else.
                refreshLive();
                return;
            }

            autoSelect();
            build();
        },

        close: reset,

        destroy() {
            container.remove();
        }
    };
}
