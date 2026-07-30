import { describe, expect, test } from 'vitest';
import type { CardTypeId } from '../engine';
import { CARD_CATALOG, cardTypeOf, view } from '../engine';
import { decisionStates, seeds, takeStates } from './__fixtures__/decisionStates';
import { takeCensus } from './census';

const TOTAL_CARDS = Object.values(CARD_CATALOG).reduce((sum, card) => sum + card.count, 0);

const tally = (types: readonly CardTypeId[]): Map<CardTypeId, number> => {
    const counts = new Map<CardTypeId, number>();
    for (const type of types) counts.set(type, (counts.get(type) ?? 0) + 1);
    return counts;
};

describe('takeCensus', () => {
    test('accounts for all sixteen cards in every state it is given', () => {
        for (const { match, actorId } of decisionStates(seeds(60, 'census'))) {
            const seat = view(match, actorId);
            const census = takeCensus(seat);

            const discarded = seat.players.reduce((sum, p) => sum + p.discardPile.length, 0);
            const peeked = Object.values(census.knownHands).reduce((sum, held) => sum + held.length, 0);
            const faceUp = seat.setAsideFaceUp === null ? 0 : 1;

            expect(census.unseen.length + seat.own.hand.length + discarded + peeked + faceUp).toBe(
                TOTAL_CARDS
            );
        }
    });

    test('never counts a copy the viewer can already see', () => {
        // Per-type conservation, which is what "the viewer's own hand is
        // excluded" actually means once doubled values are in play: for every
        // card type, unseen copies plus visible copies is the catalog count.
        // Anything the seat can see — its hand, any discard, a live peek, the
        // two-player burn — must be missing from `unseen` exactly once each.
        for (const { match, actorId } of takeStates(40, 'own')) {
            const seat = view(match, actorId);
            const census = takeCensus(seat);
            const unseen = tally(census.unseen);
            const visible = tally([
                ...seat.own.hand.map(cardTypeOf),
                ...seat.players.flatMap(p => p.discardPile.map(entry => entry.cardId)),
                ...Object.values(census.knownHands).flat(),
                ...(seat.setAsideFaceUp === null ? [] : [seat.setAsideFaceUp])
            ]);

            for (const type of Object.keys(CARD_CATALOG) as CardTypeId[]) {
                expect((unseen.get(type) ?? 0) + (visible.get(type) ?? 0)).toBe(
                    CARD_CATALOG[type].count
                );
            }
        }
    });

    test('excludes every discarded card from the unseen pile', () => {
        // Deep into a match, so discard piles are long and doubled values matter.
        const states = takeStates(300, 'discards').slice(-40);

        for (const { match, actorId } of states) {
            const seat = view(match, actorId);
            const unseen = tally(takeCensus(seat).unseen);
            const discarded = tally(
                seat.players.flatMap(p => p.discardPile.map(entry => entry.cardId))
            );

            for (const [type, count] of discarded) {
                expect(unseen.get(type) ?? 0).toBeLessThanOrEqual(CARD_CATALOG[type].count - count);
            }
        }
    });

    test('moves a peeked card out of unseen and into its holder hand', () => {
        const peeked = [...decisionStates(seeds(200, 'peek'))].find(
            ({ match, actorId }) => view(match, actorId).revealed.length > 0
        );
        expect(peeked, 'no peek occurred in 200 matches').toBeDefined();

        const seat = view(peeked!.match, peeked!.actorId);
        const census = takeCensus(seat);
        const record = seat.revealed[0];

        expect(census.knownHands[record.subjectId]).toContain(record.cardTypeId);

        const unseen = tally(census.unseen);
        const accountedElsewhere = tally([
            ...seat.own.hand.map(cardTypeOf),
            ...seat.players.flatMap(p => p.discardPile.map(e => e.cardId)),
            ...Object.values(census.knownHands).flat()
        ]);
        expect(unseen.get(record.cardTypeId) ?? 0).toBe(
            CARD_CATALOG[record.cardTypeId].count - (accountedElsewhere.get(record.cardTypeId) ?? 0)
        );
    });

    test('gives the acting seat two cards and every other living seat one', () => {
        for (const { match, actorId } of takeStates(60, 'sizes')) {
            const seat = view(match, actorId);
            const sizes = takeCensus(seat).handSizes;

            expect(sizes[actorId]).toBe(2);
            for (const player of seat.players) {
                if (player.id === actorId) continue;
                expect(sizes[player.id]).toBe(player.alive ? 1 : 0);
            }
        }
    });
});
