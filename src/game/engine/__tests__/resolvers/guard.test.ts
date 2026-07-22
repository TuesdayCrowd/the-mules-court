import { describe, it, expect } from 'vitest';
import { resolveGuard } from '../../resolvers/guard';
import { makeDraft, makePlayers } from '../helpers';
import type { RoundDraft } from '../../types';

/** The actor has already discarded the played Informant, so their hand holds one card. */
const round = (): RoundDraft =>
    makeDraft({
        players: makePlayers({
            p0: { hand: ['magnifico#0'] },
            p1: { hand: ['mule#0'] }
        })
    });

describe('resolveGuard', () => {
    it('eliminates a target whose card was named correctly', () => {
        const draft = round();
        resolveGuard({ round: draft, actorId: 'p0', targetId: 'p1', guess: 'mule', playedCardId: 'informant' });
        expect(draft.players.p1.alive).toBe(false);
    });

    it('reveals the eliminated target\'s card publicly', () => {
        const draft = round();
        resolveGuard({ round: draft, actorId: 'p0', targetId: 'p1', guess: 'mule', playedCardId: 'informant' });
        expect(draft.players.p1.discardPile.map(e => e.cardId)).toEqual(['mule']);
        expect(draft.players.p1.discardValueTotal).toBe(8);
    });

    it('logs a hit', () => {
        const draft = round();
        resolveGuard({ round: draft, actorId: 'p0', targetId: 'p1', guess: 'mule', playedCardId: 'informant' });
        expect(draft.publicLog).toContainEqual({
            kind: 'GUESS',
            turn: draft.turnNumber,
            actorId: 'p0',
            targetId: 'p1',
            guessedCardId: 'mule',
            hit: true
        });
    });

    it('leaves a wrongly named target untouched', () => {
        const draft = round();
        resolveGuard({
            round: draft,
            actorId: 'p0',
            targetId: 'p1',
            guess: 'first-speaker',
            playedCardId: 'informant'
        });
        expect(draft.players.p1.alive).toBe(true);
        expect(draft.players.p1.hand).toEqual(['mule#0']);
        expect(draft.players.p1.discardPile).toEqual([]);
    });

    it('logs a miss', () => {
        const draft = round();
        resolveGuard({
            round: draft,
            actorId: 'p0',
            targetId: 'p1',
            guess: 'first-speaker',
            playedCardId: 'informant'
        });
        expect(draft.publicLog).toContainEqual({
            kind: 'GUESS',
            turn: draft.turnNumber,
            actorId: 'p0',
            targetId: 'p1',
            guessedCardId: 'first-speaker',
            hit: false
        });
    });

    it('fizzles harmlessly when no target was legal', () => {
        const draft = round();
        resolveGuard({ round: draft, actorId: 'p0', playedCardId: 'informant' });
        expect(draft.players.p1.alive).toBe(true);
        expect(draft.publicLog).toContainEqual({
            kind: 'FIZZLE',
            turn: draft.turnNumber,
            actorId: 'p0',
            cardId: 'informant'
        });
    });

    it('never touches the actor', () => {
        const draft = round();
        resolveGuard({ round: draft, actorId: 'p0', targetId: 'p1', guess: 'mule', playedCardId: 'informant' });
        expect(draft.players.p0.alive).toBe(true);
        expect(draft.players.p0.hand).toEqual(['magnifico#0']);
    });
});
