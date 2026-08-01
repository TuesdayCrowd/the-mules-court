// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hex, TOKENS } from '../tokens/tokens';
import type { BeatContext, BeatRunnerDeps } from './beats';
import { createBeatRunner } from './beats';

/**
 * jsdom implements no Web Animations API at all — `Element.prototype.animate`
 * is simply absent, so calling it throws `TypeError: ... is not a function`
 * before any test here could run. `beats.ts` calls `element.animate(...)`
 * directly on transient nodes it creates for itself (see the file's own
 * header: "beats own their own layer"), so there is no seam in
 * `BeatRunnerDeps` to inject a fake through — the polyfill has to sit on
 * `Element.prototype` itself, the same place a real browser puts the method.
 *
 * The stub resolves (or, for one configurable call, rejects) on a microtask
 * tick rather than a real timer, so `await runner.run(...)` settles without
 * needing fake timers. `animateCalls` counts every invocation across the
 * whole test file — reset in `beforeEach` — which is what lets a test assert
 * "the full sequence animates N times" versus "the reduced-motion fade
 * animates once" without inspecting DOM internals neither test needs to know.
 */
let animateCalls = 0;
let rejectOnCall: number | null = null;

function installAnimateStub(): void {
    Element.prototype.animate = function (
        this: Element,
        _keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
        _options?: number | KeyframeAnimationOptions
    ): Animation {
        animateCalls++;
        const callIndex = animateCalls;
        let settle: (() => void) | null = null;

        const animation = {
            cancel() {},
            finished: new Promise<Animation>((resolve, reject) => {
                settle = () => {
                    if (rejectOnCall === callIndex) reject(new Error('stub animation failed'));
                    else resolve(animation);
                };
            })
        } as unknown as Animation;

        queueMicrotask(() => settle?.());
        return animation;
    } as typeof Element.prototype.animate;
}

installAnimateStub();

beforeEach(() => {
    animateCalls = 0;
    rejectOnCall = null;
});

afterEach(() => {
    rejectOnCall = null;
});

const VIEWPORT = { w: 1024, h: 768 } as const;

function harness(overrides: Partial<BeatRunnerDeps> = {}) {
    const layer = document.createElement('div');
    document.body.appendChild(layer);

    const deps: BeatRunnerDeps = {
        reducedMotion: () => false,
        viewport: () => VIEWPORT,
        tableRoot: () => null,
        ...overrides
    };

    return { layer, runner: createBeatRunner(layer, deps) };
}

describe('every beat resolves its promise', () => {
    it.each([
        ['peek', { portraitKey: 'informant.png' }],
        ['play', { portraitKey: 'informant.png' }],
        ['token-award', {}],
        ['victory', {}],
        ['countdown-tick', {}]
    ] as const)('%s settles rather than hanging', async (beat, ctx) => {
        const h = harness();
        await expect(h.runner.run(beat, ctx as BeatContext)).resolves.toBeUndefined();
    });

    it('the elimination sequence resolves end to end', async () => {
        const h = harness();
        await expect(
            h.runner.run('elimination', { rect: { x: 0, y: 0, w: 100, h: 140 }, portraitKey: 'mule.png' })
        ).resolves.toBeUndefined();
    });

    it('the Mule sequence — the longest one — resolves end to end', async () => {
        const h = harness({ tableRoot: () => h.layer });
        await expect(
            h.runner.run('mule', { rect: { x: 0, y: 0, w: 100, h: 140 }, portraitKey: 'mule.png', label: 'The Mule' })
        ).resolves.toBeUndefined();
    });

    it('cleans up every transient element it created once the beat completes', async () => {
        const h = harness({ tableRoot: () => h.layer });
        await h.runner.run('mule', { rect: { x: 0, y: 0, w: 100, h: 140 }, portraitKey: 'mule.png', label: 'The Mule' });

        // "Beats own their own layer" — nothing survives past the promise it
        // resolved, which is what keeps a finished beat from leaking a stray
        // node onto a table that has since redrawn.
        expect(h.layer.children).toHaveLength(0);
    });
});

