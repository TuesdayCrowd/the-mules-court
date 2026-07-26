// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ErrorCode } from '../../server/protocol';
import { fakeTimers, makeState, makeUiRootElement } from './__fixtures__/dom';
import { createToasts } from './toasts';

function mounted(overrides: { copyFor?: (code: ErrorCode) => string } = {}) {
    const root = makeUiRootElement();
    const clock = fakeTimers();
    const dismissed: string[] = [];

    const toasts = createToasts({
        timers: clock.timers,
        copyFor: overrides.copyFor ?? (code => `Rule: ${code}`),
        onDismiss: id => dismissed.push(id)
    });
    toasts.mount(root);

    return {
        root,
        toasts,
        clock,
        dismissed,
        container: () => root.querySelector('[data-role="toasts"]') as HTMLElement,
        lines: () => [...root.querySelectorAll('[data-role="toast"]')].map(node => node.textContent)
    };
}

describe('the toast region', () => {
    it('is a polite live region, so a toast never interrupts the player mid-thought', () => {
        const { container } = mounted();
        expect(container().getAttribute('aria-live')).toBe('polite');
        expect(container().getAttribute('role')).toBe('status');
    });

    it('starts empty', () => {
        expect(mounted().lines()).toEqual([]);
    });
});

describe('toasts from store notices', () => {
    it('renders one line per notice, through the injected copy', () => {
        const { toasts, lines } = mounted();
        toasts.update(makeState({ notices: [{ id: 'n1', code: 'NOT_YOUR_TURN' }] }));
        expect(lines()).toEqual(['Rule: NOT_YOUR_TURN']);
    });

    it('adds a newly arrived notice without disturbing the ones already up', () => {
        const { toasts, lines } = mounted();
        toasts.update(makeState({ notices: [{ id: 'n1', code: 'NOT_YOUR_TURN' }] }));
        const first = document.querySelector('[data-role="toast"]');

        toasts.update(
            makeState({
                notices: [
                    { id: 'n1', code: 'NOT_YOUR_TURN' },
                    { id: 'n2', code: 'RATE_LIMITED' }
                ]
            })
        );

        expect(lines()).toEqual(['Rule: NOT_YOUR_TURN', 'Rule: RATE_LIMITED']);
        expect(document.querySelector('[data-role="toast"]')).toBe(first); // the same node, not a rebuild
    });

    it('drops a notice the store has cleared', () => {
        const { toasts, lines } = mounted();
        toasts.update(makeState({ notices: [{ id: 'n1', code: 'NOT_YOUR_TURN' }] }));
        toasts.update(makeState({ notices: [] }));
        expect(lines()).toEqual([]);
    });

    it('tells the store when a toast times out, so the notice does not linger in state', () => {
        const { toasts, clock, dismissed } = mounted();
        toasts.update(makeState({ notices: [{ id: 'n1', code: 'NOT_YOUR_TURN' }] }));

        clock.run();

        expect(dismissed).toEqual(['n1']);
    });

    it('times out each notice on its own clock, leaving the others up', () => {
        const { toasts, clock, dismissed } = mounted();
        toasts.update(makeState({ notices: [{ id: 'n1', code: 'NOT_YOUR_TURN' }] }));
        const firstHandleCount = clock.pendingCount();

        toasts.update(
            makeState({
                notices: [
                    { id: 'n1', code: 'NOT_YOUR_TURN' },
                    { id: 'n2', code: 'RATE_LIMITED' }
                ]
            })
        );

        expect(firstHandleCount).toBe(1);
        expect(clock.pendingCount()).toBe(2); // one timer each, not one shared
        clock.run();
        expect(dismissed.sort()).toEqual(['n1', 'n2']);
    });

    it('cancels a pending timer when the notice is removed first', () => {
        const { toasts, clock } = mounted();
        toasts.update(makeState({ notices: [{ id: 'n1', code: 'NOT_YOUR_TURN' }] }));
        toasts.update(makeState({ notices: [] }));
        expect(clock.pendingCount()).toBe(0);
    });
});

describe('narration lines', () => {
    it('shows a line pushed imperatively', () => {
        const { toasts, lines } = mounted();
        toasts.show('Ana played Mayor Indbur.');
        expect(lines()).toEqual(['Ana played Mayor Indbur.']);
    });

    it('times a narration line out on its own', () => {
        const { toasts, clock, lines } = mounted();
        toasts.show('Ana played Mayor Indbur.');
        clock.run();
        expect(lines()).toEqual([]);
    });

    it('keeps narration and notices in one region, in arrival order', () => {
        const { toasts, lines } = mounted();
        toasts.show('Ana played Mayor Indbur.');
        toasts.update(makeState({ notices: [{ id: 'n1', code: 'NOT_YOUR_TURN' }] }));
        expect(lines()).toEqual(['Ana played Mayor Indbur.', 'Rule: NOT_YOUR_TURN']);
    });
});

describe('the injection boundary', () => {
    // Nicknames are the only free text in the protocol and they arrive from
    // other players. Narration toasts carry them, so this is where markup would
    // get in if anything ever used innerHTML.
    const HOSTILE = '<img src=x onerror=alert(1)>';

    it('renders a hostile nickname as text, never as markup', () => {
        const { toasts, root, lines } = mounted();
        toasts.show(`${HOSTILE} played Mayor Indbur.`);

        expect(root.querySelector('img')).toBeNull();
        expect(lines()).toEqual([`${HOSTILE} played Mayor Indbur.`]);
    });

    it('renders hostile copy as text too', () => {
        const { toasts, root } = mounted({ copyFor: () => HOSTILE });
        toasts.update(makeState({ notices: [{ id: 'n1', code: 'INTERNAL' }] }));
        expect(root.querySelector('img')).toBeNull();
    });

    it('creates no element beyond the toast node itself', () => {
        const { toasts, root } = mounted();
        toasts.show(`${HOSTILE}`);
        const toast = root.querySelector('[data-role="toast"]') as HTMLElement;
        expect(toast.children).toHaveLength(0);
    });
});

describe('teardown', () => {
    it('cancels every pending timer on destroy', () => {
        const { toasts, clock } = mounted();
        toasts.show('one');
        toasts.show('two');
        toasts.destroy();
        expect(clock.pendingCount()).toBe(0);
    });

    it('removes its region on destroy', () => {
        const { toasts, root } = mounted();
        toasts.destroy();
        expect(root.querySelector('[data-role="toasts"]')).toBeNull();
    });
});
