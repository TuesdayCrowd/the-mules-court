/**
 * The table, in DOM (UIX §2.5, §6) — the replacement for `Court.ts`'s canvas.
 *
 * Same contract as every other surface (`surface.ts`): `update(state)` is
 * pushed by the single subscriber, nothing here reaches for `location`,
 * `localStorage`, or a timer, and the viewport is injected rather than read
 * from `window` directly — exactly the reason `cardHint.ts` takes one.
 *
 * **It computes no geometry and decides no rule (interface rule 1).**
 * `update` calls `computeLayout` then `buildRenderPlan`, exactly as
 * `Court.renderView` does, and every position below is a field read off the
 * result — never a number invented here. That is the property
 * `courtContract.test.ts` (and its eventual DOM twin) holds the design to,
 * and it is why every helper below takes a `Rect` or a spec field as an
 * argument instead of a raw pixel.
 *
 * **Built dark, beside the existing scene (Stage 4 of the renderer plan).**
 * Nothing here is wired into `main.ts` yet — that cutover, and the beats
 * (`beats.ts`'s cinematic sequences), are Stage 5. `currentLayout()` exists
 * now because that is the shape the eventual beat wiring and the a11y story
 * will need, the same way `Court.currentLayout()` feeds the (soon to be
 * retired) accessibility twin today.
 *
 * **Real `<button>`s, not decorated `<div>`s.** A seat chip and a hand card
 * are both actions a player can take (open the dossier; raise the card), so
 * both are focusable and get an accessible name — which is what lets this
 * file retire `a11yTwin.ts` rather than needing a shadow copy of itself.
 * `textContent` throughout, never `innerHTML`: a nickname is another
 * player's free text.
 */

import { medallionPlan, type DeckPlan, type HandCardPlan, type OwnStatusPlan, type RenderPlan, type SeatPlan } from '../layout/renderPlan';
import { buildRenderPlan } from '../layout/renderPlan';
import { computeLayout, MEDALLION_GAP, pipBlockHeight, PIP_GAP_PX } from '../layout/tableLayout';
import { fitOverline } from '../layout/overline';
import {
    BADGE_FRACTION,
    BANNER_PLATE_PAD,
    CARD_BACK_H,
    DECK_PULSE_REPEATS_STRONG,
    DECK_PULSE_REPEATS_SUBTLE,
    LABEL_PAD,
    LONG_PRESS_MS,
    MIN_BADGE,
    MIN_BANNER_PX,
    MIN_NAME_H,
    MIN_SLIVER_HEIGHT,
    MIN_SLIVER_STEP,
    MOVE_CANCEL_PX,
    NAME_FRACTION,
    PORTRAIT_ASPECT,
    REVEALED_H,
    SEAT_COLOURS,
    SLIVER_INSET,
    SLIVER_STEP_FRACTION
} from '../layout/tableMetrics';
import type { ChipSpec, LayoutSpec, Rect } from '../layout/types';
import { cardCopyFor, cardLabel } from '../content/cardCopy';
import { CARD_BACK_ASSET, portraitPath } from '../content/portraits';
import { hex, TOKENS } from '../tokens/tokens';
import type { ClientState } from '../store/types';
import type { CardInstanceId, CardTypeId, PlayerId } from '../../game/engine';
import type { Surface, Timers } from './surface';

/**
 * `/assets/…` is the loader root every other asset reference in this client
 * uses (see AGENTS.md: loader paths are absolute).
 *
 * Exported because the beats need the same root and there must be exactly one
 * definition of it. A relative path resolves against `/join/:matchId`, which
 * the SPA fallback answers with the shell and a **200** — so a second, subtly
 * different copy would not 404, it would decode HTML as an image and silently
 * render nothing.
 */
export function assetUrl(pathUnderAssets: string): string {
    return `/assets/${pathUnderAssets}`;
}

const DEVOTION_TOKEN_SRC = assetUrl('misc/devotion_token.png');
const CARD_BACK_SRC = assetUrl(CARD_BACK_ASSET);
const PLAYFIELD_SRC = assetUrl('misc/playfield_background_space.png');