describe('a throwing step does not wedge the beat', () => {
    it('still runs the steps after the one that threw', async () => {
        // 'elimination' with no portraitKey is banner, then desaturate, then a
        // flip that returns immediately without animating (no card to flip) —
        // so exactly two `animate()` calls are possible, and failing the first
        // must not prevent the second.
        rejectOnCall = 1;
        const h = harness();

        await expect(h.runner.run('elimination', {})).resolves.toBeUndefined();
        expect(animateCalls).toBe(2);
    });

    it('lets the next step clean up after itself, even though the failed one could not', async () => {
        // The failed step's own `finally`-less cleanup line (`el.remove()`)
        // never runs — the throw happens on the line before it — so its
        // element is abandoned in the layer rather than removed. The
        // property this beat runner actually guarantees is narrower and is
        // exactly what the file's header promises: the *next* step still
        // runs and still tidies up its own element. One leftover node from
        // the failure, not a compounding one from every step after it.
        rejectOnCall = 1;
        const h = harness();

        await h.runner.run('elimination', {});
        expect(h.layer.children).toHaveLength(1);
    });

    it('run() itself never rejects, whatever a step does', async () => {
        rejectOnCall = 1;
        const h = harness();
        await expect(h.runner.run('mule', { portraitKey: 'mule.png' })).resolves.toBeUndefined();
    });
});

describe('reduced motion', () => {
    it('collapses a multi-step beat to the single shared fade', async () => {
        const full = harness();
        await full.runner.run('elimination', {});
        const fullCalls = animateCalls;

        animateCalls = 0;
        const reduced = harness({ reducedMotion: () => true });
        await reduced.runner.run('elimination', {});

        // The full sequence (banner + desaturate; flip skips with no portrait)
        // animates twice. Reduced motion is the one `fade` step alone.
        expect(fullCalls).toBe(2);
        expect(animateCalls).toBe(1);
    });

    it('does not collapse an informational beat — a countdown tick is content, not decoration', async () => {
        const h = harness({ reducedMotion: () => true });
        await expect(h.runner.run('countdown-tick', {})).resolves.toBeUndefined();
        // 'tick' animates nothing at all, reduced motion or not — asserting
        // the call count would only prove the no-op stayed a no-op, so this
        // instead pins down the one thing reduced motion must NOT do here:
        // it must not fall through to the fade's `appendWash` + `animate`.
        expect(animateCalls).toBe(0);
    });

    it('still resolves under reduced motion for the flagship Mule beat', async () => {
        const h = harness({ reducedMotion: () => true, tableRoot: () => h.layer });
        await expect(
            h.runner.run('mule', { rect: { x: 0, y: 0, w: 100, h: 140 }, portraitKey: 'mule.png' })
        ).resolves.toBeUndefined();
        expect(animateCalls).toBe(1);
    });
});

describe('destroy', () => {
    it('clears every transient element, abandoning whatever is mid-flight', async () => {
        const h = harness();
        const pending = h.runner.run('token-award', {}); // shimmer appends its <img> synchronously

        expect(h.layer.children.length).toBeGreaterThan(0);
        h.runner.destroy();
        expect(h.layer.children).toHaveLength(0);

        // The abandoned animation's own promise still settles — destroy does
        // not need `run()`'s caller to be waiting for it.
        await expect(pending).resolves.toBeUndefined();
    });

    it('does not touch the table itself, only the beat layer', async () => {
        const tableRoot = document.createElement('div');
        document.body.appendChild(tableRoot);
        const h = harness({ tableRoot: () => tableRoot });

        const pending = h.runner.run('mule', { portraitKey: 'mule.png' });
        h.runner.destroy();
        await pending;

        expect(tableRoot.isConnected).toBe(true);
    });
});

