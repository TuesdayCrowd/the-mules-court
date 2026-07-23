import { describe, it, expect } from 'vitest';
import { resolveBaron } from '../../resolvers/baron';
import { makeDraft, makePlayers } from '../helpers';
import type { CardInstanceId, RoundDraft } from '../../types';

/** The played Baron is already discarded, so each side holds exactly one card. */
const duel = (actorCard: CardInstanceId, targetCard: CardInstanceId): RoundDraft =>
    makeDraft({
        players: makePlayers({ p0: { hand: [actorCard] }, p1: { hand: [targetCard] } })
    });

const resolve = (draft: RoundDraft) =>
    resolveBaron({ round: draft, actorId: 'p0', targetId: 'p1', playedCardId: 'ebling-mis' });

describe('resolveBaron — comparison', () => {
    it('eliminates the target holding the lower card', () => {
        const draft = duel('mayor-indbur#0', 'informant#0');
        resolve(draft);
        expect(draft.players.p1.alive).toBe(false);
        expect(draft.players.p0.alive).toBe(true);
    });

    it('eliminates the actor holding the lower card', () => {
        const draft = duel('informant#0', 'mayor-indbur#0');
        resolve(draft);
        expect(draft.players.p0.alive).toBe(false);
        expect(draft.players.p1.alive).toBe(true);
    });

    it('reveals the loser\'s card publicly', () => {
        const draft = duel('mayor-indbur#0', 'informant#0');
        resolve(draft);
        expect(draft.players.p1.discardPile.map(e => e.cardId)).toEqual(['informant']);
    });

    it('logs which side fell', () => {
        const draft = duel('mayor-indbur#0', 'informant#0');
        resolve(draft);
        expect(draft.publicLog).toContainEqual({
            kind: 'COMPARE',
            turn: draft.turnNumber,
            actorId: 'p0',
            targetId: 'p1',
            result: 'target-eliminated'
        });
    });
});

describe('resolveBaron — ties', () => {
    it('eliminates nobody when the values match', () => {
        const draft = duel('han-pritcher#0', 'bail-channis#0');
        resolve(draft);
        expect(draft.players.p0.alive).toBe(true);
        expect(draft.players.p1.alive).toBe(true);
    });

    it('logs the tie', () => {
        const draft = duel('han-pritcher#0', 'bail-channis#0');
        resolve(draft);
        expect(draft.publicLog).toContainEqual({
            kind: 'COMPARE',
            turn: draft.turnNumber,
            actorId: 'p0',
            targetId: 'p1',
            result: 'tie'
        });
    });

    // "Nothing happens" on a tie means no elimination. The comparison itself is
    // mechanical: both players always see each other's card.
    it('still reveals both cards to both players on a tie', () => {
        const draft = duel('han-pritcher#0', 'bail-channis#0');
        resolve(draft);
        expect(draft.privateKnowledge).toHaveLength(2);
    });
});

describe('resolveBaron — mutual private knowledge', () => {
    it('gives each player a record naming the other\'s card', () => {
        const draft = duel('mayor-indbur#0', 'informant#0');
        resolve(draft);
        expect(draft.privateKnowledge).toContainEqual(
            expect.objectContaining({ viewerId: 'p0', subjectId: 'p1', cardTypeId: 'informant' })
        );
        expect(draft.privateKnowledge).toContainEqual(
            expect.objectContaining({ viewerId: 'p1', subjectId: 'p0', cardTypeId: 'mayor-indbur' })
        );
    });

    it('records the reveal before resolving the elimination', () => {
        const draft = duel('mayor-indbur#0', 'informant#0');
        resolve(draft);
        // The loser's record survives even though they are now out.
        expect(draft.privateKnowledge).toHaveLength(2);
    });

    it('never announces either card publicly', () => {
        const draft = duel('mayor-indbur#0', 'first-speaker#0');
        resolve(draft);
        const log = JSON.stringify(draft.publicLog);
        expect(log).not.toContain('mayor-indbur');
    });
});

describe('resolveBaron — fizzle', () => {
    it('does nothing when no target was legal', () => {
        const draft = duel('mayor-indbur#0', 'informant#0');
        resolveBaron({ round: draft, actorId: 'p0', playedCardId: 'ebling-mis' });
        expect(draft.players.p0.alive).toBe(true);
        expect(draft.players.p1.alive).toBe(true);
        expect(draft.privateKnowledge).toEqual([]);
        expect(draft.publicLog).toContainEqual({
            kind: 'FIZZLE',
            turn: draft.turnNumber,
            actorId: 'p0',
            cardId: 'ebling-mis'
        });
    });
});

describe('resolveBaron — Magnifico behaves identically to Ebling Mis', () => {
    it('resolves the same comparison', () => {
        const draft = duel('mayor-indbur#0', 'informant#0');
        resolveBaron({ round: draft, actorId: 'p0', targetId: 'p1', playedCardId: 'magnifico' });
        expect(draft.players.p1.alive).toBe(false);
    });
});