export interface TableDeps {
    /** A hand card was tapped or activated. `main.ts`'s eventual wiring opens the action sheet. */
    readonly onCardSelected: (cardInstanceId: CardInstanceId) => void;
    /** Hover (pointer) or a resolved long-press (touch) on any card-shaped surface. */
    readonly onCardHinted: (cardId: CardTypeId, at: { readonly x: number; readonly y: number }) => void;
    readonly onCardHintCleared: () => void;
    /** A seat chip, or its revealed card, was activated — opens the seat dossier. */
    readonly onSeatSelected: (playerId: PlayerId) => void;
    /** A run of devotion medallions was activated — opens the match log. */
    readonly onTokensSelected: (playerId: PlayerId) => void;
    /**
     * Live viewport, injected rather than read from `window` — `computeLayout`
     * needs a size and nothing below `src/client/` reaches for a browser global
     * itself. Never cached: a rotated phone or an unfolded screen simply calls
     * this again on the next `update`.
     */
    readonly viewport: () => { readonly w: number; readonly h: number };
    /**
     * The long-press-to-hint gesture's clock — the same seam every other
     * surface takes (`overlays.ts`, `toasts.ts`), and the one this file's own
     * header promises ("nothing here reaches for ... a timer"). `main.ts`
     * passes `REAL_TIMERS`; a test passes a fake one it can fire by hand.
     */
    readonly timers: Timers;
}

export interface Table extends Surface {
    /** The spec the table was last drawn from, for whatever eventually needs it (a beat, a future a11y helper). */
    currentLayout(): LayoutSpec | null;
}

// --------------------------------------------------------------- geometry

function px(n: number): string {
    return `${n}px`;
}

/** Positions an already-created element as an absolutely-placed rect, relative to its own positioned ancestor. */
function setRect(el: HTMLElement, rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }): void {
    el.style.position = 'absolute';
    el.style.left = px(rect.x);
    el.style.top = px(rect.y);
    el.style.width = px(rect.w);
    el.style.height = px(rect.h);
}

