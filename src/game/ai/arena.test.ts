import { describe, expect, test } from 'vitest';
import type { Policy } from './policy';
import { randomPolicy } from './randomPolicy';
import { runArena, wilsonInterval } from './arena';

const SEATS = ['p1', 'p2', 'p3', 'p4'];

function allRandom(): Record<string, Policy> {
    return Object.fromEntries(SEATS.map(id => [id, randomPolicy]));
}

const seeds = (count: number) => Array.from({ length: count }, (_, i) => `arena-${i}`);

describe('wilsonInterval', () => {
    test('brackets the observed rate', () => {
        const { low, high } = wilsonInterval(30, 100);

        expect(low).toBeLessThan(0.3);
        expect(high).toBeGreaterThan(0.3);
    });

    test('narrows as the sample grows', () => {
        const small = wilsonInterval(30, 100);
        const large = wilsonInterval(3000, 10000);

        expect(large.high - large.low).toBeLessThan(small.high - small.low);
    });

    test('reports the full range when nothing was played', () => {
        expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
    });
});

describe('runArena', () => {
    test('plays one match per seed', () => {
        const report = runArena({ seats: SEATS, policies: allRandom(), seeds: seeds(20) });

        expect(report.matches).toBe(20);
    });

    test('accounts for every match in exactly one seat win', () => {
        const report = runArena({ seats: SEATS, policies: allRandom(), seeds: seeds(20) });
        const wins = report.seats.reduce((sum, seat) => sum + seat.wins, 0);

        expect(wins).toBe(20);
    });

    test('reports an interval around each seat rate', () => {
        const report = runArena({ seats: SEATS, policies: allRandom(), seeds: seeds(20) });

        for (const seat of report.seats) {
            expect(seat.rate).toBeGreaterThanOrEqual(seat.low);
            expect(seat.rate).toBeLessThanOrEqual(seat.high);
        }
    });

    test('names the policy that occupied each seat', () => {
        const report = runArena({ seats: SEATS, policies: allRandom(), seeds: seeds(4) });

        expect(report.seats.map(seat => seat.policyId)).toEqual(SEATS.map(() => 'random'));
    });

    test('spreads wins across all four seats', () => {
        // Deliberately loose. Turn order is a genuine edge in this game, so a
        // tight band around 25% would be asserting fairness the game does not
        // promise. This catches the gross seating bug — one seat starved or one
        // seat winning nearly everything — and claims nothing finer.
        const report = runArena({ seats: SEATS, policies: allRandom(), seeds: seeds(400) });

        for (const seat of report.seats) {
            expect(seat.rate).toBeGreaterThan(0.1);
            expect(seat.rate).toBeLessThan(0.45);
        }
    });
});
