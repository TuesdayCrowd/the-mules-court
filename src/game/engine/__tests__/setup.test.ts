import { describe, it, expect } from 'vitest';
import { createMatch } from '../setup';
import type { MatchState } from '../types';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);

/** Every one of the 16 cards must be somewhere, exactly once. */
function allCards(match: MatchState): string[] {
    const round = match.round;
    return [
        ...round.deckOrder,
        ...round.setAsideFaceDown,
        ...(round.setAsideFaceUp ? [round.setAsideFaceUp] : []),
        ...Object.values(round.players).flatMap(p => p.hand),
        ...Object.values(round.players).flatMap(p => p.discardPile.map(e => e.instanceId))
    ];
}

describe('createMatch — conservation', () => {
    it.each([2, 3, 4])('accounts for all 16 cards exactly once with %i players', count => {
        const match = createMatch(ids(count), 'seed');
        const cards = allCards(match);
        expect(cards).toHaveLength(16);
        expect(new Set(cards).size).toBe(16);
    });
});

describe('createMatch — the setup removal table', () => {
    it('removes 1 face-up and 2 face-down in a 2-player game', () => {
        const match = createMatch(ids(2), 'seed');
        expect(match.round.setAsideFaceUp).not.toBeNull();
        expect(match.round.setAsideFaceDown).toHaveLength(2);
    });

    it('removes 1 face-down and nothing face-up in a 3-player game', () => {
        const match = createMatch(ids(3), 'seed');
        expect(match.round.setAsideFaceUp).toBeNull();
        expect(match.round.setAsideFaceDown).toHaveLength(1);
    });

    it('removes no cards in a 4-player game', () => {
        const match = createMatch(ids(4), 'seed');
        expect(match.round.setAsideFaceUp).toBeNull();
        expect(match.round.setAsideFaceDown).toHaveLength(0);
    });

    // 16 - removed - one per player - the opening draw.
    it.each([
        [2, 10],
        [3, 11],
        [4, 11]
    ])('leaves %i players a deck of %i after the opening draw', (count, expected) => {
        expect(createMatch(ids(count), 'seed').round.deckOrder).toHaveLength(expected);
    });
});

describe('createMatch — the deal', () => {
    it.each([2, 3, 4])('gives the opening player two cards and everyone else one (%i players)', count => {
        const match = createMatch(ids(count), 'seed');
        const starter = match.round.seatOrder[match.round.currentPlayerIndex];
        for (const id of ids(count)) {
            expect(match.round.players[id].hand, id).toHaveLength(id === starter ? 2 : 1);
        }
    });

    it('starts everyone alive, unprotected and empty-handed of discards', () => {
        const match = createMatch(ids(3), 'seed');
        for (const player of Object.values(match.round.players)) {
            expect(player.alive).toBe(true);
            expect(player.protected).toBe(false);
            expect(player.discardPile).toEqual([]);
            expect(player.discardValueTotal).toBe(0);
        }
    });
});

describe('createMatch — match scaffolding', () => {
    it.each([
        [2, 7],
        [3, 5],
        [4, 4]
    ])('sets the token target for %i players to %i', (count, target) => {
        expect(createMatch(ids(count), 'seed').tokensToWin).toBe(target);
    });

    it('starts every player on zero tokens', () => {
        const match = createMatch(ids(4), 'seed');
        expect(match.players.map(p => p.tokens)).toEqual([0, 0, 0, 0]);
    });

    it('opens in normal mode with no sudden-death participants', () => {
        const match = createMatch(ids(3), 'seed');
        expect(match.mode).toBe('normal');
        expect(match.suddenDeathPlayers).toEqual([]);
    });

    it('retains the original seed for replay', () => {
        expect(createMatch(ids(2), 'my-seed').seed).toBe('my-seed');
    });

    it('opens with no winner, an empty action log and round 1', () => {
        const match = createMatch(ids(2), 'seed');
        expect(match.matchWinnerId).toBeNull();
        expect(match.actionLog).toEqual([]);
        expect(match.round.roundNumber).toBe(1);
        expect(match.round.phase).toBe('awaiting-play');
    });

    it('stamps lastStartedRound on the opening player only', () => {
        const match = createMatch(ids(3), 'seed');
        const starter = match.round.seatOrder[match.round.currentPlayerIndex];
        for (const player of match.players) {
            expect(player.lastStartedRound, player.id).toBe(player.id === starter ? 1 : 0);
        }
    });
});

describe('createMatch — determinism', () => {
    it('deals identically for the same seed', () => {
        expect(createMatch(ids(4), 'same')).toEqual(createMatch(ids(4), 'same'));
    });

    it('deals differently for different seeds', () => {
        const a = createMatch(ids(4), 'alpha').round.deckOrder;
        const b = createMatch(ids(4), 'beta').round.deckOrder;
        expect(a).not.toEqual(b);
    });

    it('survives a JSON round trip unchanged', () => {
        const match = createMatch(ids(3), 'json');
        expect(JSON.parse(JSON.stringify(match))).toEqual(match);
    });
});

describe('createMatch — rejects unsupported player counts', () => {
    it.each([0, 1, 5])('refuses %i players', count => {
        expect(() => createMatch(ids(count), 'seed')).toThrow();
    });

    it('refuses duplicate player ids', () => {
        expect(() => createMatch(['p0', 'p0'], 'seed')).toThrow();
    });
});
