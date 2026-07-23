import { describe, it, expect } from 'vitest';
import { reduce, startNextRound } from '../reduce';
import { createMatch } from '../setup';
import type { CardInstanceId, MatchState, PlayCardAction, PlayerId } from '../types';

const play = (
    playerId: PlayerId,
    cardInstanceId: CardInstanceId,
    extra: Partial<PlayCardAction> = {}
): PlayCardAction => ({ type: 'PLAY_CARD', playerId, cardInstanceId, ...extra });

/** Rebuilds a match with an exact round state, bypassing the shuffle. */
function rig(match: MatchState, round: Partial<MatchState['round']>): MatchState {
    return { ...match, round: { ...match.round, ...round } };
}

const base = () => createMatch(['p0', 'p1'], 'reduce-seed');

const withHands = (hands: Record<PlayerId, CardInstanceId[]>, deck: CardInstanceId[] = []) => {
    const match = base();
    const players = Object.fromEntries(
        Object.entries(match.round.players).map(([id, p]) => [id, { ...p, hand: hands[id] ?? p.hand }])
    );
    return rig(match, { players, deckOrder: deck, seatOrder: ['p0', 'p1'], currentPlayerIndex: 0 });
};

describe('reduce — rejection', () => {
    it('rejects an illegal action without changing state', () => {
        const match = withHands({ p0: ['informant#0', 'magnifico#0'], p1: ['mule#0'] }, ['han-pritcher#0']);
        const result = reduce(match, play('p1', 'mule#0'));
        expect(result.ok).toBe(false);
    });

    it('leaves the original state untouched on success', () => {
        const match = withHands({ p0: ['informant#0', 'magnifico#0'], p1: ['mule#0'] }, ['han-pritcher#0']);
        const snapshot = JSON.parse(JSON.stringify(match));
        reduce(match, play('p0', 'informant#0', { target: 'p1', guess: 8 }));
        expect(JSON.parse(JSON.stringify(match))).toEqual(snapshot);
    });
});

describe('reduce — the pipeline', () => {
    it('discards the played card before resolving its effect', () => {
        const match = withHands({ p0: ['informant#0', 'magnifico#0'], p1: ['first-speaker#0'] }, ['mule#0']);
        const result = reduce(match, play('p0', 'informant#0', { target: 'p1', guess: 8 }));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.state.round.players.p0.discardPile.map(e => e.cardId)).toEqual(['informant']);
    });

    // The wrong-card regression. Baron must compare the actor's OTHER card, not
    // the Baron it just played. A third player keeps the round alive so the
    // finished-round state stays inspectable.
    it('compares the actor\'s remaining card in a Baron duel, never the played Baron', () => {
        const match = createMatch(['p0', 'p1', 'p2'], 'baron-seed');
        const rigged = rig(match, {
            seatOrder: ['p0', 'p1', 'p2'],
            currentPlayerIndex: 0,
            deckOrder: ['mule#0', 'shielded-mind#0'],
            players: {
                p0: { ...match.round.players.p0, hand: ['ebling-mis#0', 'informant#0'] },
                p1: { ...match.round.players.p1, hand: ['mayor-indbur#0'] },
                p2: { ...match.round.players.p2, hand: ['magnifico#0'] }
            }
        });
        const result = reduce(rigged, play('p0', 'ebling-mis#0', { target: 'p1' }));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // Informant (1) loses to Mayor Indbur (6). The recorded reveal proves the
        // comparison used the Informant, not the played Baron (3).
        expect(result.state.round.players.p0.alive).toBe(false);
        expect(result.state.round.privateKnowledge).toContainEqual(
            expect.objectContaining({ viewerId: 'p1', subjectId: 'p0', cardTypeId: 'informant' })
        );
    });

    it('appends the action to the replay log', () => {
        const match = withHands({ p0: ['informant#0', 'magnifico#0'], p1: ['first-speaker#0'] }, ['mule#0']);
        const action = play('p0', 'informant#0', { target: 'p1', guess: 8 });
        const result = reduce(match, action);
        if (!result.ok) return;
        expect(result.state.actionLog).toEqual([action]);
    });

    it('passes the turn and draws for the next player', () => {
        const match = withHands({ p0: ['informant#0', 'magnifico#0'], p1: ['first-speaker#0'] }, ['mule#0']);
        const result = reduce(match, play('p0', 'informant#0', { target: 'p1', guess: 5 }));
        if (!result.ok) return;
        expect(result.state.round.seatOrder[result.state.round.currentPlayerIndex]).toBe('p1');
        expect(result.state.round.players.p1.hand).toEqual(['first-speaker#0', 'mule#0']);
    });
});

