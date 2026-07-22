import { describe, it, expect } from 'vitest';
import { resolvePrince } from '../../resolvers/prince';
import { resolveHandmaid } from '../../resolvers/handmaid';
import { resolveKing } from '../../resolvers/king';
import { makeDraft, makePlayers } from '../helpers';
import type { RoundDraft } from '../../types';

describe('resolveHandmaid', () => {
    it('protects the actor', () => {
        const draft = makeDraft({ players: makePlayers({ p0: { hand: ['mule#0'] }, p1: {} }) });
        resolveHandmaid({ round: draft, actorId: 'p0', playedCardId: 'shielded-mind' });
        expect(draft.players.p0.protected).toBe(true);
    });

    it('leaves everyone else unprotected', () => {
        const draft = makeDraft({ players: makePlayers({ p0: { hand: ['mule#0'] }, p1: {} }) });
        resolveHandmaid({ round: draft, actorId: 'p0', playedCardId: 'shielded-mind' });
        expect(draft.players.p1.protected).toBe(false);
    });

    it('logs the protection', () => {
        const draft = makeDraft({ players: makePlayers({ p0: { hand: ['mule#0'] }, p1: {} }) });
        resolveHandmaid({ round: draft, actorId: 'p0', playedCardId: 'shielded-mind' });
        expect(draft.publicLog).toContainEqual({
            kind: 'PROTECTED',
            turn: draft.turnNumber,
            actorId: 'p0'
        });
    });
});

describe('resolvePrince — targeting an opponent', () => {
    const round = (): RoundDraft =>
        makeDraft({
            players: makePlayers({ p0: { hand: ['magnifico#0'] }, p1: { hand: ['informant#0'] } }),
            deckOrder: ['mayor-indbur#0']
        });

    it('discards the target\'s card publicly', () => {
        const draft = round();
        resolvePrince({ round: draft, actorId: 'p0', targetId: 'p1', playedCardId: 'bayta-darell' });
        expect(draft.players.p1.discardPile.map(e => e.cardId)).toEqual(['informant']);
        expect(draft.players.p1.discardValueTotal).toBe(1);
    });

    it('draws a replacement from the deck', () => {
        const draft = round();
        resolvePrince({ round: draft, actorId: 'p0', targetId: 'p1', playedCardId: 'bayta-darell' });
        expect(draft.players.p1.hand).toEqual(['mayor-indbur#0']);
        expect(draft.deckOrder).toEqual([]);
    });

    it('logs where the replacement came from', () => {
        const draft = round();
        resolvePrince({ round: draft, actorId: 'p0', targetId: 'p1', playedCardId: 'bayta-darell' });
        expect(draft.publicLog).toContainEqual({
            kind: 'REDREW',
            turn: draft.turnNumber,
            actorId: 'p0',
            targetId: 'p1',
            drewFrom: 'deck'
        });
    });

    it('leaves the target alive', () => {
        const draft = round();
        resolvePrince({ round: draft, actorId: 'p0', targetId: 'p1', playedCardId: 'bayta-darell' });
        expect(draft.players.p1.alive).toBe(true);
    });
});

describe('resolvePrince — targeting itself', () => {
    // The played Prince is already discarded, so the actor's remaining card is the
    // OTHER card. A resolver reading hand[0] before the discard would grab the
    // Prince itself and discard the wrong card.
    it('discards the actor\'s remaining card, never the Prince', () => {
        const draft = makeDraft({
            players: makePlayers({ p0: { hand: ['magnifico#0'] }, p1: {} }),
            deckOrder: ['informant#0']
        });
        resolvePrince({ round: draft, actorId: 'p0', targetId: 'p0', playedCardId: 'bayta-darell' });
        expect(draft.players.p0.discardPile.map(e => e.cardId)).toEqual(['magnifico']);
        expect(draft.players.p0.hand).toEqual(['informant#0']);
    });

    it('keeps the actor alive when the discarded card is harmless', () => {
        const draft = makeDraft({
            players: makePlayers({ p0: { hand: ['magnifico#0'] }, p1: {} }),
            deckOrder: ['informant#0']
        });
        resolvePrince({ round: draft, actorId: 'p0', targetId: 'p0', playedCardId: 'bayta-darell' });
        expect(draft.players.p0.alive).toBe(true);
    });
});

