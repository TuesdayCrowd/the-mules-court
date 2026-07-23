import { describe, it, expect } from 'vitest';
import { resolveGuard } from '../../resolvers/guard';
import { makeDraft, makePlayers } from '../helpers';
import type { CardInstanceId, RoundDraft } from '../../types';

/** The actor has already discarded the played Informant, so their hand holds one card. */
const round = (): RoundDraft =>
    makeDraft({
        players: makePlayers({
            p0: { hand: ['magnifico#0'] },
            p1: { hand: ['mule#0'] }
        })
    });

describe('resolveGuard — guessing is by value, not by name', () => {
    /** Four values are shared by two characters. Guessing the value must catch both. */
    const holding = (card: CardInstanceId): RoundDraft =>
        makeDraft({
            players: makePlayers({ p0: { hand: ['informant#1'] }, p1: { hand: [card] } })
        });

    it('eliminates a player holding EITHER value-5 card when 5 is guessed', () => {
        for (const darell of ['bayta-darell#0', 'toran-darell#0'] as CardInstanceId[]) {
            const draft = holding(darell);
            resolveGuard({ round: draft, actorId: 'p0', targetId: 'p1', guess: 5, playedCardId: 'informant' });
            expect(draft.players.p1.alive, darell).toBe(false);
        }
    });

    it('eliminates a player holding EITHER value-2 card when 2 is guessed', () => {
        for (const priest of ['han-pritcher#0', 'bail-channis#0'] as CardInstanceId[]) {
            const draft = holding(priest);
            resolveGuard({ round: draft, actorId: 'p0', targetId: 'p1', guess: 2, playedCardId: 'informant' });
            expect(draft.players.p1.alive, priest).toBe(false);
        }
    });

    it('eliminates a player holding EITHER value-3 card when 3 is guessed', () => {
        for (const baron of ['ebling-mis#0', 'magnifico#0'] as CardInstanceId[]) {
            const draft = holding(baron);
            resolveGuard({ round: draft, actorId: 'p0', targetId: 'p1', guess: 3, playedCardId: 'informant' });
            expect(draft.players.p1.alive, baron).toBe(false);
        }
    });

    it('spares a player whose card is a different value', () => {
        const draft = holding('mayor-indbur#0');
        resolveGuard({ round: draft, actorId: 'p0', targetId: 'p1', guess: 5, playedCardId: 'informant' });
        expect(draft.players.p1.alive).toBe(true);
    });

    it('logs the guessed value', () => {
        const draft = holding('mule#0');
        resolveGuard({ round: draft, actorId: 'p0', targetId: 'p1', guess: 8, playedCardId: 'informant' });
        expect(draft.publicLog).toContainEqual({
            kind: 'GUESS',
            turn: draft.turnNumber,
            actorId: 'p0',
            targetId: 'p1',
            guessedValue: 8,
            hit: true
        });
    });
});

describe('resolveGuard', () => {
    it('eliminates a target whose card was named correctly', () => {
        const draft = round();
        resolveGuard({ round: draft, actorId: 'p0', targetId: 'p1', guess: 8, playedCardId: 'informant' });
        expect(draft.players.p1.alive).toBe(false);
    });

    it('reveals the eliminated target\'s card publicly', () => {
        const draft = round();
        resolveGuard({ round: draft, actorId: 'p0', targetId: 'p1', guess: 8, playedCardId: 'informant' });
        expect(draft.players.p1.discardPile.map(e => e.cardId)).toEqual(['mule']);
        expect(draft.players.p1.discardValueTotal).toBe(8);
    });

    it('logs a hit', () => {
        const draft = round();
        resolveGuard({ round: draft, actorId: 'p0', targetId: 'p1', guess: 8, playedCardId: 'informant' });
        expect(draft.publicLog).toContainEqual({
            kind: 'GUESS',
            turn: draft.turnNumber,
            actorId: 'p0',
            targetId: 'p1',
            guessedValue: 8,
            hit: true
        });
    });

    it('leaves a wrongly named target untouched', () => {
        const draft = round();
        resolveGuard({
            round: draft,
            actorId: 'p0',
            targetId: 'p1',
            guess: 7,
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
            guess: 7,
            playedCardId: 'informant'
        });
        expect(draft.publicLog).toContainEqual({
            kind: 'GUESS',
            turn: draft.turnNumber,
            actorId: 'p0',
            targetId: 'p1',
            guessedValue: 7,
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
        resolveGuard({ round: draft, actorId: 'p0', targetId: 'p1', guess: 8, playedCardId: 'informant' });
        expect(draft.players.p0.alive).toBe(true);
        expect(draft.players.p0.hand).toEqual(['magnifico#0']);
    });
});
