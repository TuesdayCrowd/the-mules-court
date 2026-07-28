/**
 * A card's ability, floating beside the pointer.
 *
 * **An enhancement, never a dependency.** UIX §349 — *"Never depend on hover.
 * Touch is a first-class input."* — still holds: every sentence this shows is
 * already reachable by tapping the card (the action sheet) or by opening the
 * dock's reference tab. This is a faster path to copy that exists elsewhere, for
 * a player who has a pointer, and a long-press for a player who does not.
 *
 * **It lives in the DOM, not on the canvas, and that is load-bearing.**
 * `Court.draw` calls `this.table.removeAll(true)` on every `STATE_UPDATE`, so
 * anything holding hover state on a Phaser object has that object destroyed
 * under it the moment an opponent plays a card. The scene emits enter and leave;
 * this owns how long a hint lives.
 *
 * `pointer-events: none` throughout: a tooltip that could be hovered would sit
 * between the pointer and the card that summoned it, and flicker.
 */

import { cardCopyFor, cardLabel } from '../content/cardCopy';
import type { CardTypeId } from '../../game/engine';
import type { Surface } from './surface';

export interface CardHint extends Surface {
    /** Show the hint for a card, near a viewport point. */
    show(cardId: CardTypeId, at: { readonly x: number; readonly y: number }): void;
    hide(): void;
}

/** Kept clear of the pointer itself, so the hint never sits under a fingertip. */
const OFFSET_X = 14;
const OFFSET_Y = 18;

export interface CardHintDeps {
    /** Live viewport, injected so clamping is testable without a real window. */
    readonly viewport: () => { readonly w: number; readonly h: number };
}

export function createCardHint(deps: CardHintDeps): CardHint {
    const container = document.createElement('div');
    container.dataset.role = 'card-hint-host';

    const hint = document.createElement('div');
    hint.dataset.role = 'card-hint';
    hint.className = 'card-hint';
    /**
     * Hidden from assistive technology on purpose.
     *
     * It carries nothing new — the accessibility twin already names every card,
     * and the action sheet reads the same effect sentence aloud when opened. A
     * live region that echoed a card on every pointer movement would interrupt a
     * screen-reader user constantly, to tell them something they had already
     * been told.
     */
    hint.setAttribute('aria-hidden', 'true');

    let showing: CardTypeId | null = null;

    function hide(): void {
        if (showing === null) return;
        showing = null;
        hint.remove();
    }

    return {
        mount(parent) {
            parent.appendChild(container);
        },

        update(state) {
            // Anything but the table takes the hint with it. A hint outliving
            // the card it describes is a sentence about nothing.
            if (state.screen !== 'table') hide();
        },

        show(cardId, at) {
            if (showing !== cardId) {
                const copy = cardCopyFor(cardId);

                const title = document.createElement('strong');
                title.textContent = cardLabel(cardId);

                const effect = document.createElement('span');
                effect.textContent = copy.effect;

                hint.replaceChildren(title, effect);
                showing = cardId;
            }

            if (hint.parentElement === null) container.appendChild(hint);

            // Clamped into the viewport rather than measured: `offsetWidth` is 0
            // under jsdom and a layout read here would cost a reflow per pointer
            // move. A fixed reserve is enough, because the hint has a max-width.
            const { w, h } = deps.viewport();
            const left = Math.max(0, Math.min(at.x + OFFSET_X, w - HINT_RESERVE_W));
            const top = Math.max(0, Math.min(at.y + OFFSET_Y, h - HINT_RESERVE_H));

            hint.style.left = `${Math.round(left)}px`;
            hint.style.top = `${Math.round(top)}px`;
        },

        hide,

        destroy() {
            hide();
            container.remove();
        }
    };
}

/**
 * What the hint is assumed to occupy when clamping.
 *
 * Matches `.card-hint`'s `max-width` and a two-line height in `ui.css`. A
 * measured value would be exact and would also force a synchronous layout on
 * every pointer move; the hint only has to stay on screen, not touch the edge.
 */
const HINT_RESERVE_W = 260;
const HINT_RESERVE_H = 92;
