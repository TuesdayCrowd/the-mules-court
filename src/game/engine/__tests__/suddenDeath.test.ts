import { describe, it, expect } from 'vitest';
import { reduce, startNextRound } from '../reduce';
import { createMatch } from '../setup';
import type { MatchState, PlayCardAction } from '../types';

/**
 * Builds a two-player match where the next play ends the round in a shared win:
 * equal hand values AND equal discard totals at deck-out.
 */
function tiedAtMatchPoint(tokens: number): MatchState {
    const match = createMatch(['p0', 'p1'], 'sudden-seed');
    return {
        ...match,
        players: match.players.map(p => ({ ...p, tokens })),
        round: {
            ...match.round,
            seatOrder: ['p0', 'p1'],
            currentPlayerIndex: 0,
            deckOrder: [],
            players: {
                p0: {
                    ...match.round.players.p0,
                    hand: ['shielded-mind#0', 'han-pritcher#0'],
                    discardValueTotal: 0
                },
                p1: {
                    ...match.round.players.p1,
                    hand: ['bail-channis#0'],
                    discardValueTotal: 4
                }
            }
        }
    };
}

const playShield: PlayCardAction = {
    type: 'PLAY_CARD',
    playerId: 'p0',
    cardInstanceId: 'shielded-mind#0'
};

describe('a shared win at deck-out', () => {
    it('awards a token to every tied player', () => {
        const result = reduce(tiedAtMatchPoint(0), playShield);
        if (!result.ok) throw new Error('expected a legal play');
        expect(result.state.round.roundResult).toMatchObject({
            reason: 'deck-out',
            winnerIds: ['p0', 'p1']
        });
        expect(result.state.players.map(p => p.tokens)).toEqual([1, 1]);
    });

    it('reveals both showdown hands', () => {
        const result = reduce(tiedAtMatchPoint(0), playShield);
        if (!result.ok) throw new Error('expected a legal play');
        expect(result.state.round.roundResult?.revealedHands).toEqual({
            p0: 'han-pritcher',
            p1: 'bail-channis'
        });
    });
});

describe('reaching the token target together', () => {
    // Two players crossing the line at once do not end the match; they play on.
    const atTarget = () => {
        const result = reduce(tiedAtMatchPoint(6), playShield);
        if (!result.ok) throw new Error('expected a legal play');
        return result.state;
    };

    it('declares no winner yet', () => {
        expect(atTarget().matchWinnerId).toBeNull();
    });

    it('carries both players to the token target', () => {
        expect(atTarget().players.map(p => p.tokens)).toEqual([7, 7]);
    });

    it('enters sudden death with the tied leaders as participants', () => {
        const state = atTarget();
        expect(state.mode).toBe('sudden-death');
        expect(state.suddenDeathPlayers).toEqual(['p0', 'p1']);
    });

    it('deals the sudden-death round to those players only', () => {
        const next = startNextRound(atTarget());
        expect(Object.keys(next.round.players).sort()).toEqual(['p0', 'p1']);
        expect(next.round.roundNumber).toBe(2);
        expect(next.mode).toBe('sudden-death');
    });

    it('breaks the round-start tie toward whoever most recently led', () => {
        // p0 led round 1, so p0 leads the sudden-death round.
        const next = startNextRound(atTarget());
        expect(next.round.seatOrder[next.round.currentPlayerIndex]).toBe('p0');
    });
});

describe('resolving sudden death', () => {
    /** A sudden-death round in progress between the two tied leaders. */
    const suddenDeathRound = (): MatchState => {
        const entered = reduce(tiedAtMatchPoint(6), playShield);
        if (!entered.ok) throw new Error('expected a legal play');
        const dealt = startNextRound(entered.state);
        return {
            ...dealt,
            round: {
                ...dealt.round,
                seatOrder: ['p0', 'p1'],
                currentPlayerIndex: 0,
                deckOrder: ['magnifico#0'],
                players: {
                    p0: { ...dealt.round.players.p0, hand: ['informant#0', 'first-speaker#0'] },
                    p1: { ...dealt.round.players.p1, hand: ['mule#0'] }
                }
            }
        };
    };

    it('ends the match on a clean sudden-death win', () => {
        const result = reduce(suddenDeathRound(), {
            type: 'PLAY_CARD',
            playerId: 'p0',
            cardInstanceId: 'informant#0',
            target: 'p1',
            guess: 'mule'
        });
        if (!result.ok) throw new Error('expected a legal play');
        expect(result.state.round.roundResult?.winnerIds).toEqual(['p0']);
        expect(result.state.matchWinnerId).toBe('p0');
    });

    it('keeps playing when sudden death ties again', () => {
        const tied: MatchState = {
            ...suddenDeathRound(),
            round: {
                ...suddenDeathRound().round,
                deckOrder: [],
                players: {
                    ...suddenDeathRound().round.players,
                    p0: {
                        ...suddenDeathRound().round.players.p0,
                        hand: ['shielded-mind#1', 'han-pritcher#0'],
                        discardValueTotal: 0
                    },
                    p1: {
                        ...suddenDeathRound().round.players.p1,
                        hand: ['bail-channis#0'],
                        discardValueTotal: 4
                    }
                }
            }
        };
        const result = reduce(tied, {
            type: 'PLAY_CARD',
            playerId: 'p0',
            cardInstanceId: 'shielded-mind#1'
        });
        if (!result.ok) throw new Error('expected a legal play');
        expect(result.state.matchWinnerId).toBeNull();
        expect(result.state.mode).toBe('sudden-death');
        expect(result.state.suddenDeathPlayers).toEqual(['p0', 'p1']);
        expect(() => startNextRound(result.state)).not.toThrow();
    });
});
