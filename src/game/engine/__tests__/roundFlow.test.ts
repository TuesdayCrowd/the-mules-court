import { describe, it, expect } from 'vitest';
import { advanceTurn, checkRoundEnd } from '../roundFlow';
import { makeDraft, makePlayers } from './helpers';

describe('advanceTurn — rotation', () => {
    it('moves to the next seat', () => {
        const round = makeDraft({
            players: makePlayers({ p0: {}, p1: {}, p2: {} }),
            deckOrder: ['informant#0']
        });
        advanceTurn(round);
        expect(round.seatOrder[round.currentPlayerIndex]).toBe('p1');
    });

    it('wraps around the table', () => {
        const round = makeDraft({
            players: makePlayers({ p0: {}, p1: {} }),
            currentPlayerIndex: 1,
            deckOrder: ['informant#0']
        });
        advanceTurn(round);
        expect(round.seatOrder[round.currentPlayerIndex]).toBe('p0');
    });

    it('skips eliminated players', () => {
        const round = makeDraft({
            players: makePlayers({ p0: {}, p1: { alive: false }, p2: {} }),
            deckOrder: ['informant#0']
        });
        advanceTurn(round);
        expect(round.seatOrder[round.currentPlayerIndex]).toBe('p2');
    });

    it('increments the turn counter', () => {
        const round = makeDraft({ players: makePlayers({ p0: {}, p1: {} }), deckOrder: ['informant#0'] });
        const before = round.turnNumber;
        advanceTurn(round);
        expect(round.turnNumber).toBe(before + 1);
    });

    it('draws a card for the incoming player', () => {
        const round = makeDraft({
            players: makePlayers({ p0: {}, p1: { hand: ['mule#0'] } }),
            deckOrder: ['informant#0']
        });
        advanceTurn(round);
        expect(round.players.p1.hand).toEqual(['mule#0', 'informant#0']);
        expect(round.deckOrder).toEqual([]);
    });
});

describe('advanceTurn — the protection window', () => {
    // Shielded Mind lasts "until your next turn". Clearing it positionally, as the
    // first thing that happens when the player comes round again, matches the rule
    // exactly and survives eliminations reshaping the rotation mid-window.
    it('clears the incoming player\'s protection', () => {
        const round = makeDraft({
            players: makePlayers({ p0: {}, p1: { protected: true } }),
            deckOrder: ['informant#0']
        });
        advanceTurn(round);
        expect(round.players.p1.protected).toBe(false);
    });

    it('leaves everyone else\'s protection intact', () => {
        const round = makeDraft({
            players: makePlayers({ p0: { protected: true }, p1: {}, p2: { protected: true } }),
            deckOrder: ['informant#0']
        });
        advanceTurn(round);
        expect(round.players.p0.protected).toBe(true);
        expect(round.players.p2.protected).toBe(true);
    });

    it('holds protection through an intervening opponent turn', () => {
        const round = makeDraft({
            players: makePlayers({ p0: { protected: true }, p1: {}, p2: {} }),
            deckOrder: ['informant#0', 'magnifico#0']
        });
        advanceTurn(round); // p1's turn — p0 stays protected
        expect(round.players.p0.protected).toBe(true);
        advanceTurn(round); // p2's turn — p0 still protected
        expect(round.players.p0.protected).toBe(true);
    });
});

describe('checkRoundEnd — last survivor', () => {
    it('ends the round when only one player remains', () => {
        const round = makeDraft({
            players: makePlayers({ p0: { hand: ['mule#0'] }, p1: { alive: false } }),
            deckOrder: ['informant#0']
        });
        expect(checkRoundEnd(round)).toEqual({ reason: 'last-survivor', winnerIds: ['p0'] });
    });

    it('continues while two players remain and the deck holds cards', () => {
        const round = makeDraft({
            players: makePlayers({ p0: { hand: ['mule#0'] }, p1: { hand: ['informant#0'] } }),
            deckOrder: ['magnifico#0']
        });
        expect(checkRoundEnd(round)).toBeNull();
    });
});

describe('checkRoundEnd — deck-out', () => {
    const showdown = (
        p0: { hand: string[]; discardValueTotal?: number },
        p1: { hand: string[]; discardValueTotal?: number }
    ) =>
        makeDraft({
            players: makePlayers({ p0, p1 } as never),
            deckOrder: []
        });

    it('awards the round to the highest card', () => {
        const result = checkRoundEnd(showdown({ hand: ['mayor-indbur#0'] }, { hand: ['informant#0'] }));
        expect(result).toMatchObject({ reason: 'deck-out', winnerIds: ['p0'] });
    });

    it('reveals every survivor\'s hand', () => {
        const result = checkRoundEnd(showdown({ hand: ['mayor-indbur#0'] }, { hand: ['informant#0'] }));
        expect(result?.revealedHands).toEqual({ p0: 'mayor-indbur', p1: 'informant' });
    });

    it('breaks an equal-value tie on the discard total', () => {
        const result = checkRoundEnd(
            showdown(
                { hand: ['han-pritcher#0'], discardValueTotal: 3 },
                { hand: ['bail-channis#0'], discardValueTotal: 9 }
            )
        );
        expect(result?.winnerIds).toEqual(['p1']);
    });

    it('declares a shared win when hand value and discard total both tie', () => {
        const result = checkRoundEnd(
            showdown(
                { hand: ['han-pritcher#0'], discardValueTotal: 4 },
                { hand: ['bail-channis#0'], discardValueTotal: 4 }
            )
        );
        expect(result?.winnerIds).toEqual(['p0', 'p1']);
    });

    it('ranks an empty hand below every card', () => {
        const result = checkRoundEnd(showdown({ hand: [] }, { hand: ['informant#0'] }));
        expect(result?.winnerIds).toEqual(['p1']);
        expect(result?.revealedHands).toEqual({ p0: null, p1: 'informant' });
    });

    it('ignores eliminated players in the showdown', () => {
        const round = makeDraft({
            players: makePlayers({
                p0: { hand: ['informant#0'] },
                p1: { hand: [], alive: false },
                p2: { hand: ['han-pritcher#0'] }
            }),
            deckOrder: []
        });
        const result = checkRoundEnd(round);
        expect(result?.winnerIds).toEqual(['p2']);
        expect(result?.revealedHands).not.toHaveProperty('p1');
    });
});
