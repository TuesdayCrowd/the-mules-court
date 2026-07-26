// @vitest-environment jsdom
import axe from 'axe-core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RoundResult } from '../../game/engine';
import { makeView } from '../store/__fixtures__/view';
import type { ClientState } from '../store/types';
import { fakeTimers, loadRealStyles, makeState, makeTable, makeUiRootElement } from './__fixtures__/dom';
import { createOverlays } from './overlays';

beforeEach(() => {
    loadRealStyles();
});

const DECK_OUT: RoundResult = {
    reason: 'deck-out',
    winnerIds: ['p1'],
    revealedHands: { p1: 'mule', p2: 'informant' }
};

const LAST_SURVIVOR: RoundResult = { reason: 'last-survivor', winnerIds: ['p2'] };

function mounted(options: { isHost?: boolean; canEndMatch?: boolean } = {}) {
    const root = makeUiRootElement();
    const clock = fakeTimers();
    const ended: number[] = [];

    const overlays = createOverlays({
        timers: clock.timers,
        now: () => nowValue,
        isHost: () => options.isHost ?? false,
        canEndMatch: () => options.canEndMatch ?? false,
        onEndMatch: () => ended.push(1)
    });
    overlays.mount(root);

    let nowValue = 1_000_000;

    const q = <T extends Element>(selector: string) => root.querySelector(selector) as T | null;

    return {
        root,
        overlays,
        clock,
        ended,
        setNow: (value: number) => (nowValue = value),
        dialog: () => q<HTMLElement>('[role="dialog"]'),
        kind: () => q<HTMLElement>('[data-role="overlay"]')?.dataset.overlay ?? null,
        text: () => q<HTMLElement>('[data-role="overlay"]')?.textContent ?? '',
        endButton: () => q<HTMLButtonElement>('[data-action="end-match"]'),
        countdown: () => q<HTMLElement>('[data-role="countdown"]'),
        show: (state: Partial<ClientState>) => overlays.update(makeState({ screen: 'table', ...state }))
    };
}

describe('when nothing is overlaid', () => {
    it('shows nothing during an ordinary turn', () => {
        const ui = mounted();
        ui.show({ table: makeTable() });
        expect(ui.dialog()).toBeNull();
    });

    it('shows nothing away from the table', () => {
        const ui = mounted();
        ui.show({ screen: 'lobby' });
        expect(ui.dialog()).toBeNull();
    });
});

describe('round over', () => {
    it('states the reason for a deck-out', () => {
        const ui = mounted();
        ui.show({ table: makeTable({ phase: 'round_over', view: makeView({ roundResult: DECK_OUT }) }) });

        expect(ui.kind()).toBe('round-over');
        expect(ui.text()).toContain('Deck ran out — highest card wins.');
    });

    it('names the survivor when one is left standing', () => {
        const ui = mounted();
        ui.show({ table: makeTable({ phase: 'round_over', view: makeView({ roundResult: LAST_SURVIVOR }) }) });

        expect(ui.text()).toContain('Bayta');
        expect(ui.text()).toContain('last');
    });

    it('names every co-winner on a shared round', () => {
        const ui = mounted();
        ui.show({
            table: makeTable({
                phase: 'round_over',
                view: makeView({ roundResult: { ...DECK_OUT, winnerIds: ['p1', 'p2'] } })
            })
        });

        expect(ui.text()).toContain('Ana');
        expect(ui.text()).toContain('Bayta');
    });

    it('renders revealed hands from roundResult alone', () => {
        const ui = mounted();
        ui.show({ table: makeTable({ phase: 'round_over', view: makeView({ roundResult: DECK_OUT }) }) });

        expect(ui.text()).toContain('The Mule');
        expect(ui.text()).toContain('Informant');
    });

    it('renders nothing for a null revealed hand, which is the empty-hand edge case', () => {
        const ui = mounted();
        ui.show({
            table: makeTable({
                phase: 'round_over',
                view: makeView({ roundResult: { ...DECK_OUT, revealedHands: { p1: 'mule', p2: null } } })
            })
        });

        const rows = [...ui.root.querySelectorAll('[data-role="revealed-hand"]')];
        expect(rows).toHaveLength(1);
        expect(rows[0].textContent).toContain('The Mule');
    });

    it('reveals no hands at all on a last-survivor round', () => {
        const ui = mounted();
        ui.show({ table: makeTable({ phase: 'round_over', view: makeView({ roundResult: LAST_SURVIVOR }) }) });
        expect(ui.root.querySelectorAll('[data-role="revealed-hand"]')).toHaveLength(0);
    });

    it('renders no round-over overlay for a round that also wins the match', () => {
        // UIX §9.1: the match-over screen supersedes it rather than stacking.
        const ui = mounted();
        ui.show({
            table: makeTable({
                phase: 'round_over',
                view: makeView({ roundResult: DECK_OUT, matchWinnerId: 'p1' })
            })
        });

        expect(ui.kind()).toBe('match-over');
    });
});

