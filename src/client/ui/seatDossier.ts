/**
 * The seat dossier (UIX §6.2).
 *
 * Supplementary detail, never required to see a value — the pips on the chip
 * already carry every discard, and this is where the same data gets names, a
 * running total, and the match log beside it.
 *
 * **It renders `discardPile` and nothing else.** Interface rule 4 forbids showing
 * another player's hand, and the way to guarantee that is to give a held card no
 * path onto the panel rather than to filter one out: `view.own.hand` and
 * `view.revealed` are never read here.
 */

import type { PlayerId, RedactedView } from '../../game/engine';
import { cardCopyFor } from '../content/cardCopy';
import { EMPTY_MATCH_LOG, matchLogIsEmpty, matchLogSections } from '../content/matchLog';
import type { ClientState, TableSnapshot } from '../store/types';
import type { Surface } from './surface';

export interface SeatDossier extends Surface {
    open(playerId: PlayerId): void;
    close(): void;
}

const TITLE_ID = 'seat-dossier-title';

type SeatView = RedactedView['players'][number];

function statusOf(seat: SeatView): string {
    if (!seat.alive) return 'Out of the round';
    return seat.protected ? 'Protected — cannot be targeted' : 'In the round';
}

export function createSeatDossier(): SeatDossier {
    const container = document.createElement('div');
    container.dataset.role = 'seat-dossier-host';

    let table: TableSnapshot | null = null;
    let openFor: PlayerId | null = null;
    let tab: 'seat' | 'log' = 'seat';

    function close(): void {
        openFor = null;
        tab = 'seat';
        container.replaceChildren();
    }

    function nameOf(playerId: PlayerId): string {
        return table?.nicknames[playerId] ?? playerId;
    }

    function seatPanel(seat: SeatView): HTMLElement {
        const panel = document.createElement('div');
        panel.setAttribute('role', 'tabpanel');

        const summary = document.createElement('p');
        summary.textContent = `${statusOf(seat)} · ${seat.tokens} devotion tokens · discards total ${seat.discardValueTotal}`;
        panel.appendChild(summary);

        if (seat.discardPile.length === 0) {
            const empty = document.createElement('p');
            empty.textContent = 'Nothing discarded yet.';
            panel.appendChild(empty);
            return panel;
        }

        // Play order, oldest first — the order the engine keeps them in, and the
        // order the deduction actually happened in.
        const list = document.createElement('ol');
        for (const entry of seat.discardPile) {
            const item = document.createElement('li');
            item.dataset.role = 'discard-entry';
            item.textContent = `${entry.value} · ${cardCopyFor(entry.cardId).displayName}`;
            list.appendChild(item);
        }
        panel.appendChild(list);
        return panel;
    }

    function logPanel(view: RedactedView): HTMLElement {
        const panel = document.createElement('div');
        panel.setAttribute('role', 'tabpanel');

        if (matchLogIsEmpty(view)) {
            const empty = document.createElement('p');
            empty.textContent = EMPTY_MATCH_LOG;
            panel.appendChild(empty);
            return panel;
        }

        /**
         * The same sections the dock's log tab renders, from the same source.
         *
         * Two surfaces showing the match log is two chances to disagree about
         * what happened; `content/matchLog.ts` is the single answer, so the only
         * difference between them is where they sit.
         *
         * Newest last within each round, so the list reads in the order events
         * occurred and a new line appears where the eye already is.
         */
        for (const section of matchLogSections(view, nameOf)) {
            const block = document.createElement('section');
            block.dataset.role = 'log-section';
            block.dataset.round = String(section.roundNumber);

            const heading = document.createElement('h3');
            heading.textContent = section.heading; // textContent: carries nicknames
            block.appendChild(heading);

            const list = document.createElement('ol');
            for (const line of section.lines) {
                const item = document.createElement('li');
                item.dataset.role = 'log-line';
                item.textContent = line;
                list.appendChild(item);
            }

            block.appendChild(list);
            panel.appendChild(block);
        }

        return panel;
    }

    function render(): void {
        if (table === null || openFor === null) {
            container.replaceChildren();
            return;
        }

        const seat = table.view.players.find(entry => entry.id === openFor);
        if (seat === undefined) {
            container.replaceChildren();
            return;
        }

        const dialog = document.createElement('div');
        dialog.dataset.role = 'seat-dossier';
        dialog.className = 'seat-dossier';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-labelledby', TITLE_ID);
        dialog.tabIndex = -1;

        const title = document.createElement('h2');
        title.id = TITLE_ID;
        title.textContent = nameOf(seat.id); // textContent: another player's free text

        const tablist = document.createElement('div');
        tablist.setAttribute('role', 'tablist');
        for (const [key, label] of [
            ['seat', 'This seat'],
            ['log', 'Match log']
        ] as const) {
            const button = document.createElement('button');
            button.type = 'button';
            button.setAttribute('role', 'tab');
            button.setAttribute('aria-selected', String(tab === key));
            button.textContent = label;
            button.addEventListener('click', () => {
                tab = key;
                render();
            });
            tablist.appendChild(button);
        }

        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.dataset.action = 'close-dossier';
        dismiss.textContent = 'Close';
        dismiss.addEventListener('click', close);

        dialog.append(title, tablist, tab === 'seat' ? seatPanel(seat) : logPanel(table.view), dismiss);
        container.replaceChildren(dialog);
    }

    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape' && openFor !== null) close();
    };
    document.addEventListener('keydown', onKeyDown);

    return {
        mount(parent) {
            parent.appendChild(container);
        },

        update(state: ClientState) {
            table = state.table;
            if (state.screen !== 'table' || table === null) {
                close();
                return;
            }
            // Re-rendered on every snapshot: an open dossier must follow the
            // pile it is describing rather than freeze at the moment it opened.
            if (openFor !== null) render();
        },

        open(playerId) {
            openFor = playerId;
            tab = 'seat';
            render();
        },

        close,

        destroy() {
            document.removeEventListener('keydown', onKeyDown);
            container.remove();
        }
    };
}
