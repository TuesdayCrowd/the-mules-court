/**
 * The reference dock (UIX §10, extended).
 *
 * One panel holding the card reference and the match log, switched by a tab.
 * They were going to be two surfaces, and two surfaces want the same corner —
 * `ui.css`'s `#ui-root[data-sheet] .reference-tab` already arbitrates that corner
 * against the action sheet, and a second launcher would need its own copy of
 * that rule and its own answer for where it goes instead. One dock keeps the
 * collision a single rule.
 *
 * **Non-modal, and that is the whole of "stays visible while playing."** Its
 * predecessor already survived every state update; what made it read as
 * temporary was three things it did on open — declare `role="dialog"`, take
 * focus, and bind Escape at the document. A panel that does those interrupts the
 * game. This one is a labelled `region`, leaves focus alone, and listens for
 * Escape on itself, so a player cancelling an action sheet does not lose their
 * reference as a side effect.
 *
 * Open state and active tab persist, so the dock a player left up is up again
 * next time. `KeyValueStore` is injected rather than reached for, which is what
 * lets the Safari private-mode write failure be a test rather than a surprise.
 */

import { matchLogSections, matchLogIsEmpty, EMPTY_MATCH_LOG } from '../content/matchLog';
import { QUICK_REFERENCE } from '../content/quickReference';
import type { PlayerId } from '../../game/engine';
import type { KeyValueStore } from '../store/seatTokenStore';
import type { ClientState, TableSnapshot } from '../store/types';
import type { Surface } from './surface';

export type DockTab = 'reference' | 'log';

export interface ReferenceDock extends Surface {
    /**
     * Opens the dock on a given tab, optionally at one round of the log.
     *
     * `round` is the devotion-token route: a token IS a round won, and that
     * round's narration is otherwise unreachable once the next round is dealt.
     */
    open(tab: DockTab, options?: { readonly round?: number }): void;
}

export interface ReferenceDockDeps {
    readonly storage: KeyValueStore;
}

const TITLE_ID = 'reference-dock-title';
const OPEN_KEY = 'mules-court:dock:open';
const TAB_KEY = 'mules-court:dock:tab';

const TABS: ReadonlyArray<readonly [DockTab, string]> = [
    ['reference', 'Card reference'],
    ['log', 'Match log']
];

function isTab(value: string | null): value is DockTab {
    return value === 'reference' || value === 'log';
}

