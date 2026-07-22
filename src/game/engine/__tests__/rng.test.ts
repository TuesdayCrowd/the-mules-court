import { describe, it, expect } from 'vitest';
import { seedRng, nextRng, shuffle } from '../rng';

describe('seedRng and nextRng', () => {
    it('produces the same stream for the same seed', () => {
        const a = nextRng(seedRng('mule'));
        const b = nextRng(seedRng('mule'));
        expect(a.value).toBe(b.value);
        expect(a.rng).toEqual(b.rng);
    });

    it('produces different streams for different seeds', () => {
        expect(nextRng(seedRng('alpha')).value).not.toBe(nextRng(seedRng('beta')).value);
    });

    it('advances the state on every draw', () => {
        const first = nextRng(seedRng('advance'));
        const second = nextRng(first.rng);
        expect(second.rng).not.toEqual(first.rng);
        expect(second.value).not.toBe(first.value);
    });

    it('returns values within [0, 1)', () => {
        let rng = seedRng('range');
        for (let i = 0; i < 500; i++) {
            const step = nextRng(rng);
            expect(step.value).toBeGreaterThanOrEqual(0);
            expect(step.value).toBeLessThan(1);
            rng = step.rng;
        }
    });

    it('never mutates the state handed to it', () => {
        const rng = seedRng('immutable');
        const snapshot = { ...rng };
        nextRng(rng);
        expect(rng).toEqual(snapshot);
    });

    it('survives a JSON round trip', () => {
        const rng = nextRng(seedRng('serialize')).rng;
        const revived = JSON.parse(JSON.stringify(rng));
        expect(nextRng(revived).value).toBe(nextRng(rng).value);
    });
});

describe('shuffle', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];

    it('shuffles deterministically for one seed', () => {
        const first = shuffle(input, seedRng('deck'));
        const second = shuffle(input, seedRng('deck'));
        expect(first.shuffled).toEqual(second.shuffled);
    });

    it('preserves every element', () => {
        const { shuffled } = shuffle(input, seedRng('deck'));
        expect([...shuffled].sort((a, b) => a - b)).toEqual(input);
    });

    it('leaves the input array untouched', () => {
        const original = [1, 2, 3];
        shuffle(original, seedRng('pure'));
        expect(original).toEqual([1, 2, 3]);
    });

    it('advances the rng so a second shuffle differs', () => {
        const first = shuffle(input, seedRng('chain'));
        const second = shuffle(input, first.rng);
        expect(second.shuffled).not.toEqual(first.shuffled);
    });

    it('actually reorders a 16-card deck', () => {
        const deck = Array.from({ length: 16 }, (_, i) => i);
        const { shuffled } = shuffle(deck, seedRng('sixteen'));
        expect(shuffled).not.toEqual(deck);
    });

    it('handles empty and single-element inputs', () => {
        expect(shuffle([], seedRng('empty')).shuffled).toEqual([]);
        expect(shuffle([7], seedRng('one')).shuffled).toEqual([7]);
    });
});

describe('engine determinism guard', () => {
    /**
     * Reads every engine source as raw text at transform time. Vite resolves this,
     * so the guard needs no filesystem access and no Node type declarations.
     * Test files are excluded: this very file names the forbidden calls.
     */
    const sources = import.meta.glob<string>(['../**/*.ts', '!../__tests__/**'], {
        query: '?raw',
        import: 'default',
        eager: true
    });

    it('reads the engine sources it is meant to guard', () => {
        expect(Object.keys(sources).length).toBeGreaterThan(0);
    });

    it('never calls Date.now or Math.random anywhere in the engine', () => {
        for (const [path, text] of Object.entries(sources)) {
            expect(text, `${path} must stay deterministic`).not.toMatch(/Date\.now|Math\.random/);
        }
    });
});
