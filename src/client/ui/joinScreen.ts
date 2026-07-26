/**
 * Taking a seat (UIX §3).
 *
 * Validates in the field so `MALFORMED` never round-trips: an invalid nickname
 * fails the whole `CLAIM_SEAT` frame, so a name the server refuses would cost
 * the seat rather than earn a correction.
 *
 * A browser that already holds a seat is not asked to name itself. That is the
 * host's path after the D2 decision — they name themselves on the menu, and the
 * token and the name both arrive here through storage — and it is also where a
 * reconnecting player lands, who has no question left to answer either.
 */

import { nicknameProblemMessage, validateNickname, MAX_NICKNAME_LENGTH } from '../content/nickname';
import type { ClientState } from '../store/types';
import type { Surface } from './surface';

export interface JoinScreenDeps {
    /** Receives the trimmed, validated nickname. Wired to `store.claimSeat`. */
    readonly onSubmit: (nickname: string) => void;
}

const FIELD_ID = 'join-nickname';
const ERROR_ID = 'join-nickname-error';

export function createJoinScreen(deps: JoinScreenDeps): Surface {
    const container = document.createElement('div');
    container.dataset.role = 'join';
    container.className = 'screen screen-join';

    /** What the player has typed. Held here so an unrelated state push cannot wipe it. */
    let typed = '';
    /** Which view is currently built, so `update` rebuilds only on a real change. */
    let showing: 'none' | 'form' | 'resuming' = 'none';

    const form = document.createElement('form');
    form.noValidate = true;

    const label = document.createElement('label');
    label.htmlFor = FIELD_ID;
    label.textContent = 'Your name at this court';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = FIELD_ID;
    // Set as an attribute: `autocomplete` is typed as TypeScript's `AutoFill`
    // union, which does not admit the spec's `nickname` token.
    input.setAttribute('autocomplete', 'nickname');
    // The browser's own cap, in agreement with the server's. Belt and braces:
    // it stops the over-length case arising rather than only reporting it.
    input.maxLength = MAX_NICKNAME_LENGTH;

    const error = document.createElement('p');
    error.id = ERROR_ID;
    error.dataset.role = 'nickname-error';
    error.className = 'field-error';

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = 'Take a seat';

    form.append(label, input, error, submit);

    function refresh(): void {
        const result = validateNickname(typed);
        submit.disabled = !result.ok;

        // An empty field has done nothing wrong yet. Scolding a player for not
        // having typed is how a form reads as hostile before it reads as helpful.
        const complaint = !result.ok && typed.trim().length > 0 ? nicknameProblemMessage(result.problem) : null;

        if (complaint === null) {
            error.remove();
            input.removeAttribute('aria-describedby');
            input.setAttribute('aria-invalid', 'false');
            return;
        }

        error.textContent = complaint;
        if (error.parentElement === null) input.after(error);
        input.setAttribute('aria-describedby', ERROR_ID);
        input.setAttribute('aria-invalid', 'true');
    }

    input.addEventListener('input', () => {
        typed = input.value;
        refresh();
    });

    form.addEventListener('submit', event => {
        // Always, before anything else: a form that reloads the page loses the
        // seat token it was about to claim against.
        event.preventDefault();

        const result = validateNickname(typed);
        if (!result.ok) return; // Enter reaches here even with the button disabled
        deps.onSubmit(result.value);
    });

    function showForm(): void {
        if (showing === 'form') return;
        showing = 'form';
        container.replaceChildren(form);
        input.value = typed;
        refresh();
        input.focus();
    }

    function showResuming(): void {
        if (showing === 'resuming') return;
        showing = 'resuming';
        const message = document.createElement('p');
        message.textContent = 'Taking your seat…';
        container.replaceChildren(message);
    }

    function hide(): void {
        if (showing === 'none') return;
        showing = 'none';
        container.replaceChildren();
    }

    return {
        mount(parent) {
            parent.appendChild(container);
        },

        update(state: ClientState) {
            if (state.screen !== 'joining') {
                hide();
                return;
            }
            if (state.seat !== null) {
                showResuming();
                return;
            }
            showForm();
        },

        destroy() {
            container.remove();
        }
    };
}