export function createReferenceDock(deps: ReferenceDockDeps): ReferenceDock {
    const container = document.createElement('div');
    container.dataset.role = 'reference-dock-host';

    /**
     * Writes are best-effort.
     *
     * Safari in private mode throws from `setItem`, and losing a remembered
     * panel position is not worth taking the table down for. Reads cannot throw
     * the same way, but are guarded alike rather than relying on that.
     */
    function remember(key: string, value: string): void {
        try {
            deps.storage.setItem(key, value);
        } catch {
            /* a forgotten preference is not a failure worth surfacing */
        }
    }

    function recall(key: string): string | null {
        try {
            return deps.storage.getItem(key);
        } catch {
            return null;
        }
    }

    const storedTab = recall(TAB_KEY);
    let tab: DockTab = isTab(storedTab) ? storedTab : 'reference';
    let open = recall(OPEN_KEY) === '1';
    /** A round to bring into view on the next render, then forgotten. */
    let focusRound: number | null = null;
    let table: TableSnapshot | null = null;
    let onTable = false;

    const launcher = document.createElement('button');
    launcher.type = 'button';
    launcher.dataset.action = 'reference-dock';
    launcher.className = 'reference-tab';
    launcher.textContent = 'Reference';
    launcher.setAttribute('aria-expanded', 'false');

    const panel = document.createElement('section');
    panel.dataset.role = 'reference-dock';
    panel.className = 'reference-modal';
    // A region, not a dialog. It sits beside the game rather than in front of
    // it, and a screen reader that announced it as a dialog would tell the
    // player their turn had been interrupted.
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-labelledby', TITLE_ID);

    // Bound to the panel rather than the document: a non-modal panel that
    // swallowed every Escape would close itself while the player was cancelling
    // an action sheet somewhere else entirely.
    panel.addEventListener('keydown', event => {
        if ((event as KeyboardEvent).key === 'Escape') setOpen(false);
    });

    function nameOf(playerId: PlayerId): string {
        return table?.nicknames[playerId] ?? playerId;
    }

    function referenceTable(): HTMLElement {
        const element = document.createElement('table');
        const head = document.createElement('thead');
        const headRow = document.createElement('tr');
        for (const heading of ['Value', 'In deck', 'Characters', 'Ability']) {
            const cell = document.createElement('th');
            cell.scope = 'col';
            cell.textContent = heading;
            headRow.appendChild(cell);
        }
        head.appendChild(headRow);

        const body = document.createElement('tbody');
        for (const reference of QUICK_REFERENCE) {
            const row = document.createElement('tr');
            row.dataset.role = 'reference-row';
            row.dataset.value = String(reference.value);

            const value = document.createElement('th');
            value.scope = 'row';
            value.textContent = String(reference.value);

            const count = document.createElement('td');
            count.textContent = `×${reference.count}`;

            const names = document.createElement('td');
            names.textContent = reference.cards.map(card => card.displayName).join(', ');

            const ability = document.createElement('td');
            ability.textContent = reference.effect;

            row.append(value, count, names, ability);
            body.appendChild(row);
        }

        element.append(head, body);
        return element;
    }

    function logPanel(): HTMLElement {
        const wrapper = document.createElement('div');

        if (table === null || matchLogIsEmpty(table.view)) {
            const empty = document.createElement('p');
            empty.textContent = EMPTY_MATCH_LOG;
            wrapper.appendChild(empty);
            return wrapper;
        }

        // Sections rather than one stream: `matchLog.ts` explains why, and the
        // seat dossier renders the identical list from the identical source.
        for (const section of matchLogSections(table.view, nameOf)) {
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
                item.textContent = line; // textContent: another player's free text
                list.appendChild(item);
            }

            if (section.roundNumber === focusRound) block.dataset.focus = 'true';

            block.appendChild(list);
            wrapper.appendChild(block);
        }

        return wrapper;
    }

    function render(): void {
        if (!open) {
            panel.remove();
            launcher.setAttribute('aria-expanded', 'false');
            return;
        }

        const title = document.createElement('h2');
        title.id = TITLE_ID;
        title.textContent = tab === 'reference' ? 'Every card, by value' : 'Match log';

        const tablist = document.createElement('div');
        tablist.setAttribute('role', 'tablist');
        for (const [key, label] of TABS) {
            const button = document.createElement('button');
            button.type = 'button';
            button.setAttribute('role', 'tab');
            button.setAttribute('aria-selected', String(tab === key));
            button.dataset.dockTab = key;
            button.textContent = label;
            button.addEventListener('click', () => {
                tab = key;
                remember(TAB_KEY, key);
                render();
            });
            tablist.appendChild(button);
        }

        const body = document.createElement('div');
        body.dataset.role = 'dock-body';
        body.setAttribute('role', 'tabpanel');
        body.appendChild(tab === 'reference' ? referenceTable() : logPanel());

        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.dataset.action = 'close-dock';
        dismiss.textContent = 'Close';
        dismiss.addEventListener('click', () => setOpen(false));

        /**
         * Title and Close on one row, above the scroll.
         *
         * The match log has no upper bound — it is every round the match has
         * played — and with the whole panel scrolling and Close appended last,
         * dismissing the dock meant scrolling past the entire history to reach
         * the button. The header and the tabs stay put; only `body` scrolls.
         */
        const header = document.createElement('div');
        header.className = 'dock-header';
        header.append(title, dismiss);

        panel.replaceChildren(header, tablist, body);
        if (panel.parentElement === null) container.appendChild(panel);
        launcher.setAttribute('aria-expanded', 'true');

        if (focusRound !== null) {
            const target = panel.querySelector<HTMLElement>('[data-focus="true"]');
            // Guarded: jsdom has no layout and does not implement this, and a
            // missing scroll is not worth taking the panel down for.
            if (target !== null && typeof target.scrollIntoView === 'function') {
                target.scrollIntoView({ block: 'start' });
            }
            // One render only. Left set, every later push would drag the panel
            // back to an old round while the player was reading a newer one.
            focusRound = null;
        }
    }

    function setOpen(next: boolean): void {
        open = next;
        remember(OPEN_KEY, next ? '1' : '0');
        render();
        // Focus is deliberately left alone. Taking it on open is what made the
        // panel feel like a modal interruption; returning it on close would
        // yank the player out of whatever they moved on to.
    }

    launcher.addEventListener('click', () => setOpen(!open));

    return {
        mount(parent) {
            parent.appendChild(container);
        },

        update(state: ClientState) {
            table = state.table;
            const wanted = state.screen === 'table';

            if (wanted !== onTable) {
                onTable = wanted;
                if (wanted) {
                    container.appendChild(launcher);
                } else {
                    // Leaving the table takes the dock with it, without
                    // forgetting that it was up — a reference floating over the
                    // lobby is chrome for a screen that is gone, but the player
                    // still wants it back on the next table.
                    panel.remove();
                    launcher.remove();
                    launcher.setAttribute('aria-expanded', 'false');
                    return;
                }
            }

            if (!wanted) return;
            // Redrawn on every push, so the log tab takes new lines live.
            render();
        },

        open(next, options) {
            tab = next;
            focusRound = options?.round ?? null;
            remember(TAB_KEY, next);
            setOpen(true);
        },

        destroy() {
            panel.remove();
            container.remove();
        }
    };
}
