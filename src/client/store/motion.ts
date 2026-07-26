/**
 * What a cinematic beat is made of (UIX §8).
 *
 * The reduced-motion decision is a *policy*, not a rendering detail, so it lives
 * out here where a test can read it — the scene only executes what this returns.
 * `prefers-reduced-motion` is a stated accessibility need, and burying its
 * handling inside tween code is how it quietly stops being honoured.
 *
 * The cinematic budget is spent exactly where the tone decision put it: the Mule
 * gets a ripple and a loom, eliminations get a staged reveal, and everything else
 * resolves in ≤ 300 ms.
 */

export type BeatName = 'mule' | 'elimination' | 'peek' | 'play' | 'countdown-tick' | 'token-award' | 'victory';

export type StepKind = 'fade' | 'banner' | 'desaturate' | 'flip' | 'ripple' | 'loom' | 'reveal' | 'shimmer' | 'burst' | 'tick';

export interface MotionStep {
    readonly kind: StepKind;
    readonly durationMs: number;
}

export interface MotionPlan {
    readonly steps: readonly MotionStep[];
}

export interface MotionRequest {
    readonly beat: BeatName;
    readonly reducedMotion: boolean;
    /**
     * Present for eliminations. Deliberately unused by the policy: UIX §8.3
     * gives a voluntary and a forced Mule discard the identical beat, because
     * the dread is the point and it does not depend on who chose it.
     */
    readonly cause?: 'guard' | 'baron' | 'mule-voluntary' | 'mule-forced';
}

/** UIX §8: everything outside the two flagship beats resolves within this. */
const QUICK_MS = 300;
/** The collapsed form of any beat under reduced motion. */
const FADE: MotionStep = { kind: 'fade', durationMs: 150 };

/**
 * Beats that reduced motion must NOT touch.
 *
 * A countdown and a pip are information, not decoration. Collapsing them would
 * remove content rather than remove movement, which is not what the setting
 * asks for.
 */
const INFORMATIONAL: ReadonlySet<BeatName> = new Set<BeatName>(['countdown-tick']);

const FULL: Readonly<Record<BeatName, readonly MotionStep[]>> = {
    // The flip is the information, so it stages last and biggest (~1s total).
    elimination: [
        { kind: 'banner', durationMs: 200 },
        { kind: 'desaturate', durationMs: 500 },
        { kind: 'flip', durationMs: 300 }
    ],
    // The flagship. Ripple and loom, then the ordinary elimination sequence.
    mule: [
        { kind: 'ripple', durationMs: 600 },
        { kind: 'loom', durationMs: 1200 },
        { kind: 'banner', durationMs: 200 },
        { kind: 'desaturate', durationMs: 500 },
        { kind: 'flip', durationMs: 300 }
    ],
    peek: [{ kind: 'reveal', durationMs: QUICK_MS }],
    play: [{ kind: 'flip', durationMs: QUICK_MS }],
    'token-award': [{ kind: 'shimmer', durationMs: QUICK_MS }],
    victory: [{ kind: 'burst', durationMs: QUICK_MS }],
    'countdown-tick': [{ kind: 'tick', durationMs: 0 }]
};

export function motionPlan(request: MotionRequest): MotionPlan {
    if (request.reducedMotion && !INFORMATIONAL.has(request.beat)) {
        return { steps: [FADE] };
    }
    return { steps: FULL[request.beat] };
}

/** Total wall time a beat will take, for budgeting the presentation queue. */
export function beatDurationMs(plan: MotionPlan): number {
    return plan.steps.reduce((total, step) => total + step.durationMs, 0);
}