describe('a missing table root', () => {
    it("is a legitimate answer for the Mule's ripple — the shudder is simply skipped", async () => {
        const h = harness({ tableRoot: () => null });
        await expect(
            h.runner.run('mule', { rect: { x: 0, y: 0, w: 100, h: 140 }, portraitKey: 'mule.png' })
        ).resolves.toBeUndefined();
    });
});

describe('an image decodes before its beat animates it (defect 3 — interface rule 8)', () => {
    afterEach(() => {
        // jsdom has no real `decode` to begin with — this only ever exists to
        // be removed again, restoring the "throws synchronously" default the
        // rest of this file's tests already rely on.
        delete (HTMLImageElement.prototype as unknown as { decode?: unknown }).decode;
    });

    it("does not resolve the 'play' beat's promise until its card image has decoded", async () => {
        let release: (() => void) | null = null;
        (HTMLImageElement.prototype as unknown as { decode: () => Promise<void> }).decode = function decode() {
            return new Promise<void>(resolve => {
                release = resolve;
            });
        };

        const h = harness();
        let settled = false;
        const pending = h.runner
            .run('play', { rect: { x: 0, y: 0, w: 100, h: 140 }, portraitKey: 'informant.png' })
            .then(() => {
                settled = true;
            });

        // Flush whatever microtasks are already queued. On a cold cache the
        // fix's whole point is that the beat is still waiting on decode()
        // here — nothing has released it, and the animation has not even
        // been started (the old code would have started it in the same tick
        // `.src` was set).
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(settled).toBe(false);
        expect(animateCalls).toBe(0);
        expect(release).not.toBeNull();

        release!();
        await pending;

        expect(settled).toBe(true);
        expect(animateCalls).toBe(1);
    });
});

describe('beats read colour from tokens, not a hardcoded hex literal (defect 4)', () => {
    /** jsdom normalises a hex colour it is assigned into `rgb(...)`, so this
     * compares like for like instead of a literal string. */
    function domColour(hexString: string): string {
        const probe = document.createElement('span');
        probe.style.color = hexString;
        return probe.style.color;
    }

    it('colours the banner text with TOKENS.colorTextPrimary', async () => {
        const h = harness();
        const pending = h.runner.run('elimination', { label: 'Out of the round' });

        const text = [...h.layer.querySelectorAll('span')].find(el => el.textContent === 'Out of the round');
        expect(text).not.toBeUndefined();
        expect(text!.style.color).toBe(domColour(hex(TOKENS.colorTextPrimary)));

        await pending;
    });

    it('colours the private-peek caption with TOKENS.colorSeatProtected', async () => {
        const h = harness();
        const pending = h.runner.run('peek', { portraitKey: 'informant.png' });

        const caption = [...h.layer.querySelectorAll('span')].find(el => el.textContent === 'Only you see this');
        expect(caption).not.toBeUndefined();
        expect(caption!.style.color).toBe(domColour(hex(TOKENS.colorSeatProtected)));

        await pending;
    });
});

describe("ripple's cleanup runs on every path, not just the happy one (defect 5)", () => {
    it('removes every element it created even when one of its concurrent tasks rejects', async () => {
        // Within the 'mule' beat, ripple's `animate()` calls fire in this
        // order: the viewport wash (call 1, synchronous), the table-root
        // shudder (call 2, synchronous), then the Mule's own portrait (call
        // 3 — deferred one microtask behind the other two by its own
        // `decodeQuietly` await). Failing call 1 exercises the wash task's
        // own rejection path.
        //
        // The old implementation combined the three with `Promise.all` and
        // cleaned up with `.then(() => el.remove())`: a rejected task skips
        // a bare `.then` entirely, so the wash's element would never be
        // removed, and `Promise.all` would abandon awaiting the other two
        // rather than let their own cleanup finish first. This is the
        // assertion that failed under that implementation.
        rejectOnCall = 1;
        const h = harness({ tableRoot: () => h.layer });

        await h.runner.run('mule', { rect: { x: 0, y: 0, w: 100, h: 140 }, portraitKey: 'mule.png', label: 'The Mule' });

        expect(h.layer.children).toHaveLength(0);
    });
});
