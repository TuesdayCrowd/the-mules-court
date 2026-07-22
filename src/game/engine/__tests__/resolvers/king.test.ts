import { describe, it, expect } from 'vitest';
import { resolveKing } from '../../resolvers/king';
import { makeDraft, makePlayers } from '../helpers';
import type { RoundDraft } from '../../types';

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
