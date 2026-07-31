import { describe, expect, test } from 'vitest';
import { makeRng, pick } from './rng';

describe('makeRng', () => {
    test('replays the same stream from the same seed', () => {
        const first = makeRng('trantor');
        const second = makeRng('trantor');

        const a = [first.next(), first.next(), first.next()];
        const b = [second.next(), second.next(), second.next()];

        expect(a).toEqual(b);
    });

    test('produces a different stream from a different seed', () => {
        const first = makeRng('trantor');
        const second = makeRng('terminus');

        expect(first.next()).not.toEqual(second.next());
    });

    test('draws every value inside [0, 1)', () => {
        const rng = makeRng('kalgan');

        for (let i = 0; i < 500; i++) {
            const value = rng.next();
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThan(1);
        }
    });
});

describe('pick', () => {
    test('returns a member of the array', () => {
        const rng = makeRng('pick');
        const items = ['a', 'b', 'c', 'd'];

        for (let i = 0; i < 200; i++) {
            expect(items).toContain(pick(items, rng));
        }
    });

    test('reaches every member given enough draws', () => {
        const rng = makeRng('coverage');
        const items = ['a', 'b', 'c'];
        const seen = new Set(Array.from({ length: 200 }, () => pick(items, rng)));

        expect(seen.size).toBe(3);
    });

    test('returns undefined for an empty array', () => {
        expect(pick([], makeRng('empty'))).toBeUndefined();
    });
});
