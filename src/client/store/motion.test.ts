import { describe, expect, it } from 'vitest';
import type { BeatName } from './motion';
import { beatDurationMs, motionPlan } from './motion';

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
