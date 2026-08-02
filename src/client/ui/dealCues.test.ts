/**
 * The deal's sounds, held to the deal's own timing.
 *
 * Two regressions live here, and both shipped: offsets recomputed beside the
 * scheduler instead of read from `store/motion.ts`, and timeouts nobody kept a
 * handle to.
 */

import { describe, expect, it } from 'vitest';
import { DEAL_STAGGER_CAP, DEAL_STAGGER_MS, dealDelayMs } from '../store/motion';
import type { SoundName } from '../store/sound';
import type { Timers } from './surface';
import { playDealCues } from './dealCues';

/** Timers that fire only when a test says so, recording what was asked for. */
function fakeTimers() {
    let next = 1;
    const pending = new Map<number, { fn: () => void; ms: number }>();

    const timers: Timers = {
        setTimeout(fn, ms) {
            const handle = next++;
            pending.set(handle, { fn, ms });
            return handle;
        },
        clearTimeout(handle) {
            pending.delete(handle as number);
        }
    };

    return {
        timers,
        delays: () => [...pending.values()].map(entry => entry.ms),
        pendingCount: () => pending.size,
        run() {
            const due = [...pending.values()];
            pending.clear();
            for (const entry of due) entry.fn();
        }
    };
}

function harness() {
    const clock = fakeTimers();
    const heard: SoundName[] = [];
    const start = (count: number) =>
        playDealCues({ count, cue: 'deal', play: name => heard.push(name), timers: clock.timers });
    return { clock, heard, start };
}

describe('the deal cues', () => {
    it('sounds the first card immediately, with no timer between a card and its own swish', () => {
        const { clock, heard, start } = harness();
        start(3);
        expect(heard).toEqual(['deal']);
        expect(clock.delays()).toEqual([dealDelayMs(1), dealDelayMs(2)]);
    });

    it('gives every card exactly one sound', () => {
        const { clock, heard, start } = harness();
        start(4);
        clock.run();
        expect(heard).toHaveLength(4);
    });

    it('schedules on the offsets the cards actually fly on', () => {
        const { clock, start } = harness();
        start(5);
        expect(clock.delays()).toEqual([1, 2, 3, 4].map(dealDelayMs));
    });

    it('honours the stagger cap, so a long deal never drifts from its cards', () => {
        // The regression: `index * DEAL_STAGGER_MS` keeps growing while
        // `dealDelayMs` stops at the cap, so from the eighth card the swish
        // arrives after the card it belongs to and the gap widens from there.
        const cards = DEAL_STAGGER_CAP + 4;
        const { clock, start } = harness();
        start(cards);

        const ceiling = DEAL_STAGGER_CAP * DEAL_STAGGER_MS;
        expect(Math.max(...clock.delays())).toBe(ceiling);
        expect(clock.delays()).toEqual(
            Array.from({ length: cards - 1 }, (_unused, index) => dealDelayMs(index + 1))
        );
        // Stated the other way round, because this is the number that was wrong:
        // the last card would have been scheduled at (cards - 1) * stagger.
        expect(Math.max(...clock.delays())).toBeLessThan((cards - 1) * DEAL_STAGGER_MS);
    });

    it('cancels what has not sounded yet', () => {
        // A deal interrupted by a fatal, by the menu, or by the round ending
        // must not keep swishing over a screen with no table on it.
        const { clock, heard, start } = harness();
        const stop = start(5);

        stop();
        clock.run();

        expect(clock.pendingCount()).toBe(0);
        expect(heard).toEqual(['deal']); // only the one that had already sounded
    });

    it('is safe to cancel twice', () => {
        const { clock, start } = harness();
        const stop = start(4);
        stop();
        expect(() => stop()).not.toThrow();
        expect(clock.pendingCount()).toBe(0);
    });

    it('schedules nothing for a deal of no cards', () => {
        const { clock, heard, start } = harness();
        start(0);
        expect(heard).toEqual([]);
        expect(clock.pendingCount()).toBe(0);
    });
});
