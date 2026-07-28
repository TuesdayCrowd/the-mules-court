import { describe, expect, it } from 'vitest';
import {
    IDLE_CHECK_MS,
    IDLE_GRACE_MS,
    WAKE_EVENTS,
    createRenderPump,
    mayIdle
} from './renderPolicy';
import type { RenderPumpDeps } from './renderPolicy';

const idle = { sinceWakeMs: IDLE_GRACE_MS, animating: false, ready: true };

describe('mayIdle — it fails awake', () => {
    it('lets a settled table stop drawing', () => {
        expect(mayIdle(idle)).toBe(true);
    });

    it('keeps drawing while anything is still moving', () => {
        // The failure that matters. Phaser's tween manager is driven by the
        // loop, so a slept loop does not pause a tween — it stops it completing,
        // and beats.ts resolves its promise from onComplete. One missed tween
        // stalls the presentation queue and the table with it.
        expect(mayIdle({ ...idle, animating: true })).toBe(false);
    });

    it('keeps drawing before the gameplay scene is up', () => {
        // Boot and Preloader need the loop; the loading bar advances on it.
        expect(mayIdle({ ...idle, ready: false })).toBe(false);
    });

    it('keeps drawing until the grace period has elapsed', () => {
        expect(mayIdle({ ...idle, sinceWakeMs: 0 })).toBe(false);
        expect(mayIdle({ ...idle, sinceWakeMs: IDLE_GRACE_MS - 1 })).toBe(false);
    });

    it('gives a state update long enough to start the tween it triggers', () => {
        // A push often starts a beat a frame or two later, so the grace period
        // has to outlast that gap comfortably.
        expect(IDLE_GRACE_MS).toBeGreaterThanOrEqual(250);
    });

    it('asks often enough that an idle table settles promptly', () => {
        expect(IDLE_CHECK_MS).toBeLessThanOrEqual(IDLE_GRACE_MS);
    });
});

function harness(overrides: Partial<RenderPumpDeps> = {}) {
    const log: string[] = [];
    let clock = 0;
    let scheduled: (() => void) | null = null;
    let cancelled = false;
    let animating = false;
    let ready = true;

    const deps: RenderPumpDeps = {
        startLoop: () => log.push('start'),
        stopLoop: () => log.push('stop'),
        animating: () => animating,
        ready: () => ready,
        now: () => clock,
        schedule: fn => {
            scheduled = fn;
            return 1;
        },
        cancel: () => {
            cancelled = true;
        },
        ...overrides
    };

    const pump = createRenderPump(deps);

    return {
        pump,
        log,
        advance: (ms: number) => (clock += ms),
        watchdog: () => scheduled?.(),
        setAnimating: (value: boolean) => (animating = value),
        setReady: (value: boolean) => (ready = value),
        wasCancelled: () => cancelled
    };
}

describe('the render pump', () => {
    it('starts awake, because a game that boots asleep never draws at all', () => {
        expect(harness().pump.running()).toBe(true);
    });

    it('stops the loop once the table has been still for the grace period', () => {
        const h = harness();
        h.advance(IDLE_GRACE_MS);
        h.watchdog();

        expect(h.pump.running()).toBe(false);
        expect(h.log).toEqual(['stop']);
    });

    it('does not stop it while a beat is playing, however long it runs', () => {
        const h = harness();
        h.setAnimating(true);
        h.advance(IDLE_GRACE_MS * 20);
        h.watchdog();

        expect(h.pump.running()).toBe(true);
        expect(h.log).toEqual([]);
    });

    it('stops as soon as the beat finishes', () => {
        const h = harness();
        h.setAnimating(true);
        h.advance(IDLE_GRACE_MS * 2);
        h.watchdog();

        h.setAnimating(false);
        h.watchdog();

        expect(h.pump.running()).toBe(false);
    });

    it('restarts the loop on the next thing worth drawing', () => {
        const h = harness();
        h.advance(IDLE_GRACE_MS);
        h.watchdog();

        h.pump.wake();

        expect(h.pump.running()).toBe(true);
        expect(h.log).toEqual(['stop', 'start']);
    });

    it('does not restart a loop that is already running', () => {
        // wake() is called on every pointer move. Calling Phaser's wake() each
        // time would be harmless but pointless; calling startLoop repeatedly
        // here would hide a bug where the pump lost track of its own state.
        const h = harness();
        h.pump.wake();
        h.pump.wake();

        expect(h.log).toEqual([]);
    });

    it('pushes the sleep back each time something happens', () => {
        const h = harness();

        for (let i = 0; i < 5; i++) {
            h.advance(IDLE_GRACE_MS - 1);
            h.pump.wake();
            h.watchdog();
            expect(h.pump.running(), `still awake after wake ${i}`).toBe(true);
        }

        h.advance(IDLE_GRACE_MS);
        h.watchdog();
        expect(h.pump.running()).toBe(false);
    });

    it('never sleeps while the game is still booting', () => {
        const h = harness();
        h.setReady(false);
        h.advance(IDLE_GRACE_MS * 10);
        h.watchdog();

        expect(h.pump.running()).toBe(true);
    });

    it('ignores a watchdog tick that arrives while already asleep', () => {
        const h = harness();
        h.advance(IDLE_GRACE_MS);
        h.watchdog();
        h.watchdog();

        expect(h.log).toEqual(['stop']);
    });

    it('drops its watchdog on destroy', () => {
        const h = harness();
        h.pump.destroy();
        expect(h.wasCancelled()).toBe(true);
    });
});

describe('what wakes it', () => {
    it('covers every way a player can reach the table', () => {
        // Phaser's input managers bind to the canvas and QUEUE what they get;
        // the queue drains in the loop's pre-step. While the loop is stopped a
        // tap is captured and never processed, so the card does nothing — these
        // are what bring the loop back before that queue matters.
        expect([...WAKE_EVENTS]).toEqual(
            expect.arrayContaining(['pointerdown', 'pointerup', 'pointermove', 'keydown'])
        );
    });

    it('includes pointer cancellation, which is how a touch ends when the browser takes over', () => {
        expect([...WAKE_EVENTS]).toContain('pointercancel');
    });
});
