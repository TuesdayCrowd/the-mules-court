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

import type { PresentationEvent } from './diff';

export type BeatName = 'mule' | 'elimination' | 'peek' | 'play' | 'deal' | 'countdown-tick' | 'token-award' | 'victory';

export type StepKind =
    | 'fade'
    | 'banner'
    | 'desaturate'
    | 'flip'
    | 'deal'
    | 'ripple'
    | 'loom'
    | 'reveal'
    | 'shimmer'
    | 'burst'
    | 'tick';

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
 * One card travelling from the deck into a hand.
 *
 * Inside the ≤ 300 ms budget UIX §8 gives everything but the two flagships, and
 * deliberately short of it: several cards are dealt at once at the start of a
 * round, and the whole choreographed sequence — this duration plus the largest
 * stagger below — has to stay under ~500 ms. A player waiting on a flourish
 * before they can act resents it by round three.
 */
const DEAL_MS = 260;

/**
 * The gap between one dealt card leaving the deck and the next.
 *
 * Five cards animating together read as one block moving; the same five at
 * 40 ms apart read as *dealing*. That is the entire trick, and it costs one
 * multiplication.
 */
export const DEAL_STAGGER_MS = 40;

/**
 * How many cards the stagger keeps growing for.
 *
 * Stagger × count grows fast and the count is not bounded by anything the
 * client controls — a round deals one card per seat, and a Darell redraw can
 * land alongside. Capping keeps the worst case a fixed 240 ms rather than a
 * number that gets worse as the table gets fuller.
 */
export const DEAL_STAGGER_CAP = 6;

/**
 * How long the `index`-th card of a simultaneous deal waits before it flies.
 *
 * Here rather than in the drawing layer for this module whole reason: a
 * duration hardcoded beside an `animate()` call is a duration no test can read.
 */
export function dealDelayMs(index: number): number {
    return Math.min(Math.max(Math.trunc(index), 0), DEAL_STAGGER_CAP) * DEAL_STAGGER_MS;
}

/** Wall time for a whole simultaneous deal: the last card starts latest and still has to fly. */
export function dealSequenceMs(cardCount: number): number {
    return cardCount <= 0 ? 0 : dealDelayMs(cardCount - 1) + DEAL_MS;
}

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
    // One step, not a travel followed by a settle. The arc already carries the
    // arrival — the card decelerates into its slot on a Decelerate curve and
    // banks along the tangent as it goes — and a second step would spend the
    // stagger budget restating what the first one just said.
    deal: [{ kind: 'deal', durationMs: DEAL_MS }],
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

/**
 * Which beat a presentation event deserves, if any.
 *
 * Exhaustive, with a `never` default, for the same reason `announcementFor` is:
 * an event that computes a beat and then gets dropped is invisible, and that is
 * exactly how the private peek shipped doing nothing at all.
 *
 * `null` is a real answer here. Most log entries are a toast and no more — the
 * cinematic budget is spent on eliminations and the Mule (UIX §8), and spending
 * it anywhere else is what makes those two stop feeling like anything.
 */
export function beatForEvent(event: PresentationEvent): BeatName | null {
    switch (event.kind) {
        case 'log':
            if (event.entry.kind === 'PLAY') return 'play';
            if (event.entry.kind === 'ELIMINATED') {
                // Voluntary and forced discards are identical (UIX §8.3): the
                // dread does not depend on who chose it.
                return event.entry.cause === 'mule-voluntary' || event.entry.cause === 'mule-forced'
                    ? 'mule'
                    : 'elimination';
            }
            return null;

        case 'peek-gained':
            return 'peek';

        // A card leaving the deck for a hand. Decoration, not information — the
        // hand itself is redrawn by the ordinary state push either way — so
        // reduced motion collapses it like the rest.
        case 'card-drawn':
            return 'deal';

        // Losing a peek is information going stale, not an event with a moment.
        case 'peek-lost':
            return null;

        // The overlay carries the *result*; the shimmer carries the award.
        // UIX §9.1: "a medallion pip drifts onto the winner's seat with the
        // rainbow shimmer" — which is the only thing `rainbow_gradient` is
        // assigned to (UIX §8.5), and it played nowhere until this returned it.
        case 'round-over':
            return 'token-award';

        // UIX §9.2's sparkle burst, and the other half of §8.5's assignment.
        case 'match-over':
            return 'victory';

        default: {
            const exhaustive: never = event;
            return exhaustive;
        }
    }
}