describe('reduce — ending a round', () => {
    it('awards a token to the last survivor', () => {
        const match = withHands({ p0: ['informant#0', 'magnifico#0'], p1: ['mule#0'] }, ['han-pritcher#0']);
        const result = reduce(match, play('p0', 'informant#0', { target: 'p1', guess: 8 }));
        if (!result.ok) return;
        expect(result.state.players.find(p => p.id === 'p0')?.tokens).toBe(1);
        expect(result.state.players.find(p => p.id === 'p1')?.tokens).toBe(0);
    });

    // The round stops at 'round-over' so clients can see the showdown before the
    // table is swept. Dealing straight through would make it unobservable.
    it('halts at round-over carrying its result rather than dealing on', () => {
        const match = withHands({ p0: ['informant#0', 'magnifico#0'], p1: ['mule#0'] }, ['han-pritcher#0']);
        const result = reduce(match, play('p0', 'informant#0', { target: 'p1', guess: 8 }));
        if (!result.ok) return;
        expect(result.state.round.phase).toBe('round-over');
        expect(result.state.round.roundResult).toEqual({ reason: 'last-survivor', winnerIds: ['p0'] });
        expect(result.state.round.roundNumber).toBe(1);
        expect(result.state.matchWinnerId).toBeNull();
    });

    it('refuses further plays once the round is over', () => {
        const match = withHands({ p0: ['informant#0', 'magnifico#0'], p1: ['mule#0'] }, ['han-pritcher#0']);
        const first = reduce(match, play('p0', 'informant#0', { target: 'p1', guess: 8 }));
        if (!first.ok) return;
        expect(reduce(first.state, play('p0', 'magnifico#0')).ok).toBe(false);
    });
});

describe('startNextRound', () => {
    const finishedRound = () => {
        const match = withHands({ p0: ['informant#0', 'magnifico#0'], p1: ['mule#0'] }, ['han-pritcher#0']);
        const result = reduce(match, play('p0', 'informant#0', { target: 'p1', guess: 8 }));
        if (!result.ok) throw new Error('setup failed');
        return result.state;
    };

    it('deals the next round', () => {
        const next = startNextRound(finishedRound());
        expect(next.round.roundNumber).toBe(2);
        expect(next.round.phase).toBe('awaiting-play');
    });

    it('lets the previous winner lead', () => {
        const next = startNextRound(finishedRound());
        expect(next.round.seatOrder[next.round.currentPlayerIndex]).toBe('p0');
        expect(next.players.find(p => p.id === 'p0')?.lastStartedRound).toBe(2);
    });

    it('keeps token totals across the round boundary', () => {
        const next = startNextRound(finishedRound());
        expect(next.players.find(p => p.id === 'p0')?.tokens).toBe(1);
    });

    it('refuses while a round is still in progress', () => {
        const match = withHands({ p0: ['informant#0', 'magnifico#0'], p1: ['mule#0'] }, ['han-pritcher#0']);
        expect(() => startNextRound(match)).toThrow();
    });
});

describe('reduce — ending a match', () => {
    /** Puts a player one token short of victory. */
    const onePointShort = (leaderId: PlayerId) => {
        const match = withHands({ p0: ['informant#0', 'magnifico#0'], p1: ['mule#0'] }, ['han-pritcher#0']);
        return {
            ...match,
            players: match.players.map(p => (p.id === leaderId ? { ...p, tokens: 6 } : p))
        };
    };

    it('declares a winner on reaching the token target', () => {
        const result = reduce(onePointShort('p0'), play('p0', 'informant#0', { target: 'p1', guess: 8 }));
        if (!result.ok) return;
        expect(result.state.matchWinnerId).toBe('p0');
    });

    it('refuses further play once the match is over', () => {
        const first = reduce(onePointShort('p0'), play('p0', 'informant#0', { target: 'p1', guess: 8 }));
        if (!first.ok) return;
        expect(reduce(first.state, play('p0', 'magnifico#0')).ok).toBe(false);
    });

    it('refuses to deal another round once the match is decided', () => {
        const first = reduce(onePointShort('p0'), play('p0', 'informant#0', { target: 'p1', guess: 8 }));
        if (!first.ok) return;
        expect(() => startNextRound(first.state)).toThrow();
    });
});

describe('reduce — determinism', () => {
    it('produces identical state for identical input', () => {
        const match = withHands({ p0: ['informant#0', 'magnifico#0'], p1: ['first-speaker#0'] }, ['mule#0']);
        const action = play('p0', 'informant#0', { target: 'p1', guess: 8 });
        expect(reduce(match, action)).toEqual(reduce(match, action));
    });

    it('keeps state JSON-serializable', () => {
        const match = withHands({ p0: ['informant#0', 'magnifico#0'], p1: ['first-speaker#0'] }, ['mule#0']);
        const result = reduce(match, play('p0', 'informant#0', { target: 'p1', guess: 8 }));
        if (!result.ok) return;
        expect(JSON.parse(JSON.stringify(result.state))).toEqual(result.state);
    });
});
