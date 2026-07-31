import { describe, expect, test } from 'vitest';
import type { CardInstanceId, RedactedView } from '../engine';
import { CARD_CATALOG, cardTypeOf, view } from '../engine';
import { PERFECT_RECALL } from './census';
import { createHeuristicPolicy } from './heuristic';
import { TRAINED_WEIGHTS } from './weights.generated';
import { findState, takeStates } from './__fixtures__/decisionStates';
import { makeRng } from './rng';
import { createSearchPolicy } from './search';

const valueOf = (card: CardInstanceId) => CARD_CATALOG[cardTypeOf(card)].value;
const holding = (seat: RedactedView, value: number) =>
    seat.own.hand.find(card => valueOf(card) === value);

/** Deterministic: bounded by iterations, never by the clock. */
const searcher = (maxIterations = 200) =>
    createSearchPolicy({ budget: { maxIterations, maxMs: Infinity } }, 'search');

describe('createSearchPolicy', () => {
    test('only ever names a move the engine called legal', () => {
        const policy = searcher(60);
        const rng = makeRng('legality');

        for (const { match, actorId } of takeStates(30, 'search')) {
            const seat = view(match, actorId);
            const decision = policy.decide(seat, rng)!;

            expect(seat.own.legalPlays).toContain(decision.cardInstanceId);
            const allowed = seat.own.legalTargets[decision.cardInstanceId] ?? [];
            if (decision.target !== undefined) expect(allowed).toContain(decision.target);
        }
    });

    test('declines to act when the seat does not hold the turn', () => {
        const { match, actorId } = takeStates(1, 'idle')[0];
        const waiting = match.round.seatOrder.find(id => id !== actorId)!;

        expect(searcher().decide(view(match, waiting), makeRng('idle'))).toBeNull();
    });

    test('never discards the Mule while another play is legal', () => {
        const policy = searcher(80);
        const rng = makeRng('mule');
        let held = 0;

        for (const { match, actorId } of takeStates(400, 'searchmule')) {
            const seat = view(match, actorId);
            const mule = holding(seat, 8);
            if (mule === undefined || seat.own.legalPlays.length < 2) continue;

            held += 1;
            expect(policy.decide(seat, rng)!.cardInstanceId).not.toBe(mule);
        }

        expect(held, 'no state in the sample held the Mule with a choice').toBeGreaterThan(0);
    });

    test('takes a certain kill when a peek offers one', () => {
        const found = findState(seat => {
            const informant = holding(seat, 1);
            if (informant === undefined) return false;
            const targets = seat.own.legalTargets[informant] ?? [];
            return seat.revealed.some(
                r => targets.includes(r.subjectId) && CARD_CATALOG[r.cardTypeId].value !== 1
            );
        });
        expect(found, 'no peek-plus-Informant position found').toBeDefined();

        const seat = found!.seat;
        const known = seat.revealed.find(
            r =>
                (seat.own.legalTargets[holding(seat, 1)!] ?? []).includes(r.subjectId) &&
                CARD_CATALOG[r.cardTypeId].value !== 1
        )!;

        const decision = searcher(400).decide(seat, makeRng('kill'))!;

        expect(decision.cardInstanceId).toBe(holding(seat, 1));
        expect(decision.target).toBe(known.subjectId);
        expect(decision.guess).toBe(CARD_CATALOG[known.cardTypeId].value);
    });

    test('answers the same way twice from the same seed', () => {
        const { match, actorId } = takeStates(1, 'repeat')[0];
        const seat = view(match, actorId);

        const first = searcher(150).decide(seat, makeRng('same'));
        const second = searcher(150).decide(seat, makeRng('same'));

        expect(second).toEqual(first);
    });

    test('stops when the clock says so, not when the iterations run out', () => {
        const { match, actorId } = takeStates(1, 'budget')[0];
        const seat = view(match, actorId);

        const policy = createSearchPolicy(
            { budget: { maxIterations: Number.MAX_SAFE_INTEGER, maxMs: 40 } },
            'timed'
        );

        const started = performance.now();
        expect(policy.decide(seat, makeRng('clock'))).not.toBeNull();
        // Generous: the check happens between iterations, so one rollout can
        // overrun. The claim is that a budget is honoured at all, not to the ms.
        expect(performance.now() - started).toBeLessThan(400);
    });

    test('skips the search entirely when only one move is legal', () => {
        const forced = findState(seat => seat.own.legalPlays.length === 1);
        expect(forced, 'no forced position found').toBeDefined();

        const policy = createSearchPolicy(
            { budget: { maxIterations: Number.MAX_SAFE_INTEGER, maxMs: Infinity } },
            'forced'
        );

        // Would never terminate if it searched: the budget is unbounded.
        const decision = policy.decide(forced!.seat, makeRng('forced'))!;
        expect(decision.cardInstanceId).toBe(forced!.seat.own.legalPlays[0]);
    });
});

describe('a budget too small to be worth trusting', () => {
    test('defers to the base policy rather than guessing from three rollouts', () => {
        // The defect this guards: at ~3 samples per move a single lucky rollout
        // gives a move a mean of 1.0 and it captures the allocation, so a thin
        // search plays WORSE than the heuristic underneath it. Measured — the
        // master tier lost to the adept tier at that budget.
        const thin = createSearchPolicy({ budget: { maxIterations: 5, maxMs: Infinity } }, 'thin');
        const heuristic = createHeuristicPolicy(TRAINED_WEIGHTS, 'adept', PERFECT_RECALL);

        let compared = 0;
        for (const { match, actorId } of takeStates(40, 'thin')) {
            const seat = view(match, actorId);
            if (seat.own.legalPlays.length < 2) continue;

            compared += 1;
            expect(thin.decide(seat, makeRng('a'))).toEqual(heuristic.decide(seat, makeRng('a')));
        }

        expect(compared).toBeGreaterThan(0);
    });
});
