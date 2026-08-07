// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * A line about the viewer has to look and behave differently from the running
 * commentary — that difference is the whole fix for "it is unclear what just
 * happened to me".
 */
describe('a line about the viewer', () => {
    it('is marked so CSS can dress it apart from commentary', () => {
        const h = mounted();
        h.toasts.show('Han Pritcher made you discard your hand.', { kind: 'personal' });

        const node = h.root.querySelector('[data-role="toast"]') as HTMLElement;
        expect(node.dataset.kind).toBe('personal');
    });

    it('defaults to narration, so every existing caller is unchanged', () => {
        const h = mounted();
        h.toasts.show('Han Pritcher played Informant.');

        const node = h.root.querySelector('[data-role="toast"]') as HTMLElement;
        expect(node.dataset.kind).toBe('narration');
    });

    it('schedules its own shorter timeout rather than the region default', () => {
        const h = mounted();
        h.toasts.show('Han Pritcher looked at your hand.', { kind: 'personal', timeoutMs: 3000 });

        expect(h.clock.delays()).toEqual([3000]);
    });

    it('leaves a commentary line on the longer region default', () => {
        const h = mounted();
        h.toasts.show('Han Pritcher played Informant.');

        expect(h.clock.delays()).toEqual([5000]);
    });

    it('still clears itself when its timer fires', () => {
        const h = mounted();
        h.toasts.show('Han Pritcher looked at your hand.', { kind: 'personal', timeoutMs: 3000 });
        expect(h.lines()).toHaveLength(1);

        h.clock.run();
        expect(h.lines()).toHaveLength(0);
    });
});

/**
 * The channel is two things at once: an `aria-live` account of the whole table
 * for a player who cannot see it, and a small number of painted lines for a
 * player who can. Mounting the region for the first time made that split
 * visible — five commentary lines stacked over the deck during one bot turn.
 */
describe('what gets painted and what only gets announced', () => {
    it('marks a server refusal as a notice, so failure copy is never hidden', () => {
        const h = mounted({ copyFor: () => 'Not your turn.' });
        h.toasts.update(makeState({ notices: [{ id: 'n1', code: 'NOT_YOUR_TURN' as ErrorCode }] }));

        const node = h.root.querySelector('[data-role="toast"]') as HTMLElement;
        expect(node.dataset.kind).toBe('notice');
    });

    it('keeps commentary in the live region rather than dropping it', () => {
        const h = mounted();
        h.toasts.show('Kelden Amadiro played The First Speaker.');

        // Still a child of the region, so it is still announced; `ui.css` is
        // what stops it being painted, and `display: none` would silence it.
        expect(h.lines()).toEqual(['Kelden Amadiro played The First Speaker.']);
    });

    it('distinguishes all four kinds, which is what CSS keys on', () => {
        const h = mounted();
        h.toasts.show('a', { kind: 'narration' });
        h.toasts.show('b', { kind: 'personal' });
        h.toasts.show('c', { kind: 'table' });
        h.toasts.update(makeState({ notices: [{ id: 'n1', code: 'RATE_LIMITED' as ErrorCode }] }));

        const kinds = [...h.root.querySelectorAll('[data-role="toast"]')].map(n => (n as HTMLElement).dataset.kind);
        expect(new Set(kinds)).toEqual(new Set(['narration', 'personal', 'table', 'notice']));
    });
});

/**
 * The CSS contract itself, not just the DOM attribute CSS keys on.
 *
 * Nothing above can catch a regression where `[data-kind='narration']` stops
 * being the clipped rule — jsdom has no layout engine, so `getComputedStyle`
 * on `clip-path`/`width`/`height` here would be hollow (`laying-out-the-table`
 * and the purity/tableContract tests all make the same call: read the file as
 * text instead).
 *
 * The tests above are honest about their own reach and this one should be too:
 * `dataset.kind` is an opaque string at runtime, so a test that merely shows a
 * toast of each kind passes on a checkout where the kind means nothing. What
 * decides whether a bystander guess is *seen* is this file, and only this file.
 */
describe('the CSS contract behind data-kind', () => {
    const cssSource = readFileSync(join(import.meta.dirname, '..', 'styles', 'ui.css'), 'utf8');

    /** Every `.toast[data-kind='X'] { ... }` rule in the file, by its kind. */
    function toastKindRules(source: string): Map<string, string> {
        const rules = new Map<string, string>();
        const pattern = /\.toast\[data-kind='([^']+)'\]\s*\{([^}]*)\}/g;
        for (const match of source.matchAll(pattern)) rules.set(match[1], match[2]);
        return rules;
    }

    it('clips narration to screen-reader-only and paints every other kind', () => {
        const rules = toastKindRules(cssSource);
        expect(rules.has('narration')).toBe(true);

        for (const [kind, body] of rules) {
            if (kind === 'narration') {
                expect(body, `[data-kind='${kind}'] should be clipped`).toMatch(/clip-path/);
            } else {
                expect(body, `[data-kind='${kind}'] should not be clipped`).not.toMatch(/clip-path/);
            }
        }
    });

    it('gives a bystander guess a rule of its own, which is what makes it visible at all', () => {
        // Fails on any checkout without this feature: `table` had no rule, so it
        // inherited the clipped default's absence and read as a plain `notice`.
        const table = toastKindRules(cssSource).get('table');
        expect(table).toBeDefined();
        expect(table).not.toMatch(/clip-path/);
    });

    it('keeps a bystander guess distinguishable from a server refusal', () => {
        // `notice` has no rule and wears the bare `.toast` box, so a `table`
        // line that declared no border of its own would be pixel-identical to
        // "the court refused your play" — two meanings, one appearance, both
        // able to be on screen at the same moment.
        const table = toastKindRules(cssSource).get('table') ?? '';
        expect(table).toMatch(/border-color/);
    });

    it('spends the your-turn colour on nothing but a personal line', () => {
        // The palette's one toast hue means "this concerns you". A bystander
        // guess borrowing it would cost the colour its only word.
        const rules = toastKindRules(cssSource);
        for (const [kind, body] of rules) {
            if (kind === 'personal') continue;
            expect(body, `[data-kind='${kind}'] must not claim the your-turn colour`).not.toMatch(
                /--color-state-your-turn/
            );
        }
    });
});
