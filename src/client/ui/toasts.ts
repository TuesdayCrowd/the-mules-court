/**
 * The toast region (UIX §5, §6.5).
 *
 * One polite live region carries both channels: rule violations from the store's
 * notices, and narration lines pushed by the presentation queue. They share a
 * region because they share a purpose — telling the player what just happened —
 * and a screen reader should hear them in the order they occurred, which two
 * regions could not guarantee.
 *
 * **Every line is written with `textContent`.** Nicknames are the only free text
 * in the protocol and they arrive from other players, so narration is where
 * markup would get in. There is no `innerHTML` in this file, and a test asserts
 * a hostile nickname produces no element.
 */

import type { ErrorCode } from '../../server/protocol';
import type { ClientState } from '../store/types';
import type { Surface, Timers } from './surface';

/** Long enough to read a sentence, short enough not to stack up during a fast round. */
const DEFAULT_TIMEOUT_MS = 5000;

export interface ToastsDeps {
    readonly timers: Timers;
    /** Turns a protocol code into designed copy. Task 24's `failureCopy` supplies this. */
    readonly copyFor: (code: ErrorCode) => string;
    /** Called when a notice's toast times out, so the store can drop it from state. */
    readonly onDismiss: (id: string) => void;
    readonly timeoutMs?: number;
}

export interface Toasts extends Surface {
    /** Show a narration line. Not a notice: nothing in the store owns it. */
    show(text: string): void;
}

interface Live {
    readonly node: HTMLElement;
    readonly handle: unknown;
}

export function createToasts(deps: ToastsDeps): Toasts {
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const container = document.createElement('div');
    container.dataset.role = 'toasts';
    container.className = 'toasts';
    container.setAttribute('role', 'status');
    container.setAttribute('aria-live', 'polite');

    /** Keyed by notice id, or by a minted id for narration. */
    const live = new Map<string, Live>();
    let narrationSeq = 0;

    function add(id: string, text: string, onExpire: () => void): void {
        if (live.has(id)) return;

        const node = document.createElement('div');
        node.dataset.role = 'toast';
        node.className = 'toast';
        node.textContent = text; // the injection boundary — never innerHTML
        container.appendChild(node);

        const handle = deps.timers.setTimeout(() => {
            remove(id);
            onExpire();
        }, timeoutMs);

        live.set(id, { node, handle });
    }

    function remove(id: string): void {
        const entry = live.get(id);
        if (entry === undefined) return;
        deps.timers.clearTimeout(entry.handle);
        entry.node.remove();
        live.delete(id);
    }

    return {
        mount(parent) {
            parent.appendChild(container);
        },

        update(state: ClientState) {
            const wanted = new Set(state.notices.map(notice => notice.id));

            // Gone from state: the store dismissed it, or a new snapshot cleared
            // it. Either way it should leave the screen, and its timer with it.
            for (const id of [...live.keys()]) {
                if (id.startsWith('narration:')) continue;
                if (!wanted.has(id)) remove(id);
            }

            // Added by id, not rebuilt: re-rendering the region wholesale would
            // restart every live region announcement already in flight.
            for (const notice of state.notices) {
                add(notice.id, deps.copyFor(notice.code), () => deps.onDismiss(notice.id));
            }
        },

        show(text) {
            add(`narration:${narrationSeq++}`, text, () => {});
        },

        destroy() {
            for (const id of [...live.keys()]) remove(id);
            container.remove();
        }
    };
}
