import { describe, expect, it } from 'vitest';
import type { BeatName } from './motion';
import { beatDurationMs, beatForEvent, motionPlan } from './motion';

const ALL: BeatName[] = ['mule', 'elimination', 'peek', 'play', 'countdown-tick', 'token-award', 'victory'];

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
            { kind: 'round-over', result: { reason: 'deck-out', winnerIds: ['p1'] } },
            { kind: 'match-over', winnerId: 'p1' }
        ] as const;

        for (const event of beats) {
            const beat = beatForEvent(event)!;
            expect(motionPlan({ beat, reducedMotion: false }).steps.length, beat).toBeGreaterThan(0);
        }
    });
});
