import { describe, it, expect } from 'vitest';
import { resolvePriest } from '../../resolvers/priest';
import { makeDraft, makePlayers } from '../helpers';
import type { RoundDraft } from '../../types';

const round = (): RoundDraft =>
    makeDraft({
        players: makePlayers({
            p0: { hand: ['magnifico#0'] },
            p1: { hand: ['mule#0'] }
        })
    });

describe('resolvePriest', () => {
    it('records exactly one peek', () => {
        const draft = round();
        resolvePriest({ round: draft, actorId: 'p0', targetId: 'p1', playedCardId: 'han-pritcher' });
        expect(draft.privateKnowledge).toHaveLength(1);
    });

    it('binds the peek to the viewer, the subject and the exact instance', () => {
        const draft = round();
        resolvePriest({ round: draft, actorId: 'p0', targetId: 'p1', playedCardId: 'han-pritcher' });
        expect(draft.privateKnowledge[0]).toMatchObject({
            kind: 'priest',
            viewerId: 'p0',
            subjectId: 'p1',
            cardInstanceId: 'mule#0',
            cardTypeId: 'mule',
            roundNumber: draft.roundNumber
        });
    });

    it('leaves the target\'s hand untouched', () => {
        const draft = round();
        resolvePriest({ round: draft, actorId: 'p0', targetId: 'p1', playedCardId: 'han-pritcher' });
        expect(draft.players.p1.hand).toEqual(['mule#0']);
        expect(draft.players.p1.alive).toBe(true);
    });

    it('never announces the peeked card publicly', () => {
        const draft = round();
        resolvePriest({ round: draft, actorId: 'p0', targetId: 'p1', playedCardId: 'han-pritcher' });
        expect(JSON.stringify(draft.publicLog)).not.toContain('mule');
    });

    it('behaves identically for Bail Channis', () => {
        const draft = round();
        resolvePriest({ round: draft, actorId: 'p0', targetId: 'p1', playedCardId: 'bail-channis' });
        expect(draft.privateKnowledge[0]).toMatchObject({ viewerId: 'p0', cardTypeId: 'mule' });
    });

    it('fizzles when no target was legal', () => {
        const draft = round();
        resolvePriest({ round: draft, actorId: 'p0', playedCardId: 'han-pritcher' });
        expect(draft.privateKnowledge).toEqual([]);
        expect(draft.publicLog).toContainEqual({
            kind: 'FIZZLE',
            turn: draft.turnNumber,
            actorId: 'p0',
            cardId: 'han-pritcher'
        });
    });

    it('records nothing when the target holds no card', () => {
        const draft = makeDraft({
            players: makePlayers({ p0: { hand: ['magnifico#0'] }, p1: { hand: [] } })
        });
        resolvePriest({ round: draft, actorId: 'p0', targetId: 'p1', playedCardId: 'han-pritcher' });
        expect(draft.privateKnowledge).toEqual([]);
    });
});
