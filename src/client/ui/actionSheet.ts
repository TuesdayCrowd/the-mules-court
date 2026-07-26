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
import { cardCopyFor } from '../content/cardCopy';
import { QUICK_REFERENCE } from '../content/quickReference';
import { classifyTopology } from '../layout/topology';
import type { ClientState } from '../store/types';
import type { Surface } from './surface';

export interface SheetTarget {
    readonly playerId: PlayerId;
    readonly nickname: string;
    readonly eligible: boolean;
    /** Shown to explain a disabled button. Hiding the target would hide the rule. */
    readonly reason?: 'protected' | 'eliminated';
}

export interface SheetRequest {
    readonly cardId: CardTypeId;
    readonly cardInstanceId: CardInstanceId;
    readonly targets: readonly SheetTarget[];
    /** Live viewport measurement. Never cached, never a device class. */
    readonly available: { readonly w: number; readonly h: number };
}

export interface PlayChoice {
    readonly cardInstanceId: CardInstanceId;
    readonly target?: PlayerId;
    readonly guess?: GuessValue;
}

export interface ActionSheetDeps {
    readonly onPlay: (choice: PlayChoice) => void;
    readonly onCancel: () => void;
}

export interface ActionSheet extends Surface {
    open(request: SheetRequest): void;
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
     * The nodes a choice can change, held so `refresh` can update them in place.
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

    function reset(): void {
        request = null;
        target = null;
        guess = null;
        expanded = null;
        live = null;
        container.replaceChildren();
    }

    function needs(): { target: boolean; guess: boolean } {
        if (request === null) return { target: false, guess: false };
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

    function refresh(): void {
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
        live.play.disabled = (required.target && target === null) || (required.guess && guess === null);
    }

    function targetSection(targets: Map<PlayerId, HTMLButtonElement>): HTMLElement {
        const section = document.createElement('section');

        if (!needs().target) {
            // A legal move stated calmly, not an error. The card still plays; it
            // simply fizzles, and requiring a choice that cannot be made would
            // strand the turn (UIX §7.2).
            const note = document.createElement('p');
            note.textContent = 'Every other player is protected or eliminated. This card will be discarded with no effect.';
            section.appendChild(note);
            return section;
        }

        section.dataset.role = 'targets';

        const heading = document.createElement('h3');
        heading.textContent = 'Choose a target';
        section.appendChild(heading);

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
                section.appendChild(button);
                if (entry.reason !== undefined) {
                    const reasonId = `target-reason-${entry.playerId}`;
                    const reason = document.createElement('span');
                    reason.id = reasonId;
                    reason.textContent = entry.reason;
                    button.setAttribute('aria-describedby', reasonId);
                    section.appendChild(reason);
                }
                continue;
            }

            button.addEventListener('click', () => {
                target = entry.playerId;
                refresh();
            });
            section.appendChild(button);
        }

        return section;
    }

    function guessSection(guesses: Map<number, HTMLButtonElement>): { section: HTMLElement; hint: HTMLElement } {
        const section = document.createElement('section');

        const heading = document.createElement('h3');
        heading.textContent = 'Guess a value';
        section.appendChild(heading);

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
                refresh();
            });
            guesses.set(value, button);
            section.appendChild(button);
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
            reset();
            deps.onPlay(choice);
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

        const title = document.createElement('h2');
        title.id = TITLE_ID;
        title.textContent = `${copy.value} · ${copy.displayName}`;

        const effectText = document.createElement('p');
        effectText.textContent = copy.effect;

        sheet.append(title, effectText);

        const targets = new Map<PlayerId, HTMLButtonElement>();
        const guesses = new Map<number, HTMLButtonElement>();
        let hint: HTMLElement | null = null;

        if (effect.requiresTarget) sheet.appendChild(targetSection(targets));
        if (needs().guess) {
            const built = guessSection(guesses);
            hint = built.hint;
            sheet.appendChild(built.section);
        }

        const built = footer();
        sheet.appendChild(built.bar);

        live = { targets, guesses, hint, play: built.play };
        container.replaceChildren(sheet);
        refresh();
    }

    return {
        mount(parent) {
            parent.appendChild(container);
        },

        update(state: ClientState) {
            // Anything but the table closes it; a sheet outliving its round
            // would offer a play that no longer exists.
            if (state.screen !== 'table' && request !== null) reset();
        },

        open(next) {
            request = next;
            target = null;
            guess = null;
            expanded = null;
            build();
        },

        close: reset,

        destroy() {
            container.remove();
        }
    };
}
