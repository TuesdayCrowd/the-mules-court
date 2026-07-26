/**
 * The connection dot (UIX §5).
 *
 * Lives in a screen corner on every surface, including the fatal screen — a
 * player staring at a wall still benefits from knowing whether the socket came
 * back. Colour is the styling layer's job; this owns the accessible name and the
 * `data-status` hook, so nothing has to parse a label to draw a dot.
 */

import type { ClientState, ConnectionStatus } from '../store/types';
import type { Surface } from './surface';

/**
 * Announced, not merely rendered.
 *
 * `role="status"` makes each transition a polite announcement. Losing the
 * connection is exactly the kind of thing a player must not have to notice
 * visually, and the status changes only on real transitions, so it stays quiet
 * through a normal session.
 */
const LABELS: Readonly<Record<ConnectionStatus, string>> = {
    connecting: 'Connecting',
    open: 'Connected',
    reconnecting: 'Reconnecting',
    closed: 'Disconnected'
};

export function createConnectionDot(): Surface {
    const element = document.createElement('div');
    element.dataset.role = 'connection';
    element.setAttribute('role', 'status');
    element.className = 'connection-dot';
    apply(element, 'connecting');

    return {
        mount(parent) {
            parent.appendChild(element);
        },

        update(state: ClientState) {
            apply(element, state.connection);
        },

        destroy() {
            element.remove();
        }
    };
}

function apply(element: HTMLElement, status: ConnectionStatus): void {
    element.dataset.status = status;
    // The name carries the whole meaning; the element holds no text, so it never
    // reads as a stray word sitting beside the dot it describes.
    element.setAttribute('aria-label', LABELS[status]);
}
