/**
 * "You are out, and here is why" (UIX §9, extended).
 *
 * Its own surface rather than a fourth kind of `overlays.ts`, and the reason is
 * that file's own invariant: *"One surface holds all three because at most one is
 * ever up."* An elimination breaks that. Going out is very often what ends the
 * round, so this and the round-over overlay appear in the same state push —
 * stacked, not competing, and read in the order they happened: why you are out,
 * then what became of the round.
 *
 * **Dismissible, and it stays dismissed.** The request was to be able to close it
 * and watch the rest of the round play out, so nothing re-opens it.
 *
 * **Driven by durable state, not by a diff event.** The obvious wiring — react to
 * the `ELIMINATED` entry as it arrives — has a hole exactly where the feature is
 * needed most: `diffSnapshots` returns `[]` whenever there is no previous view
 * (`diff.ts`), which is the reconnect and first-load path. A player whose
 * connection blipped at the moment they went out would never be told why. So
 * this reads `alive` and the log from whatever state it is handed, and converges
 * on the right answer however many pushes it missed.
 *
 * At most one elimination per player per round makes that safe: `eliminate()`
 * clears the hand and sets `alive = false`, and a player who is out takes no
 * further turns. So "acknowledged" needs no key beyond the round itself, and the
 * round ending is signalled by the player being dealt back in.
 *
 * **The sentence is captured once, never recomputed.** `view.revealed` is
 * re-filtered live on every `view()` call, so the peek naming the winning card
 * disappears the moment its owner plays it — and this notice is explicitly meant
 * to stay open while the round plays on. Recomputing per render would let the
 * card the player is reading about change under them.
 */

import type { EliminationReason } from '../content/elimination';
import { eliminationReason } from '../content/elimination';
import type { PlayerId } from '../../game/engine';
import type { ClientState } from '../store/types';
import type { Surface } from './surface';

export interface EliminationNotice extends Surface {
    /**
     * Show the notice. Called once, when the elimination lands.
     *
     * `roundOver` decides what the button offers. Going out is very often what
     * *ends* the round, and telling a player to go and watch a round that is
     * already over is an instruction they cannot follow — reported after exactly
     * that: "the button asked them to continue watching the round, but the round
     * had actually ended with them going out."
     */
    show(reason: EliminationReason, roundOver?: boolean): void;
    close(): void;
    /** What is on screen, for the caller and for tests. */
    showing(): EliminationReason | null;
}

const TITLE_ID = 'elimination-title';

export function createEliminationNotice(): EliminationNotice {
    const container = document.createElement('div');
    container.dataset.role = 'elimination-notice-host';

    let reason: EliminationReason | null = null;
    let returnFocusTo: HTMLElement | null = null;
    /** True once this round's notice has been shown, whether or not it is still up. */
    let handled = false;

    function close(): void {
        if (reason === null) return;
        reason = null;
        container.replaceChildren();

        // Back where they were, so dismissing does not strand a keyboard player
        // at the document root with a table they cannot reach.
        returnFocusTo?.focus();
        returnFocusTo = null;
    }

    return {
        mount(parent) {
            parent.appendChild(container);
        },

        update(state: ClientState) {
            const table = state.table;

            if (state.screen !== 'table' || table === null) {
                close();
                return;
            }

            const seat: PlayerId | undefined = state.seat?.playerId;
            const alive = table.view.players.find(player => player.id === seat)?.alive ?? true;

            if (alive) {
                // Dealt back in: the round this explained is gone, and the next
                // elimination deserves its own notice.
                handled = false;
                close();
                return;
            }

            if (handled) return;

            const nameOf = (playerId: PlayerId): string => table.nicknames[playerId] ?? playerId;
            const next = eliminationReason(table.view, nameOf);
            if (next === null) return;

            // Whether there is any round left to watch. `roundResult` is set the
            // moment the round is decided, and going out is very often what
            // decided it.
            const roundOver = table.view.roundResult !== null || table.phase !== 'active';

            handled = true;
            this.show(next, roundOver);
        },

        show(next, roundOver = false) {
            if (reason !== null) return;
            handled = true;
            reason = next;

            const active = document.activeElement;
            returnFocusTo = active instanceof HTMLElement && active !== document.body ? active : null;

            const dialog = document.createElement('div');
            dialog.dataset.role = 'elimination-notice';
            dialog.className = 'elimination-notice';
            dialog.setAttribute('role', 'alertdialog');
            dialog.setAttribute('aria-labelledby', TITLE_ID);
            dialog.tabIndex = -1;

            const title = document.createElement('h2');
            title.id = TITLE_ID;
            title.textContent = next.headline;

            const detail = document.createElement('p');
            detail.dataset.role = 'elimination-detail';
            detail.textContent = next.detail; // textContent: carries nicknames

            const dismiss = document.createElement('button');
            dismiss.type = 'button';
            dismiss.dataset.action = 'close-elimination';
            // Named for what happens next, not for the button's own mechanics.
            // When the elimination ended the round there is nothing left to
            // watch, and saying otherwise sends the player looking for a game
            // that is already over.
            dismiss.textContent = roundOver ? 'See how the round ended' : 'Watch the rest of the round';
            dismiss.addEventListener('click', close);

            dialog.append(title, detail, dismiss);
            container.replaceChildren(dialog);
            dialog.focus();
        },

        close,

        showing() {
            return reason;
        },

        destroy() {
            container.remove();
        }
    };
}
