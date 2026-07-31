import { describe, expect, test } from 'vitest';
import { createMatch, view, CARD_CATALOG, cardTypeOf, INFORMANT_VALUE } from '../engine';
import { makeRng } from './rng';
import { randomPolicy } from './randomPolicy';

const SEATS = ['p1', 'p2', 'p3', 'p4'];

/** The opening view of a fresh four-player match, held by whoever leads it. */
function openingView() {
    const match = createMatch(SEATS, 'opening', 'm');
    return view(match, match.round.seatOrder[match.round.currentPlayerIndex]);
}

describe('randomPolicy', () => {
    test('only ever names a card the engine called legal', () => {
        const opening = openingView();
        const rng = makeRng('choices');

        for (let i = 0; i < 100; i++) {
            const decision = randomPolicy.decide(opening, rng);
            expect(opening.own.legalPlays).toContain(decision!.cardInstanceId);
        }
    });

    test('only ever names a target the engine called legal', () => {
        const opening = openingView();
        const rng = makeRng('targets');

        for (let i = 0; i < 100; i++) {
            const decision = randomPolicy.decide(opening, rng)!;
            const allowed = opening.own.legalTargets[decision.cardInstanceId] ?? [];

            if (decision.target === undefined) {
                expect(allowed).toHaveLength(0);
            } else {
                expect(allowed).toContain(decision.target);
            }
        }
    });

    test('names a guess for the Informant and for nothing else', () => {
        const opening = openingView();
        const rng = makeRng('guesses');

        for (let i = 0; i < 100; i++) {
            const decision = randomPolicy.decide(opening, rng)!;
            const value = CARD_CATALOG[cardTypeOf(decision.cardInstanceId)].value;
            const targeted = decision.target !== undefined;

            if (value === INFORMANT_VALUE && targeted) {
                expect(decision.guess).toBeDefined();
                expect(decision.guess).not.toBe(INFORMANT_VALUE);
            } else {
                expect(decision.guess).toBeUndefined();
            }
        }
    });

    test('declines to act when the seat does not hold the turn', () => {
        const match = createMatch(SEATS, 'opening', 'm');
        const waiting = match.round.seatOrder[1];

        expect(randomPolicy.decide(view(match, waiting), makeRng('idle'))).toBeNull();
    });
});
