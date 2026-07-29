import { describe, expect, it } from 'bun:test';
import type { CardInstanceId, CardTypeId, PlayerId } from '../game/engine';
import { CARD_CATALOG } from '../game/engine';
import { chooseFallbackPlay, type FallbackInput } from './fallbackPlay';

type Own = FallbackInput['own'];
type Player = FallbackInput['players'][number];

function player(id: PlayerId, discards: readonly CardTypeId[] = []): Player {
    const discardPile = discards.map(cardId => ({ cardId, value: CARD_CATALOG[cardId].value }));
    return {
        id,
        seat: Number(id.slice(1)) - 1,
        tokens: 0,
        alive: true,
        protected: false,
        discardPile,
        discardValueTotal: discardPile.reduce((sum, entry) => sum + entry.value, 0)
    };
}

function makeView(own: Partial<Own>, players: readonly Player[] = [], revealed: FallbackInput['revealed'] = []): FallbackInput {
    return {
        own: { playerId: 'p2', hand: [], legalPlays: [], legalTargets: {}, ...own },
        players,
        revealed
    };
}

/** Every value the Informant may name. */
const GUESSABLE = [2, 3, 4, 5, 6, 7, 8];

describe('chooseFallbackPlay card selection', () => {
    it('returns null when the seat has no legal play', () => {
        expect(chooseFallbackPlay(makeView({ legalPlays: [] }))).toBeNull();
    });

    it('plays the lowest-value legal card', () => {
        const play = chooseFallbackPlay(
            makeView({
                legalPlays: ['mule#0', 'shielded-mind#0'],
                legalTargets: { 'mule#0': [], 'shielded-mind#0': [] }
            })
        );
        expect(play?.cardInstanceId).toBe('shielded-mind#0');
    });

    it('breaks a value tie by legalPlays order, so the choice is deterministic', () => {
        // Han Pritcher and Bail Channis are both value 2.
        const first = chooseFallbackPlay(
            makeView({ legalPlays: ['bail-channis#0', 'han-pritcher#0'], legalTargets: {} })
        );
        const reversed = chooseFallbackPlay(
            makeView({ legalPlays: ['han-pritcher#0', 'bail-channis#0'], legalTargets: {} })
        );
        expect(first?.cardInstanceId).toBe('bail-channis#0');
        expect(reversed?.cardInstanceId).toBe('han-pritcher#0');
    });

    it('plays a high card when the engine says it is the only legal one', () => {
        // The First Speaker forces the hand: holding it beside a Darell or a
        // Mayor Indbur makes it the only legal play. The fallback must not
        // "improve" on that by reaching for the lower card — legality is the
        // engine's answer and this module never recomputes it.
        const play = chooseFallbackPlay(
            makeView({
                hand: ['first-speaker#0', 'bayta-darell#0'],
                legalPlays: ['first-speaker#0'],
                legalTargets: { 'first-speaker#0': [] }
            })
        );
        expect(play?.cardInstanceId).toBe('first-speaker#0');
    });
});

describe('chooseFallbackPlay targeting', () => {
    it('aims at the first legal target', () => {
        const play = chooseFallbackPlay(
            makeView({
                legalPlays: ['ebling-mis#0'],
                legalTargets: { 'ebling-mis#0': ['p3', 'p4'] }
            })
        );
        expect(play?.target).toBe('p3');
    });

    it('omits the target when every opponent is protected or out', () => {
        const play = chooseFallbackPlay(
            makeView({ legalPlays: ['ebling-mis#0'], legalTargets: { 'ebling-mis#0': [] } })
        );
        expect(play?.target).toBeUndefined();
        expect(JSON.stringify(play)).not.toContain('"target"');
    });

    it('omits the target for a card that takes none', () => {
        const play = chooseFallbackPlay(
            makeView({ legalPlays: ['shielded-mind#0'], legalTargets: {} })
        );
        expect(play?.target).toBeUndefined();
    });
});

describe('chooseFallbackPlay guessing', () => {
    function informant(
        targets: readonly PlayerId[],
        players: readonly Player[] = [],
        revealed: FallbackInput['revealed'] = [],
        hand: readonly CardInstanceId[] = ['informant#0']
    ) {
        return chooseFallbackPlay(
            makeView({ hand, legalPlays: ['informant#0'], legalTargets: { 'informant#0': targets } }, players, revealed)
        );
    }

    it('names a value the Informant is allowed to name', () => {
        const play = informant(['p3']);
        expect(GUESSABLE).toContain(play?.guess as number);
    });

    it('never guesses the Informant\'s own value', () => {
        // Five of the sixteen cards are Informants — by far the most likely
        // value, and the one guess the rules forbid.
        const play = informant(['p3']);
        expect(play?.guess).not.toBe(1);
    });

    it('carries no guess when no target is legal', () => {
        const play = informant([]);
        expect(play?.guess).toBeUndefined();
        expect(JSON.stringify(play)).not.toContain('"guess"');
    });

    it('names what it already peeked in the target\'s hand', () => {
        const play = informant(['p3'], [], [{ subjectId: 'p3', cardTypeId: 'mayor-indbur' }]);
        expect(play?.guess).toBe(6);
    });

    it('ignores a peek of a player it is not aiming at', () => {
        const play = informant(['p3'], [], [{ subjectId: 'p4', cardTypeId: 'mayor-indbur' }]);
        expect(play?.guess).not.toBe(6);
    });

    it('falls back to counting when the peek is an unguessable Informant', () => {
        const play = informant(['p3'], [], [{ subjectId: 'p3', cardTypeId: 'informant' }]);
        expect(GUESSABLE).toContain(play?.guess as number);
        expect(play?.guess).not.toBe(1);
    });

    it('does not name a value already spent in the discard piles', () => {
        // Both copies of value 2 and both of value 3 are face up, so neither
        // can still be in a hand.
        const play = informant(['p3'], [
            player('p3', ['han-pritcher', 'bail-channis']),
            player('p4', ['ebling-mis', 'magnifico'])
        ]);
        expect(play?.guess).not.toBe(2);
        expect(play?.guess).not.toBe(3);
    });

    it('does not name a value it is holding the last copy of', () => {
        // Mayor Indbur is a singleton. Holding it means nobody else can.
        const play = informant(
            ['p3'],
            [player('p3', ['han-pritcher', 'bail-channis']), player('p4', ['ebling-mis', 'magnifico'])],
            [],
            ['informant#0', 'mayor-indbur#0']
        );
        expect(play?.guess).not.toBe(6);
    });

    it('carries no guess on a card that is not an Informant', () => {
        const play = chooseFallbackPlay(
            makeView({ legalPlays: ['ebling-mis#0'], legalTargets: { 'ebling-mis#0': ['p3'] } })
        );
        expect(play?.guess).toBeUndefined();
    });
});
