import { describe, expect, it } from 'vitest';
import type { BeatName } from './motion';
import { DEAL_STAGGER_CAP, DEAL_STAGGER_MS, beatDurationMs, beatForEvent, dealDelayMs, dealSequenceMs, motionPlan } from './motion';

const ALL: BeatName[] = ['mule', 'elimination', 'peek', 'play', 'deal', 'countdown-tick', 'token-award', 'victory'];

describe('reduced motion', () => {
    it('collapses every beat to a fade under prefers-reduced-motion', () => {
        const plan = motionPlan({ beat: 'mule', reducedMotion: true });
        expect(plan.steps.map(s => s.kind)).toEqual(['fade']);
    });

    it('collapses the elimination sequence too', () => {
        expect(motionPlan({ beat: 'elimination', reducedMotion: true }).steps.map(s => s.kind)).toEqual(['fade']);
    });

    it('leaves countdowns and pips untouched by reduced motion', () => {
        expect(motionPlan({ beat: 'countdown-tick', reducedMotion: true }).steps).toEqual(
            motionPlan({ beat: 'countdown-tick', reducedMotion: false }).steps
        );
    });

    it('collapses every beat that is not informational', () => {
        for (const beat of ALL) {
            const steps = motionPlan({ beat, reducedMotion: true }).steps;
            if (beat === 'countdown-tick') continue;
            expect(steps.map(s => s.kind), beat).toEqual(['fade']);
        }
    });
});

describe('the staged beats', () => {
    it('stages an elimination banner, then desaturation, then the card flip', () => {
        expect(motionPlan({ beat: 'elimination', reducedMotion: false }).steps.map(s => s.kind)).toEqual([
            'banner',
            'desaturate',
            'flip'
        ]);
        // The flip is the information, so it lands last and biggest.
    });

    it('gives the Mule the ripple and the loom before the elimination sequence', () => {
        expect(motionPlan({ beat: 'mule', reducedMotion: false }).steps.map(s => s.kind)).toEqual([
            'ripple',
            'loom',
            'banner',
            'desaturate',
            'flip'
        ]);
    });

    it('treats a voluntary and a forced Mule discard identically', () => {
        expect(motionPlan({ beat: 'mule', cause: 'mule-voluntary', reducedMotion: false })).toEqual(
            motionPlan({ beat: 'mule', cause: 'mule-forced', reducedMotion: false })
        );
    });

    it('looms for the 1.2 seconds the design asks for', () => {
        const loom = motionPlan({ beat: 'mule', reducedMotion: false }).steps.find(s => s.kind === 'loom');
        expect(loom!.durationMs).toBe(1200);
    });

    it('runs an elimination in about a second', () => {
        expect(beatDurationMs(motionPlan({ beat: 'elimination', reducedMotion: false }))).toBe(1000);
    });
});

describe('the deal', () => {
    it('is one travelling step, so the arc carries the whole arrival', () => {
        expect(motionPlan({ beat: 'deal', reducedMotion: false }).steps.map(s => s.kind)).toEqual(['deal']);
    });

    it('collapses to the shared fade under reduced motion — a deal is decoration, not information', () => {
        expect(motionPlan({ beat: 'deal', reducedMotion: true }).steps.map(s => s.kind)).toEqual(['fade']);
    });

    it('staggers 40ms per card', () => {
        expect(dealDelayMs(0)).toBe(0);
        expect(dealDelayMs(1)).toBe(DEAL_STAGGER_MS);
        expect(dealDelayMs(3)).toBe(3 * DEAL_STAGGER_MS);
    });

    it('caps the stagger, so a fuller table does not deal more slowly per card', () => {
        expect(dealDelayMs(DEAL_STAGGER_CAP)).toBe(DEAL_STAGGER_CAP * DEAL_STAGGER_MS);
        expect(dealDelayMs(DEAL_STAGGER_CAP + 1)).toBe(dealDelayMs(DEAL_STAGGER_CAP));
        expect(dealDelayMs(500)).toBe(dealDelayMs(DEAL_STAGGER_CAP));
    });

    it('treats a nonsensical index as the first card rather than a negative delay', () => {
        expect(dealDelayMs(-1)).toBe(0);
        expect(dealDelayMs(1.9)).toBe(DEAL_STAGGER_MS);
    });

    it('keeps a whole simultaneous deal under 500ms, however many cards land', () => {
        // Stagger × count grows fast; the player next decision outranks the flourish.
        expect(dealSequenceMs(0)).toBe(0);
        for (const count of [1, 2, 4, 8, 64]) {
            expect(dealSequenceMs(count), `${count} cards`).toBeLessThanOrEqual(500);
        }
    });

    it('gets slower with more cards only up to the cap', () => {
        expect(dealSequenceMs(4)).toBeGreaterThan(dealSequenceMs(1));
        expect(dealSequenceMs(64)).toBe(dealSequenceMs(DEAL_STAGGER_CAP + 1));
    });
});