describe('the reveal countdown', () => {
    const roundOver = (revealDeadline: number) =>
        makeTable({
            phase: 'round_over',
            revealDeadline,
            serverTime: 1_000_000,
            receivedAt: 1_000_000,
            view: makeView({ roundResult: DECK_OUT })
        });

    it('renders the seconds the server has left', () => {
        const ui = mounted();
        ui.show({ table: roundOver(1_005_000) });
        expect(ui.countdown()!.textContent).toContain('5');
    });

    it('ticks down as local time passes, without a new snapshot', () => {
        const ui = mounted();
        ui.show({ table: roundOver(1_005_000) });

        ui.setNow(1_002_000);
        ui.clock.run();

        expect(ui.countdown()!.textContent).toContain('3');
    });

    it('stops at zero rather than counting past the deadline', () => {
        const ui = mounted();
        ui.show({ table: roundOver(1_005_000) });

        ui.setNow(1_099_000);
        ui.clock.run();

        expect(ui.countdown()!.textContent).toContain('0');
    });

    it('cancels its tick when the overlay goes away', () => {
        const ui = mounted();
        ui.show({ table: roundOver(1_005_000) });
        ui.show({ table: makeTable() });

        expect(ui.clock.pendingCount()).toBe(0);
    });
});

describe('match over', () => {
    const won = (overrides = {}) =>
        makeTable({
            phase: 'ended',
            view: makeView({ matchWinnerId: 'p1', tokensToWin: 7 }),
            ...overrides
        });

    it('states the token target', () => {
        const ui = mounted();
        ui.show({ table: won(), ended: { reason: 'won', winnerSeat: 'p1' } });

        expect(ui.kind()).toBe('match-over');
        expect(ui.text()).toContain('7');
    });

    it('names the winner', () => {
        const ui = mounted();
        ui.show({ table: won(), ended: { reason: 'won', winnerSeat: 'p1' } });
        expect(ui.text()).toContain('Ana');
    });

    it('lists the final tallies for every seat', () => {
        const ui = mounted();
        ui.show({ table: won(), ended: { reason: 'won', winnerSeat: 'p1' } });

        const tallies = [...ui.root.querySelectorAll('[data-role="tally"]')];
        expect(tallies).toHaveLength(2);
        expect(tallies[0].textContent).toContain('Ana');
    });

    it('renders one line and no celebration for an abandoned match', () => {
        const ui = mounted();
        ui.show({ table: won(), ended: { reason: 'abandoned' } });

        expect(ui.text()).toContain('abandoned');
        expect(ui.root.querySelectorAll('[data-role="tally"]')).toHaveLength(0);
    });
});

describe('paused', () => {
    const paused = makeTable({ paused: true, missingSeats: ['p2'] });

    it('names the missing seat', () => {
        const ui = mounted();
        ui.show({ table: paused });

        expect(ui.kind()).toBe('paused');
        expect(ui.text()).toContain('Bayta');
    });

    it('says the match resumes on its own', () => {
        const ui = mounted();
        ui.show({ table: paused });
        expect(ui.text()).toContain('resume');
    });

    it('names every missing seat when more than one is gone', () => {
        const ui = mounted();
        ui.show({ table: makeTable({ paused: true, missingSeats: ['p1', 'p2'] }) });

        expect(ui.text()).toContain('Ana');
        expect(ui.text()).toContain('Bayta');
    });

    it('offers End match to the host straight away', () => {
        const ui = mounted({ isHost: true, canEndMatch: false });
        ui.show({ table: paused });
        expect(ui.endButton()).not.toBeNull();
    });

    it('withholds it from another seat before the grace has passed', () => {
        const ui = mounted({ isHost: false, canEndMatch: false });
        ui.show({ table: paused });
        expect(ui.endButton()).toBeNull();
    });

    it('offers it to another seat once the grace has passed', () => {
        const ui = mounted({ isHost: false, canEndMatch: true });
        ui.show({ table: paused });
        expect(ui.endButton()).not.toBeNull();
    });

    it('emits once when pressed', () => {
        const ui = mounted({ isHost: true });
        ui.show({ table: paused });
        ui.endButton()!.click();
        expect(ui.ended).toHaveLength(1);
    });

    it('gives way to match over, which is terminal', () => {
        const ui = mounted();
        ui.show({ table: makeTable({ paused: true, phase: 'ended' }), ended: { reason: 'abandoned' } });
        expect(ui.kind()).toBe('match-over');
    });
});

describe('every overlay', () => {
    const CASES = [
        ['round-over', { table: makeTable({ phase: 'round_over', view: makeView({ roundResult: DECK_OUT }) }) }],
        ['paused', { table: makeTable({ paused: true, missingSeats: ['p2'] }) }],
        [
            'match-over',
            { table: makeTable({ phase: 'ended', view: makeView({ matchWinnerId: 'p1' }) }), ended: { reason: 'won' as const } }
        ]
    ] as const;

    it.each(CASES)('%s is a dialog with an accessible name', (_kind, state) => {
        const ui = mounted();
        ui.show(state);

        expect(ui.dialog()!.getAttribute('role')).toBe('dialog');
        const labelledBy = ui.dialog()!.getAttribute('aria-labelledby')!;
        expect(document.getElementById(labelledBy)!.textContent!.length).toBeGreaterThan(0);
    });

    it.each(CASES)('%s takes focus when it appears', (_kind, state) => {
        const ui = mounted();
        ui.show(state);
        expect(document.activeElement).toBe(ui.dialog());
    });

    it.each(CASES)('%s does not re-take focus on an unrelated update', (_kind, state) => {
        const ui = mounted();
        ui.show(state);
        document.body.focus();

        ui.show(state);

        expect(document.activeElement).not.toBe(ui.dialog());
    });

    it.each(CASES)('%s has no axe violations', async (_kind, state) => {
        const ui = mounted();
        ui.show(state);

        const results = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
        expect(results.violations.map(v => v.id)).toEqual([]);
    });
});
