import { describe, it, expect } from 'vitest';
import { discardPlayedCard, eliminate } from '../discard';
import { makeDraft, makePlayers } from './helpers';

describe('eliminate', () => {
    it('marks the player dead', () => {
        const round = makeDraft({ players: makePlayers({ p0: { hand: ['mule#0'] }, p1: {} }) });
        eliminate(round, 'p0', 'guard');
        expect(round.players.p0.alive).toBe(false);
    });

    // Three of four candidate designs forgot this: an eliminated player's card
    // must become public, or the deduction surface and the deck-out tiebreak both
    // silently break.
    it('moves the eliminated player\'s held card to their public discard pile', () => {
        const round = makeDraft({ players: makePlayers({ p0: { hand: ['mule#0'] }, p1: {} }) });
        eliminate(round, 'p0', 'guard');
        expect(round.players.p0.hand).toEqual([]);
        expect(round.players.p0.discardPile.map(entry => entry.cardId)).toEqual(['mule']);
    });

    it('adds the revealed card\'s value to the running discard total', () => {
        const round = makeDraft({ players: makePlayers({ p0: { hand: ['mule#0'] }, p1: {} }) });
        eliminate(round, 'p0', 'baron');
        expect(round.players.p0.discardValueTotal).toBe(8);
    });

    it('preserves an existing discard total', () => {
        const round = makeDraft({
            players: makePlayers({ p0: { hand: ['informant#0'], discardValueTotal: 6 }, p1: {} })
        });
        eliminate(round, 'p0', 'guard');
        expect(round.players.p0.discardValueTotal).toBe(7);
    });

    it('handles an empty hand without inventing a discard', () => {
        const round = makeDraft({ players: makePlayers({ p0: { hand: [] }, p1: {} }) });
        eliminate(round, 'p0', 'guard');
        expect(round.players.p0.alive).toBe(false);
        expect(round.players.p0.discardPile).toEqual([]);
    });

    it('logs the elimination with its cause', () => {
        const round = makeDraft({ players: makePlayers({ p0: { hand: ['mule#0'] }, p1: {} }) });
        eliminate(round, 'p0', 'baron');
        expect(round.publicLog).toContainEqual({
            kind: 'ELIMINATED',
            turn: round.turnNumber,
            playerId: 'p0',
            cause: 'baron'
        });
    });

    it('leaves other players untouched', () => {
        const round = makeDraft({
            players: makePlayers({ p0: { hand: ['mule#0'] }, p1: { hand: ['informant#0'] } })
        });
        eliminate(round, 'p0', 'guard');
        expect(round.players.p1.alive).toBe(true);
        expect(round.players.p1.hand).toEqual(['informant#0']);
    });
});

describe('discardPlayedCard', () => {
    it('removes the played card from the hand', () => {
        const round = makeDraft({
            players: makePlayers({ p0: { hand: ['informant#0', 'magnifico#0'] }, p1: {} })
        });
        discardPlayedCard(round, 'p0', 'informant#0');
        expect(round.players.p0.hand).toEqual(['magnifico#0']);
    });

    it('appends the played card to the public discard pile', () => {
        const round = makeDraft({
            players: makePlayers({ p0: { hand: ['informant#0', 'magnifico#0'] }, p1: {} })
        });
        discardPlayedCard(round, 'p0', 'informant#0');
        expect(round.players.p0.discardPile).toEqual([
            { instanceId: 'informant#0', cardId: 'informant', value: 1 }
        ]);
    });

    it('adds the played card\'s value to the running total', () => {
        const round = makeDraft({
            players: makePlayers({ p0: { hand: ['mayor-indbur#0', 'informant#0'] }, p1: {} })
        });
        discardPlayedCard(round, 'p0', 'mayor-indbur#0');
        expect(round.players.p0.discardValueTotal).toBe(6);
    });

    it('removes only the named instance when duplicates are held', () => {
        const round = makeDraft({
            players: makePlayers({ p0: { hand: ['informant#0', 'informant#1'] }, p1: {} })
        });
        discardPlayedCard(round, 'p0', 'informant#1');
        expect(round.players.p0.hand).toEqual(['informant#0']);
    });

    it('logs the play', () => {
        const round = makeDraft({ players: makePlayers({ p0: { hand: ['informant#0'] }, p1: {} }) });
        discardPlayedCard(round, 'p0', 'informant#0');
        expect(round.publicLog).toContainEqual({
            kind: 'PLAY',
            turn: round.turnNumber,
            actorId: 'p0',
            cardId: 'informant'
        });
    });

    it('leaves an ordinary player alive', () => {
        const round = makeDraft({
            players: makePlayers({ p0: { hand: ['informant#0', 'magnifico#0'] }, p1: {} })
        });
        discardPlayedCard(round, 'p0', 'informant#0');
        expect(round.players.p0.alive).toBe(true);
    });
});

describe('discardPlayedCard — The Mule eliminates its player', () => {
    it('eliminates the player who plays The Mule', () => {
        const round = makeDraft({
            players: makePlayers({ p0: { hand: ['mule#0', 'informant#0'] }, p1: {} })
        });
        discardPlayedCard(round, 'p0', 'mule#0');
        expect(round.players.p0.alive).toBe(false);
    });

    it('puts BOTH the Mule and the remaining card into the discard pile', () => {
        const round = makeDraft({
            players: makePlayers({ p0: { hand: ['mule#0', 'informant#0'] }, p1: {} })
        });
        discardPlayedCard(round, 'p0', 'mule#0');
        expect(round.players.p0.hand).toEqual([]);
        expect(round.players.p0.discardPile.map(entry => entry.cardId)).toEqual(['mule', 'informant']);
        expect(round.players.p0.discardValueTotal).toBe(9);
    });

    it('records the voluntary cause', () => {
        const round = makeDraft({
            players: makePlayers({ p0: { hand: ['mule#0', 'informant#0'] }, p1: {} })
        });
        discardPlayedCard(round, 'p0', 'mule#0');
        expect(round.publicLog).toContainEqual({
            kind: 'ELIMINATED',
            turn: round.turnNumber,
            playerId: 'p0',
            cause: 'mule-voluntary'
        });
    });

    it('does not eliminate on any other card', () => {
        const round = makeDraft({
            players: makePlayers({ p0: { hand: ['first-speaker#0', 'informant#0'] }, p1: {} })
        });
        discardPlayedCard(round, 'p0', 'first-speaker#0');
        expect(round.players.p0.alive).toBe(true);
    });
});