describe('resolvePrince — forcing a Mule discard', () => {
    it('eliminates the target who discards The Mule', () => {
        const draft = makeDraft({
            players: makePlayers({ p0: { hand: ['magnifico#0'] }, p1: { hand: ['mule#0'] } }),
            deckOrder: ['informant#0']
        });
        resolvePrince({ round: draft, actorId: 'p0', targetId: 'p1', playedCardId: 'toran-darell' });
        expect(draft.players.p1.alive).toBe(false);
    });

    // An eliminated player must not silently consume a card nobody will ever see;
    // doing so also skews exactly when the deck runs out.
    it('does NOT draw a replacement for an eliminated target', () => {
        const draft = makeDraft({
            players: makePlayers({ p0: { hand: ['magnifico#0'] }, p1: { hand: ['mule#0'] } }),
            deckOrder: ['informant#0']
        });
        resolvePrince({ round: draft, actorId: 'p0', targetId: 'p1', playedCardId: 'toran-darell' });
        expect(draft.players.p1.hand).toEqual([]);
        expect(draft.deckOrder).toEqual(['informant#0']);
    });

    it('records the forced cause', () => {
        const draft = makeDraft({
            players: makePlayers({ p0: { hand: ['magnifico#0'] }, p1: { hand: ['mule#0'] } }),
            deckOrder: ['informant#0']
        });
        resolvePrince({ round: draft, actorId: 'p0', targetId: 'p1', playedCardId: 'toran-darell' });
        expect(draft.publicLog).toContainEqual({
            kind: 'ELIMINATED',
            turn: draft.turnNumber,
            playerId: 'p1',
            cause: 'mule-forced'
        });
    });

    it('reveals the discarded Mule publicly', () => {
        const draft = makeDraft({
            players: makePlayers({ p0: { hand: ['magnifico#0'] }, p1: { hand: ['mule#0'] } }),
            deckOrder: ['informant#0']
        });
        resolvePrince({ round: draft, actorId: 'p0', targetId: 'p1', playedCardId: 'toran-darell' });
        expect(draft.players.p1.discardPile.map(e => e.cardId)).toEqual(['mule']);
    });
});

describe('resolvePrince — an empty deck', () => {
    it('draws the face-down set-aside card when the deck is empty', () => {
        const draft = makeDraft({
            players: makePlayers({ p0: { hand: ['magnifico#0'] }, p1: { hand: ['informant#0'] } }),
            deckOrder: [],
            setAsideFaceDown: ['first-speaker#0']
        });
        resolvePrince({ round: draft, actorId: 'p0', targetId: 'p1', playedCardId: 'bayta-darell' });
        expect(draft.players.p1.hand).toEqual(['first-speaker#0']);
        expect(draft.setAsideFaceDown).toEqual([]);
        expect(draft.publicLog).toContainEqual(
            expect.objectContaining({ kind: 'REDREW', drewFrom: 'set-aside' })
        );
    });

    // Four-player games remove no cards, so there is no set-aside to fall back on.
    it('leaves an empty hand when neither deck nor set-aside has a card', () => {
        const draft = makeDraft({
            players: makePlayers({ p0: { hand: ['magnifico#0'] }, p1: { hand: ['informant#0'] } }),
            deckOrder: [],
            setAsideFaceDown: []
        });
        resolvePrince({ round: draft, actorId: 'p0', targetId: 'p1', playedCardId: 'bayta-darell' });
        expect(draft.players.p1.hand).toEqual([]);
        expect(draft.players.p1.alive).toBe(true);
        expect(draft.publicLog).toContainEqual(
            expect.objectContaining({ kind: 'REDREW', drewFrom: 'none' })
        );
    });
});

describe('resolveKing', () => {
    const round = (): RoundDraft =>
        makeDraft({
            players: makePlayers({ p0: { hand: ['magnifico#0'] }, p1: { hand: ['informant#0'] } })
        });

    it('swaps the two single-card hands', () => {
        const draft = round();
        resolveKing({ round: draft, actorId: 'p0', targetId: 'p1', playedCardId: 'mayor-indbur' });
        expect(draft.players.p0.hand).toEqual(['informant#0']);
        expect(draft.players.p1.hand).toEqual(['magnifico#0']);
    });

    it('creates no peek records, since each trader simply holds a new card', () => {
        const draft = round();
        resolveKing({ round: draft, actorId: 'p0', targetId: 'p1', playedCardId: 'mayor-indbur' });
        expect(draft.privateKnowledge).toEqual([]);
    });

    it('logs the trade without naming either card', () => {
        const draft = round();
        resolveKing({ round: draft, actorId: 'p0', targetId: 'p1', playedCardId: 'mayor-indbur' });
        expect(draft.publicLog).toContainEqual({
            kind: 'TRADED',
            turn: draft.turnNumber,
            actorId: 'p0',
            targetId: 'p1'
        });
        expect(JSON.stringify(draft.publicLog)).not.toContain('magnifico');
    });

    it('eliminates nobody', () => {
        const draft = round();
        resolveKing({ round: draft, actorId: 'p0', targetId: 'p1', playedCardId: 'mayor-indbur' });
        expect(draft.players.p0.alive).toBe(true);
        expect(draft.players.p1.alive).toBe(true);
    });

    it('fizzles when no target was legal', () => {
        const draft = round();
        resolveKing({ round: draft, actorId: 'p0', playedCardId: 'mayor-indbur' });
        expect(draft.players.p0.hand).toEqual(['magnifico#0']);
        expect(draft.publicLog).toContainEqual({
            kind: 'FIZZLE',
            turn: draft.turnNumber,
            actorId: 'p0',
            cardId: 'mayor-indbur'
        });
    });
});
