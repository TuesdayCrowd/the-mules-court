import { describe, it, expect } from 'vitest';
import { resolveHandmaid } from '../../resolvers/handmaid';
import { makeDraft, makePlayers } from '../helpers';

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
