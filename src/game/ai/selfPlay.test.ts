import { describe, expect, test } from 'vitest';
import type { Policy } from './policy';
import { randomPolicy } from './randomPolicy';
import { playMatch } from './selfPlay';

const SEATS = ['p1', 'p2', 'p3', 'p4'];

function allRandom(): Record<string, Policy> {
    return Object.fromEntries(SEATS.map(id => [id, randomPolicy]));
}

describe('playMatch', () => {
    test('drives a four-player match to a single winner', () => {
        const outcome = playMatch({ seats: SEATS, policies: allRandom(), seed: 'match-1' });

        expect(SEATS).toContain(outcome.winnerId);
    });

    test('awards the winner the tokens the match required', () => {
        const outcome = playMatch({ seats: SEATS, policies: allRandom(), seed: 'match-1' });

        // Four players play to four devotion tokens (SETUP_TABLE).
        expect(outcome.tokens[outcome.winnerId!]).toBeGreaterThanOrEqual(4);
    });

    test('replays identically from the same seed', () => {
        const first = playMatch({ seats: SEATS, policies: allRandom(), seed: 'replay' });
        const second = playMatch({ seats: SEATS, policies: allRandom(), seed: 'replay' });

        expect(second).toEqual(first);
    });

    test('reaches different outcomes across seeds', () => {
        const outcomes = new Set(
            Array.from({ length: 40 }, (_, i) =>
                playMatch({ seats: SEATS, policies: allRandom(), seed: `seed-${i}` }).winnerId
            )
        );

        expect(outcomes.size).toBeGreaterThan(1);
    });

    test('refuses a policy that proposes a card the engine did not offer', () => {
        // A card that cannot exist: the deck holds five Informants, #0 to #4.
        // Naming a real card risks the seed dealing it, which would make the
        // play legal and the test silently vacuous.
        const cheat: Policy = {
            id: 'cheat',
            decide: () => ({ cardInstanceId: 'informant#99' })
        };
        const policies = { ...allRandom(), p1: cheat };

        expect(() => playMatch({ seats: SEATS, policies, seed: 'cheat' })).toThrow(/p1/);
    });

    test('refuses a policy that declines to act while holding the turn', () => {
        const mute: Policy = { id: 'mute', decide: () => null };
        const policies = { ...allRandom(), p1: mute };

        expect(() => playMatch({ seats: SEATS, policies, seed: 'mute' })).toThrow(/p1/);
    });
});
