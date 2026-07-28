/**
 * The quick reference (UIX §10).
 *
 * A floating tab that is up whenever the table is, including other players'
 * turns — deduction depends on knowing what is still out there, and gating this
 * on holding the turn would withhold it exactly when someone is thinking.
 *
 * Value-ordered 8 → 1 with the count per value front and centre, because the
 * Informant guesses a value and never a character. Characters sharing a value
 * share a row: value 5 is both Darells, and knowing that is the whole game.
 */

import { QUICK_REFERENCE } from '../content/quickReference';
import type { ClientState } from '../store/types';
import type { Surface } from './surface';

const TITLE_ID = 'quick-reference-title';

export function createQuickReference(): Surface {
    const container = document.createElement('div');
    container.dataset.role = 'quick-reference';

    const tab = document.createElement('button');
    tab.type = 'button';
    tab.dataset.action = 'quick-reference';
    tab.className = 'reference-tab';
    tab.textContent = 'Card reference';
    tab.setAttribute('aria-expanded', 'false');

    let modal: HTMLElement | null = null;
    let onTable = false;

    function close(returnFocus: boolean): void {
        if (modal === null) return;
        modal.remove();
        modal = null;
        tab.setAttribute('aria-expanded', 'false');
        // Focus goes back where it came from; leaving it on a removed node
        // drops a keyboard player at the document root.
        if (returnFocus) tab.focus();
    }

    function rowFor(reference: (typeof QUICK_REFERENCE)[number]): HTMLElement {
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

        // What the value does, beside who holds it. A panel that answers "what
        // is still out there" and not "what does it do" sends the player away
        // to find the other half.
        const ability = document.createElement('td');
        ability.textContent = reference.effect;

        row.append(value, count, names, ability);
        return row;
    }

    function open(): void {
        if (modal !== null) return;

        const dialog = document.createElement('div');
        dialog.dataset.role = 'quick-reference-modal';
        dialog.className = 'reference-modal';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-labelledby', TITLE_ID);
        dialog.tabIndex = -1;

        const title = document.createElement('h2');
        title.id = TITLE_ID;
        title.textContent = 'Every card, by value';

        const table = document.createElement('table');
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
        body.append(...QUICK_REFERENCE.map(rowFor));
        table.append(head, body);

        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.dataset.action = 'close-reference';
        dismiss.textContent = 'Close';
        dismiss.addEventListener('click', () => close(true));

        dialog.append(title, table, dismiss);
        container.appendChild(dialog);
        modal = dialog;
        tab.setAttribute('aria-expanded', 'true');
        dialog.focus();
    }

    tab.addEventListener('click', () => (modal === null ? open() : close(true)));

    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') close(true);
    };
    document.addEventListener('keydown', onKeyDown);

    return {
        mount(parent) {
            parent.appendChild(container);
        },

        update(state: ClientState) {
            const wanted = state.screen === 'table';
            if (wanted === onTable) return;
            onTable = wanted;

            if (wanted) {
                container.appendChild(tab);
                return;
            }
            // Leaving the table takes the panel with it; a reference floating
            // over the lobby is chrome for a screen that is gone.
            close(false);
            tab.remove();
        },

        destroy() {
            document.removeEventListener('keydown', onKeyDown);
            close(false);
            container.remove();
        }
    };
}