describe('the cinematic budget', () => {
    it('resolves every beat but the two flagships within 300ms', () => {
        // UIX §8: the budget is spent exactly where the tone decision put it.
        for (const beat of ALL) {
            if (beat === 'mule' || beat === 'elimination') continue;
            expect(beatDurationMs(motionPlan({ beat, reducedMotion: false })), beat).toBeLessThanOrEqual(300);
        }
    });

    it('spends the budget on the Mule above all', () => {
        const mule = beatDurationMs(motionPlan({ beat: 'mule', reducedMotion: false }));
        for (const beat of ALL) {
            if (beat === 'mule') continue;
            expect(mule, beat).toBeGreaterThan(beatDurationMs(motionPlan({ beat, reducedMotion: false })));
        }
    });

    it('makes every beat cheaper under reduced motion', () => {
        for (const beat of ALL) {
            if (beat === 'countdown-tick') continue;
            expect(
                beatDurationMs(motionPlan({ beat, reducedMotion: true })),
                beat
            ).toBeLessThanOrEqual(beatDurationMs(motionPlan({ beat, reducedMotion: false })));
        }
    });

    it('has a plan for every beat, so none falls through to nothing', () => {
        for (const beat of ALL) {
            expect(motionPlan({ beat, reducedMotion: false }).steps.length, beat).toBeGreaterThan(0);
        }
    });
});

describe('beatForEvent', () => {
    it('gives an ordinary play its quick beat', () => {
        expect(beatForEvent({ kind: 'log', entry: { kind: 'PLAY', turn: 1, actorId: 'p1', cardId: 'informant' } })).toBe('play');
    });

    it.each(['guard', 'baron'] as const)('stages an elimination caused by %s', cause => {
        expect(beatForEvent({ kind: 'log', entry: { kind: 'ELIMINATED', turn: 1, playerId: 'p2', cause } })).toBe('elimination');
    });

    it.each(['mule-voluntary', 'mule-forced'] as const)('gives the Mule its own beat when %s', cause => {
        // UIX §8.3: identical either way — the dread does not depend on choice.
        expect(beatForEvent({ kind: 'log', entry: { kind: 'ELIMINATED', turn: 1, playerId: 'p2', cause } })).toBe('mule');
    });

    it('deals a card that arrived in the viewer own hand', () => {
        expect(beatForEvent({ kind: 'card-drawn', seatId: 'p1', cardTypeId: 'mule' })).toBe('deal');
    });

    it('deals a card that arrived in an opponent hand, which carries no identity', () => {
        expect(beatForEvent({ kind: 'card-drawn', seatId: 'p2' })).toBe('deal');
    });

    it('reveals a peek', () => {
        expect(beatForEvent({ kind: 'peek-gained', subjectId: 'p2', cardTypeId: 'mule' })).toBe('peek');
    });

    it('shimmers the devotion token onto the round winner', () => {
        // UIX §9.1, and the only thing rainbow_gradient is assigned to (§8.5).
        expect(beatForEvent({ kind: 'round-over', result: { reason: 'deck-out', winnerIds: ['p1'] } })).toBe('token-award');
    });

    it('bursts on the match ending', () => {
        // UIX §9.2, and the only thing sparkle_pattern is assigned to (§8.5).
        expect(beatForEvent({ kind: 'match-over', winnerId: 'p1' })).toBe('victory');
    });

    it('spends nothing on the events that are only information', () => {
        // The budget is spent on eliminations and the Mule; spending it
        // everywhere is what stops those two feeling like anything.
        expect(beatForEvent({ kind: 'peek-lost', subjectId: 'p2' })).toBeNull();
        expect(beatForEvent({ kind: 'log', entry: { kind: 'PROTECTED', turn: 1, actorId: 'p1' } })).toBeNull();
    });

    it('leaves no beat in the table that nothing can ever select', () => {
        // The shimmer and the burst were both implemented, both assigned a
        // shader map by UIX §8.5, and both unreachable: `beatForEvent` was the
        // only selector and it never returned either name.
        const selectable = new Set(
            (
                [
                    { kind: 'log', entry: { kind: 'PLAY', turn: 1, actorId: 'p1', cardId: 'informant' } },
                    { kind: 'log', entry: { kind: 'ELIMINATED', turn: 1, playerId: 'p2', cause: 'guard' } },
                    { kind: 'log', entry: { kind: 'ELIMINATED', turn: 1, playerId: 'p2', cause: 'mule-forced' } },
                    { kind: 'peek-gained', subjectId: 'p2', cardTypeId: 'mule' },
                    { kind: 'card-drawn', seatId: 'p1', cardTypeId: 'informant' },
                    { kind: 'round-over', result: { reason: 'deck-out', winnerIds: ['p1'] } },
                    { kind: 'match-over', winnerId: 'p1' }
                ] as const
            )
                .map(event => beatForEvent(event))
                .filter((beat): beat is NonNullable<typeof beat> => beat !== null)
        );

        // `countdown-tick` is the one exception: it is driven by the countdown
        // itself rather than by a diffed event, and it plans to a no-op step.
        for (const beat of ALL) {
            if (beat === 'countdown-tick') continue;
            expect(selectable.has(beat), `${beat} is planned but unreachable`).toBe(true);
        }
    });

    it('returns a beat this file knows how to plan', () => {
        const beats = [
            { kind: 'log', entry: { kind: 'PLAY', turn: 1, actorId: 'p1', cardId: 'informant' } },
            { kind: 'log', entry: { kind: 'ELIMINATED', turn: 1, playerId: 'p2', cause: 'mule-forced' } },
            { kind: 'peek-gained', subjectId: 'p2', cardTypeId: 'mule' },
            { kind: 'card-drawn', seatId: 'p2' },
            { kind: 'round-over', result: { reason: 'deck-out', winnerIds: ['p1'] } },
            { kind: 'match-over', winnerId: 'p1' }
        ] as const;

        for (const event of beats) {
            const beat = beatForEvent(event)!;
            expect(motionPlan({ beat, reducedMotion: false }).steps.length, beat).toBeGreaterThan(0);
        }
    });
});