/** A palette integer plus an alpha, as the `rgba()` string a scrim or a dimmed border wants. CSS custom properties carry the opaque colours; this is only for the handful of places Court.ts itself draws at partial alpha. */
function rgba(colour: number, alpha: number): string {
    const r = (colour >> 16) & 0xff;
    const g = (colour >> 8) & 0xff;
    const b = colour & 0xff;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ------------------------------------------------------------------ build

export function createTable(deps: TableDeps): Table {
    const container = document.createElement('div');
    container.dataset.role = 'table-host';
    container.className = 'table-root';

    const background = document.createElement('div');
    background.dataset.role = 'table-background';
    background.className = 'table-background';
    background.setAttribute('aria-hidden', 'true');
    background.style.backgroundImage = `url(${PLAYFIELD_SRC})`;

    const planLayer = document.createElement('div');
    planLayer.dataset.role = 'table-plan';
    planLayer.className = 'table-plan';

    container.append(background, planLayer);

    let spec: LayoutSpec | null = null;

    /**
     * Text that only knows its final width once it is laid out. Collected while
     * building the plan and run once everything is attached to `planLayer` —
     * attaching first is what makes `scrollWidth` meaningful; a detached node
     * always measures zero.
     */
    let pendingFits: Array<() => void> = [];

    /**
     * Hover, and a wall-clock long-press on touch (UIX §349's "never depend on
     * hover"). Routed through `deps.timers` (`surface.ts`'s `Timers`), never
     * `window.setTimeout` directly — the timer has to keep running even while
     * nothing else on the page is, there is no render loop here to sleep, and
     * the same wall-clock reasoning is why a real clock still backs it in
     * production; injection is what lets a test fire it deterministically
     * instead of waiting on a real one.
     *
     * The tap itself fires from `click`, not `pointerup` — `Court.ts` uses
     * `pointerup` because Phaser dispatches nothing for a keyboard activation at
     * all. A real `<button>` does: Enter/Space raises a `click` with no
     * preceding pointer event, and a handler that only ever heard `pointerup`
     * would silently drop every keyboard player. `click` fires for a mouse tap,
     * a touch tap and a keyboard activation alike, so it is the one event that
     * covers all three — and `longPressed` still suppresses it exactly once,
     * for the touch case where a resolved long-press must not also raise the
     * sheet over the hint it just showed.
     */
    function attachCardGesture(el: HTMLElement, cardId: CardTypeId, onTap?: () => void): void {
        let pressedAt: { x: number; y: number } | null = null;
        let longPressed = false;
        let pressTimer: unknown = null;

        const cancelTimer = (): void => {
            if (pressTimer !== null) deps.timers.clearTimeout(pressTimer);
            pressTimer = null;
        };

        el.addEventListener('pointerover', (event: PointerEvent) => {
            if (event.pointerType === 'touch') return;
            deps.onCardHinted(cardId, { x: event.clientX, y: event.clientY });
        });

        el.addEventListener('pointermove', (event: PointerEvent) => {
            if (event.pointerType === 'touch') {
                if (pressedAt !== null) {
                    const dx = event.clientX - pressedAt.x;
                    const dy = event.clientY - pressedAt.y;
                    if (Math.sqrt(dx * dx + dy * dy) > MOVE_CANCEL_PX) {
                        cancelTimer();
                        pressedAt = null;
                    }
                }
                return;
            }
            deps.onCardHinted(cardId, { x: event.clientX, y: event.clientY });
        });

        el.addEventListener('pointerout', () => {
            cancelTimer();
            pressedAt = null;
            deps.onCardHintCleared();
        });

        el.addEventListener('pointerdown', (event: PointerEvent) => {
            pressedAt = { x: event.clientX, y: event.clientY };
            longPressed = false;
            cancelTimer();
            pressTimer = deps.timers.setTimeout(() => {
                pressTimer = null;
                if (pressedAt === null) return;
                longPressed = true;
                deps.onCardHinted(cardId, pressedAt);
            }, LONG_PRESS_MS);
        });

        el.addEventListener('pointerup', cancelTimer);

        el.addEventListener('click', () => {
            // A resolved long-press already showed the hint; raising the sheet
            // over the thing the player pressed to read would be the wrong turn.
            if (longPressed) {
                longPressed = false;
                return;
            }
            onTap?.();
        });
    }

    // ----------------------------------------------------------- card face

    interface CardFaceLabel {
        readonly overlineWrap: HTMLElement | null;
        readonly partsWrap: HTMLElement;
    }

    /**
     * A card face's value badge, name, and optional caption band — shared by
     * the burn panel and every hand card, exactly as `Court.ts#cardFaceLabel` is.
     *
     * `partsWrap` (the badge and the name) and `overlineWrap` (the caption) come
     * back apart because callers hold them to different opacities: on a dimmed
     * hand card the caption IS the reason for the dimming, so it stays at full
     * opacity while the badge and name fade.
     */
    function buildCardFaceLabel(cardId: CardTypeId, rect: { readonly w: number; readonly h: number }, overline: string | null): CardFaceLabel {
        const copy = cardCopyFor(cardId);
        const badge = Math.max(MIN_BADGE, Math.round(Math.min(rect.w, rect.h) * BADGE_FRACTION));
        const nameH = Math.max(MIN_NAME_H, Math.round(rect.h * NAME_FRACTION));

        const partsWrap = document.createElement('div');
        partsWrap.className = 'tbl-card-parts';

        const nameScrim = document.createElement('div');
        nameScrim.className = 'tbl-card-name-scrim';
        setRect(nameScrim, { x: 0, y: rect.h - nameH, w: rect.w, h: nameH });

        const name = document.createElement('span');
        name.className = 'tbl-card-name';
        name.textContent = copy.displayName;
        name.style.fontSize = px(Math.round(nameH * 0.52));
        nameScrim.appendChild(name);

        const plate = document.createElement('div');
        plate.className = 'tbl-card-badge-plate';
        setRect(plate, { x: 0, y: 0, w: badge, h: badge });

        const value = document.createElement('span');
        value.className = 'tbl-card-badge-value';
        value.textContent = String(copy.value);
        value.style.fontSize = px(Math.round(badge * 0.68));
        plate.appendChild(value);

        partsWrap.append(nameScrim, plate);

        // The name gives way before the value does — the value is what every
        // rule in the game is written in, so it never shrinks.
        pendingFits.push(() => {
            const available = rect.w - LABEL_PAD;
            const width = name.scrollWidth;
            if (width > available && width > 0) {
                name.style.transform = `scale(${available / width})`;
            }
        });

        let overlineWrap: HTMLElement | null = null;
        if (overline !== null) {
            const bandH = Math.max(MIN_NAME_H, Math.round(rect.h * NAME_FRACTION));
            const fontSize = Math.round(bandH * 0.46);
            const captionW = Math.max(0, rect.w - badge - LABEL_PAD);

            overlineWrap = document.createElement('div');
            overlineWrap.className = 'tbl-card-overline';
            setRect(overlineWrap, { x: 0, y: 0, w: rect.w, h: bandH });

            const inner = document.createElement('div');
            inner.className = 'tbl-card-overline-inner';
            setRect(inner, { x: badge, y: 0, w: captionW, h: bandH });

            const caption = document.createElement('span');
            caption.className = 'tbl-card-overline-text';
            caption.textContent = overline;
            caption.style.fontSize = px(fontSize);
            inner.appendChild(caption);
            overlineWrap.appendChild(inner);

            const wrap = overlineWrap;
            // Dropped entirely, never shown smeared: `fitOverline` is the same
            // pure function `Court.ts` calls, so the two renderers agree on the
            // floor below which a caption stops being legible.
            pendingFits.push(() => {
                const scale = fitOverline(captionW, caption.scrollWidth, fontSize);
                if (scale === null) wrap.remove();
                else caption.style.transform = `scale(${scale})`;
            });
        }

        return { overlineWrap, partsWrap };
    }

    // ------------------------------------------------------------ medallions

    function appendMedallions(host: HTMLElement, tokens: number, x: number, y: number, size: number): void {
        // `medallionPlan` decides; this only draws what it was told to —
        // deciding first is what stops an abandoned medallion surviving a
        // collapse, the bug `medallionPlan`'s own docs describe.
        const plan = medallionPlan(tokens);
        const step = size + MEDALLION_GAP;

        for (let index = 0; index < plan.medallions; index++) {
            const img = document.createElement('img');
            img.className = 'tbl-art tbl-medallion';
            img.src = DEVOTION_TOKEN_SRC;
            img.alt = '';
            img.loading = 'lazy';
            img.decoding = 'async';
            setRect(img, { x: x + index * step, y, w: size, h: size });
            host.appendChild(img);
        }

        if (plan.countLabel !== null) {
            const label = document.createElement('span');
            label.className = 'tbl-medallion-count';
            label.textContent = plan.countLabel;
            label.style.left = px(x + step);
            label.style.top = px(y + size / 2);
            label.style.fontSize = px(Math.max(11, Math.round(size * 0.9)));
            host.appendChild(label);
        }
    }

    // ---------------------------------------------------------- chip line

    /**
     * One small labelled line inside a seat chip — the peek marker, or the
     * state caption. Both are `Court.ts#chipLine`.
     *
     * `chip.smallH` is likewise an explicit height, not the scrim's own text
     * metrics: `.tbl-chip-line`'s rendered height (`smallPx * 1.2 + 2px` of
     * padding) overflows the budget `chipBands` reserved for it whenever
     * `smallPx < 20` — the common case, since `MIN_SMALL_LINE_PX` floors it at
     * 10 — which is how the caption used to bleed into the pip row beneath it.
     */
    function appendChipLine(host: HTMLElement, chip: ChipSpec, seatW: number, top: number, text: string, colour: string): void {
        const line = document.createElement('div');
        line.className = 'tbl-chip-line';
        line.style.left = px(chip.pad);
        line.style.top = px(top);
        line.style.height = px(chip.smallH);
        line.style.display = 'flex';
        line.style.alignItems = 'center';
        line.style.color = colour;
        line.style.fontSize = px(chip.smallPx);

        const label = document.createElement('span');
        label.textContent = text;
        line.appendChild(label);
        host.appendChild(line);

        const room = seatW - chip.pad * 2;
        pendingFits.push(() => {
            const width = label.scrollWidth;
            if (width > room && width > 0) label.style.transform = `scale(${room / width})`;
        });
    }

    // -------------------------------------------------------------- seats

    function seatAccessibleName(seat: SeatPlan, tokensToWin: number): string {
        const status = seat.caption ?? (seat.state === 'current' ? 'current turn' : 'in the round');
        const discards = seat.discardValues.length === 0 ? '' : `, discards ${seat.discardValues.join(', ')}`;
        const known = seat.knownCard === null ? '' : `, you know they hold ${cardLabel(seat.knownCard)}`;
        return `${seat.nickname} — ${status}, ${seat.tokens} of ${tokensToWin} devotion tokens${discards}${known}`;
    }

    function buildSeatChip(
        seat: SeatPlan,
        pip: LayoutSpec['pip'],
        chip: ChipSpec,
        tokensToWin: number
    ): HTMLElement {
        const wrap = document.createElement('div');
        wrap.dataset.role = 'seat-chip';
        wrap.className = 'tbl-seat';
        setRect(wrap, seat.rect);

        const hit = document.createElement('button');
        hit.type = 'button';
        hit.className = 'tbl-seat-hit';
        hit.dataset.state = seat.state;
        hit.style.borderColor =
            seat.state === 'eliminated' ? rgba(SEAT_COLOURS[seat.state], 0.5) : hex(SEAT_COLOURS[seat.state]);
        hit.setAttribute('aria-label', seatAccessibleName(seat, tokensToWin));
        hit.addEventListener('click', () => deps.onSeatSelected(seat.playerId));

        // `chip.nameBandH` is an EXPLICIT height, read from the spec rather
        // than left to the scrim's own text metrics (`width: fit-content` in
        // table.css sizes it, but never gave it a height). Without one, the
        // scrim's line-box height drifts past the budget `chipBands` reserved
        // for it on a large enough chip — the exact regression the token row
        // already shipped once (see `ChipSpec`'s own docblock) — and paints
        // over the token row below it.
        const nameScrim = document.createElement('div');
        nameScrim.className = 'tbl-seat-name-scrim';
        nameScrim.style.left = px(chip.pad);
        nameScrim.style.top = px(0);
        nameScrim.style.height = px(chip.nameBandH);
        nameScrim.style.display = 'flex';
        nameScrim.style.alignItems = 'center';
        const name = document.createElement('span');
        name.className = 'tbl-seat-name';
        name.textContent = seat.nickname; // textContent: another player's free text
        name.style.fontSize = px(chip.nameH);
        nameScrim.appendChild(name);
        hit.appendChild(nameScrim);

        if (seat.holdsCard) {
            const back = document.createElement('img');
            back.className = 'tbl-art tbl-seat-back';
            back.src = CARD_BACK_SRC;
            back.alt = '';
            back.loading = 'lazy';
            back.decoding = 'async';
            back.style.right = px(chip.pad);
            back.style.top = px(chip.pad);
            back.style.width = px(CARD_BACK_H * PORTRAIT_ASPECT);
            back.style.height = px(CARD_BACK_H);
            hit.appendChild(back);
        }

        appendMedallions(hit, seat.tokens, chip.pad, chip.tokenTop, chip.medallion);

        // Interface rule 7: every discarded value, never a truncation. `pip`
        // is the size `fitPips` already proved fits every value in the pile —
        // read here, never reinvented.
        const pipStep = pip.size + PIP_GAP_PX;
        const pipsTop = chip.pipTop;
        const pipsAcross = Math.min(seat.discardValues.length, pip.perRow);

        if (pipsAcross > 0) {
            const scrim = document.createElement('div');
            scrim.className = 'tbl-seat-pip-scrim';
            setRect(scrim, {
                x: 0,
                y: pipsTop - 4,
                w: pipsAcross * pipStep + chip.pad * 2,
                h: pipBlockHeight(pip) + 10
            });
            hit.appendChild(scrim);
        }

        seat.discardValues.forEach((value, index) => {
            const numeral = document.createElement('span');
            numeral.className = 'tbl-seat-pip';
            numeral.textContent = String(value);
            numeral.style.left = px(chip.pad + (index % pip.perRow) * pipStep);
            numeral.style.top = px(pipsTop + Math.floor(index / pip.perRow) * pipStep);
            numeral.style.fontSize = px(pip.size);
            hit.appendChild(numeral);
        });

        // UIX §6.3: an eliminated seat's held card is revealed atop their pile —
        // core deduction data, drawn as a decorative face inside the chip-wide
        // button plus its own smaller button on top, so it wins the hit test the
        // way `Court.ts` makes it win by drawing order.
        if (seat.revealedCard !== null) {
            const revealed = document.createElement('img');
            revealed.className = 'tbl-art tbl-seat-revealed';
            revealed.src = assetUrl(portraitPath(seat.revealedCard));
            revealed.alt = '';
            revealed.loading = 'lazy';
            revealed.decoding = 'async';
            revealed.style.right = px(chip.pad);
            revealed.style.bottom = px(chip.pad);
            revealed.style.width = px(REVEALED_H * PORTRAIT_ASPECT);
            revealed.style.height = px(REVEALED_H);
            hit.appendChild(revealed);

            const value = document.createElement('span');
            value.className = 'tbl-seat-revealed-value';
            value.textContent = String(cardCopyFor(seat.revealedCard).value);
            value.style.right = px(chip.pad + REVEALED_H * PORTRAIT_ASPECT + 2);
            value.style.bottom = px(chip.pad);
            hit.appendChild(value);
        }

        wrap.appendChild(hit);

        // UIX §6.2: tapping the token run opens the match log at the round it
        // was won in. Added AFTER `hit` so it sits above it in paint AND hit
        // order — the same "added later wins" rule `Court.ts` uses.
        const tokenHit = document.createElement('button');
        tokenHit.type = 'button';
        tokenHit.className = 'tbl-seat-tokens-hit';
        tokenHit.setAttribute('aria-label', `${seat.nickname}'s devotion tokens: ${seat.tokens}`);
        setRect(tokenHit, {
            x: chip.pad,
            y: chip.tokenTop,
            w: Math.max(1, Math.min(seat.rect.w - chip.pad * 2, chip.medallion * 5)),
            h: chip.medallion
        });
        tokenHit.addEventListener('click', () => deps.onTokensSelected(seat.playerId));
        wrap.appendChild(tokenHit);

        if (seat.revealedCard !== null) {
            const revealedHit = document.createElement('button');
            revealedHit.type = 'button';
            revealedHit.className = 'tbl-seat-revealed-hit';
            revealedHit.setAttribute('aria-label', `${seat.nickname} revealed ${cardLabel(seat.revealedCard)}`);
            setRect(revealedHit, {
                x: seat.rect.w - chip.pad - REVEALED_H * PORTRAIT_ASPECT,
                y: seat.rect.h - chip.pad - REVEALED_H,
                w: REVEALED_H * PORTRAIT_ASPECT,
                h: REVEALED_H
            });
            attachCardGesture(revealedHit, seat.revealedCard, () => deps.onSeatSelected(seat.playerId));
            wrap.appendChild(revealedHit);
        }

        // The peek marker (UIX §8.1) — only this viewer sees it, and it
        // persists exactly as long as the engine keeps considering the peek
        // valid; this mirrors `seat.knownCard` and decides nothing.
        if (seat.knownCard !== null) {
            appendChipLine(
                hit,
                chip,
                seat.rect.w,
                chip.markerTop,
                `you know: ${cardLabel(seat.knownCard)}`,
                hex(TOKENS.colorSeatProtected)
            );
        }

        if (seat.caption !== null) {
            appendChipLine(hit, chip, seat.rect.w, chip.captionTop, seat.caption, hex(SEAT_COLOURS[seat.state]));
        }

        return wrap;
    }

    // --------------------------------------------------------------- deck

    function buildDeck(deck: DeckPlan): HTMLElement {
        const el = document.createElement('div');
        el.dataset.role = 'deck';
        el.className = 'tbl-deck';
        el.setAttribute('aria-label', deck.count === 0 ? 'Deck: empty' : `Deck: ${deck.count} cards remaining`);
        setRect(el, deck.rect);
        el.style.backgroundColor = hex(deck.colour);

        const count = document.createElement('span');
        count.className = 'tbl-deck-count';
        count.textContent = String(deck.count);
        count.style.fontSize = px(Math.round(deck.rect.h * 0.32));
        el.appendChild(count);

        /**
         * UIX §6.4's warning. Bounded, never `infinite`, for the reason
         * `Court.ts` gives at length — an endless animation is exactly the
         * shape of thing a render-loop-sleep policy exists to forbid, and while
         * this DOM table has no such loop yet, an unbounded CSS animation would
         * still burn a compositor frame forever for no player benefit. It
         * restarts on every draw because a fresh element gets a fresh
         * animation for free — no explicit re-fire needed the way a live tween
         * needed one.
         */
        if (deck.pulse !== 'none') {
            el.dataset.pulse = deck.pulse;
            el.style.setProperty('--pulse-floor', deck.pulse === 'strong' ? '0.45' : '0.7');
            el.style.animationDuration = deck.pulse === 'strong' ? '520ms' : '900ms';
            el.style.animationIterationCount = String(
                (deck.pulse === 'strong' ? DECK_PULSE_REPEATS_STRONG : DECK_PULSE_REPEATS_SUBTLE) + 1
            );
        }

        return el;
    }

    // ------------------------------------------------------------- banner

    function buildBanner(banner: RenderPlan['banner']): HTMLElement {
        const el = document.createElement('div');
        el.dataset.role = 'banner';
        el.className = 'tbl-banner';
        setRect(el, banner.rect);

        const plate = document.createElement('span');
        plate.className = 'tbl-banner-plate';
        plate.textContent = banner.text;
        plate.style.color = hex(banner.colour);
        plate.style.fontSize = px(Math.max(MIN_BANNER_PX, Math.round(banner.rect.h * 0.7)));
        plate.style.padding = `${px(BANNER_PLATE_PAD / 2)} ${px(BANNER_PLATE_PAD)}`;
        el.appendChild(plate);

        return el;
    }

    // -------------------------------------------------------- removed card

    function buildRemovedCard(removed: NonNullable<RenderPlan['removedCard']>): HTMLElement {
        const panel = removed.rect;
        const hidden = removed.faceDownCount;

        const el = document.createElement('div');
        el.dataset.role = 'removed-card';
        el.className = 'tbl-removed';
        el.setAttribute(
            'aria-label',
            `Removed from play: ${cardLabel(removed.cardId)}` + (hidden === 0 ? '' : `, and ${hidden} more face down`)
        );
        setRect(el, panel);

        // The face-up card gives up width to the face-down slivers fanned
        // beside it — the same shrink `Court.ts` computes, in local coordinates
        // rather than table-wide ones since this panel is its own positioned
        // element.
        const sliverStep = hidden > 0 ? Math.max(MIN_SLIVER_STEP, Math.round(panel.w * SLIVER_STEP_FRACTION)) : 0;
        const faceW = panel.w - sliverStep * hidden;
        const faceRect: Rect = { x: 0, y: 0, w: faceW, h: panel.h };

        // Back to front, so each sliver tucks behind the one to its left.
        for (let index = hidden; index >= 1; index--) {
            const inset = SLIVER_INSET * index;
            const height = Math.max(MIN_SLIVER_HEIGHT, panel.h - inset * 2);
            const right = faceW + sliverStep * index;

            const sliver = document.createElement('img');
            sliver.className = 'tbl-art tbl-removed-sliver';
            sliver.src = CARD_BACK_SRC;
            sliver.alt = '';
            sliver.loading = 'lazy';
            sliver.decoding = 'async';
            setRect(sliver, { x: right - faceW, y: inset, w: faceW, h: height });
            el.appendChild(sliver);
        }

        const burn = document.createElement('img');
        burn.className = 'tbl-art tbl-removed-face';
        burn.src = assetUrl(portraitPath(removed.cardId));
        burn.alt = '';
        burn.loading = 'lazy';
        burn.decoding = 'async';
        setRect(burn, faceRect);
        el.appendChild(burn);

        // "Removed", not "Removed from play" — the shorter phrase is what fits
        // legibly on the smallest card on the table; the full phrase is the
        // `aria-label` above, which is where the accessibility twin's fuller
        // wording now lives.
        const label = buildCardFaceLabel(removed.cardId, faceRect, 'Removed');
        if (label.overlineWrap !== null) el.appendChild(label.overlineWrap);
        el.appendChild(label.partsWrap);

        return el;
    }

    // ---------------------------------------------------------- own status

    function buildOwnStatus(own: OwnStatusPlan, spec: LayoutSpec): HTMLElement {
        const row = spec.ownRow;
        const el = document.createElement('div');
        el.dataset.role = 'own-status';
        el.className = 'tbl-own';
        setRect(el, own.rect);

        appendMedallions(el, own.tokens, 0, own.rect.h / 2 - spec.chip.medallion / 2, spec.chip.medallion);

        const tokenHit = document.createElement('button');
        tokenHit.type = 'button';
        tokenHit.className = 'tbl-own-tokens-hit';
        tokenHit.setAttribute('aria-label', `Your devotion tokens: ${own.tokens}`);
        setRect(tokenHit, { x: 0, y: 0, w: row.medallionSpan, h: own.rect.h });
        tokenHit.addEventListener('click', () => deps.onTokensSelected(own.playerId));
        el.appendChild(tokenHit);

        const facesLeft = row.medallionSpan;
        const faceTop = (own.rect.h - row.iconH) / 2;

        own.discards.forEach((discard, index) => {
            const x = facesLeft + index * row.step;

            const face = document.createElement('img');
            face.className = 'tbl-art tbl-own-discard-face';
            face.src = assetUrl(portraitPath(discard.cardId));
            face.alt = '';
            face.loading = 'lazy';
            face.decoding = 'async';
            setRect(face, { x, y: faceTop, w: row.iconW, h: row.iconH });
            el.appendChild(face);

            const plate = document.createElement('div');
            plate.className = 'tbl-own-discard-plate';
            setRect(plate, { x, y: faceTop + row.iconH, w: row.iconW, h: row.valuePx + 2 });
            const value = document.createElement('span');
            value.textContent = String(discard.value);
            value.style.fontSize = px(row.valuePx);
            plate.appendChild(value);
            el.appendChild(plate);

            // Hint-only: a discard is history, so there is nothing left to tap.
            const hit = document.createElement('div');
            hit.className = 'tbl-own-discard-hit';
            setRect(hit, { x, y: faceTop, w: row.iconW, h: row.iconH });
            attachCardGesture(hit, discard.cardId);
            el.appendChild(hit);
        });

        if (own.discards.length > 0) {
            const total = document.createElement('span');
            total.className = 'tbl-own-total';
            total.textContent = `= ${own.discardTotal}`;
            total.style.fontSize = px(row.valuePx);
            el.appendChild(total);
        }

        return el;
    }

    // -------------------------------------------------------------- hand

    function handAccessibleName(card: HandCardPlan): string {
        const copy = cardCopyFor(card.cardId);
        const playable = card.playable ? ', playable' : '';
        const why = card.caption === null ? '' : `, ${card.caption}`;
        return `${copy.value} · ${copy.displayName}${playable}${why}`;
    }

    function buildHandCard(card: HandCardPlan): HTMLElement {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.role = 'hand-card';
        setRect(button, card.rect);
        button.setAttribute('aria-label', handAccessibleName(card));

        /**
         * `aria-disabled`, never the `disabled` property. `Court.ts` gives
         * every hand card a hit target regardless of `playable` on purpose —
         * "reading what a card does is wanted even off-turn, and most wanted
         * exactly when it cannot be played" — and a native `disabled` button
         * cannot be focused, clicked, or activated by keyboard at all, which
         * would silently take that reading path away from the one situation it
         * matters most. `aria-disabled` states the same fact to assistive
         * technology without removing the affordance.
         */
        let describedBy: string | null = null;
        if (card.dimmed && card.caption !== null) {
            button.setAttribute('aria-disabled', 'true');
            describedBy = `hand-card-caption-${card.cardInstanceId}`;
        }

        const portrait = document.createElement('img');
        portrait.className = 'tbl-art tbl-hand-portrait';
        portrait.src = assetUrl(portraitPath(card.cardId));
        portrait.alt = '';
        portrait.loading = 'lazy';
        portrait.decoding = 'async';
        portrait.style.opacity = card.dimmed ? '0.4' : '1';
        button.appendChild(portrait);

        const label = buildCardFaceLabel(card.cardId, card.rect, card.caption);
        if (label.overlineWrap !== null) {
            if (describedBy !== null) {
                label.overlineWrap.id = describedBy;
                label.overlineWrap.setAttribute('role', 'note');
            }
            button.appendChild(label.overlineWrap);
        }
        label.partsWrap.style.opacity = card.dimmed ? '0.5' : '1';
        button.appendChild(label.partsWrap);

        if (describedBy !== null) button.setAttribute('aria-describedby', describedBy);

        if (card.playable) button.classList.add('is-playable');

        attachCardGesture(button, card.cardId, () => deps.onCardSelected(card.cardInstanceId));

        return button;
    }

    // ------------------------------------------------------------- drawing

    function draw(plan: RenderPlan, layout: LayoutSpec): void {
        pendingFits = [];
        planLayer.replaceChildren();

        for (const seat of plan.seats) {
            planLayer.appendChild(buildSeatChip(seat, layout.pip, layout.chip, plan.tokensToWin));
        }

        planLayer.appendChild(buildDeck(plan.deck));
        planLayer.appendChild(buildBanner(plan.banner));

        if (plan.removedCard !== null) planLayer.appendChild(buildRemovedCard(plan.removedCard));

        planLayer.appendChild(buildOwnStatus(plan.own, layout));

        for (const card of plan.hand) planLayer.appendChild(buildHandCard(card));

        // Everything above is attached now, so `scrollWidth` means something —
        // this is the one point a shrink-to-fit pass is allowed to measure.
        for (const finish of pendingFits) finish();
        pendingFits = [];
    }

    // ------------------------------------------------------------- surface

    return {
        mount(parent) {
            parent.appendChild(container);
        },

        update(state: ClientState) {
            const table = state.table;
            if (state.screen !== 'table' || table === null) {
                spec = null;
                planLayer.replaceChildren();
                return;
            }

            const { w, h } = deps.viewport();
            spec = computeLayout({
                w,
                h,
                opponentCount: Math.min(3, Math.max(1, table.view.players.length - 1)) as 1 | 2 | 3,
                handCount: Math.min(2, Math.max(1, table.view.own.hand.length)) as 1 | 2,
                showsRemovedCard: table.view.setAsideFaceUp !== null,
                maxDiscards: table.view.players.reduce((worst, p) => Math.max(worst, p.discardPile.length), 0)
            });

            draw(
                buildRenderPlan(
                    {
                        view: table.view,
                        nicknames: table.nicknames,
                        phase: table.phase,
                        paused: table.paused,
                        missingSeats: table.missingSeats
                    },
                    spec
                ),
                spec
            );
        },

        currentLayout() {
            return spec;
        },

        destroy() {
            container.remove();
        }
    };
}
