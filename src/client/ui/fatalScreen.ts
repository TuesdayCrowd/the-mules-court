/**
 * The wall (UIX §5).
 *
 * Shown when the store has recorded a `fatal` code: the socket is closed and
 * there is nothing to do but choose a way out. `alertdialog` rather than
 * `dialog` because it interrupts and demands that choice; every code carries an
 * action, so this can never render without one.
 *
 * Note what is *not* here: `FATAL BAD_TOKEN` never reaches this screen. UIX §5
 * makes a bad token a retry, so the store drops it and returns to `joining`.
 */

import { failureCopy, type FailureAction } from '../content/failureCopy';
import type { ClientState } from '../store/types';
import type { Surface } from './surface';

export interface FatalScreenDeps {
    readonly onAction: (kind: FailureAction['kind']) => void;
}

const TITLE_ID = 'fatal-title';

export function createFatalScreen(deps: FatalScreenDeps): Surface {
    const container = document.createElement('div');
    container.dataset.role = 'fatal';

    /** The code currently drawn, so an unrelated state push does not rebuild — or re-focus. */
    let drawn: ClientState['fatal'] = null;

    function clear(): void {
        drawn = null;
        container.replaceChildren();
    }

    function render(code: NonNullable<ClientState['fatal']>): void {
        const copy = failureCopy(code);

        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'alertdialog');
        dialog.setAttribute('aria-labelledby', TITLE_ID);
        // Focusable by script but not a tab stop: the dialog itself is where
        // focus lands, and the button after it is what a Tab should reach.
        dialog.tabIndex = -1;
        dialog.className = 'fatal-dialog';

        const title = document.createElement('h1');
        title.id = TITLE_ID;
        title.textContent = copy.message;

        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.action = 'fatal-action';
        button.textContent = copy.action.label;
        button.addEventListener('click', () => deps.onAction(copy.action.kind));

        dialog.append(title, button);
        container.replaceChildren(dialog);

        // Once, on the transition into this code. Re-focusing on every state
        // push would drag a screen reader back to the top mid-sentence.
        dialog.focus();
        drawn = code;
    }

    return {
        mount(parent) {
            parent.appendChild(container);
        },

        update(state: ClientState) {
            if (state.screen !== 'fatal' || state.fatal === null) {
                if (drawn !== null) clear();
                return;
            }
            if (state.fatal === drawn) return;
            render(state.fatal);
        },

        destroy() {
            container.remove();
        }
    };
}
