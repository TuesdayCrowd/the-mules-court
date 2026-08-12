import { describe, expect, test } from 'vitest';
import type { CardInstanceId, PlayerId, PublicLogEntry, RedactedView } from '../engine';
import { CARD_CATALOG, cardTypeOf, view } from '../engine';
import { runArena } from './arena';
import { findState, FOUR_SEATS, seeds, takeStates } from './__fixtures__/decisionStates';
import { heuristicPolicy } from './heuristic';
import { randomPolicy } from './randomPolicy';
import { makeRng } from './rng';

const valueOf = (instanceId: CardInstanceId) => CARD_CATALOG[cardTypeOf(instanceId)].value;
const holding = (seat: RedactedView, value: number) =>
    seat.own.hand.find(card => valueOf(card) === value);

describe('heuristicPolicy', () => {
    test('never discards the Mule while another play is legal', () => {
        const rng = makeRng('mule');
        let mulesHeld = 0;

        for (const { match, actorId } of takeStates(600, 'mule')) {
            const seat = view(match, actorId);
            const mule = holding(seat, 8);
            if (mule === undefined || seat.own.legalPlays.length < 2) continue;

            mulesHeld += 1;
            expect(heuristicPolicy.decide(seat, rng)!.cardInstanceId).not.toBe(mule);
        }

        expect(mulesHeld, 'no state in the sample held the Mule with a choice').toBeGreaterThan(0);
    });

    test('does not compare hands while holding a card that loses the compare', () => {
        // Playing a Baron compares the actor's REMAINING card, because reduce()
        // discards the played card first. Holding {Baron 3, Informant 1} and
        // playing the 3 therefore stakes a 1 against an unknown — the trap the
        // fallback policy walks straight into.
        const found = findState(
            seat =>
                holding(seat, 3) !== undefined &&
                holding(seat, 1) !== undefined &&
                seat.own.legalPlays.length > 1 &&
                (seat.own.legalTargets[holding(seat, 3)!] ?? []).length > 0
        );
        expect(found, 'no Baron-beside-Informant position found').toBeDefined();

        const decision = heuristicPolicy.decide(found!.seat, makeRng('baron'));
        expect(decision!.cardInstanceId).toBe(holding(found!.seat, 1));
    });

    test('turns a live peek into the guess it names', () => {
        const found = findState(seat => {
            const informant = holding(seat, 1);
            if (informant === undefined) return false;
            const targets = seat.own.legalTargets[informant] ?? [];
            return seat.revealed.some(
                record =>
                    targets.includes(record.subjectId) &&
                    CARD_CATALOG[record.cardTypeId].value !== 1
            );
        });
        expect(found, 'no peek-plus-Informant position found').toBeDefined();

        const seat = found!.seat;
        const known = seat.revealed.find(
            record =>
                (seat.own.legalTargets[holding(seat, 1)!] ?? []).includes(record.subjectId) &&
                CARD_CATALOG[record.cardTypeId].value !== 1
        )!;

        const decision = heuristicPolicy.decide(seat, makeRng('peek'))!;
        // A held value can repeat (two Informants), and chooseBest breaks a tie
        // between equally-scored instances at random — only the VALUE played is
        // guaranteed, not which of two identical cards was chosen.
        expect(valueOf(decision.cardInstanceId)).toBe(1);
        expect(decision.target).toBe(known.subjectId);
        expect(decision.guess).toBe(CARD_CATALOG[known.cardTypeId].value);
    });

    test('guesses the card it gave away in a trade, against the player who took it', () => {
        // The complaint's mirror image: a bot whose hand a King traded away has
        // no memory of what it lost unless the trade itself records the peek —
        // king.ts now does, the same way baron.ts already does for a compare.
        // `tradePartners` finds every seat this one swapped hands with, so the
        // live `revealed` record checked below can be tied to a trade rather
        // than coincidentally matching some other peek's target.
        const tradePartners = (seat: RedactedView): PlayerId[] =>
            seat.publicLog
                .filter(
                    (entry): entry is Extract<PublicLogEntry, { kind: 'TRADED' }> =>
                        entry.kind === 'TRADED' &&
                        (entry.actorId === seat.own.playerId || entry.targetId === seat.own.playerId)
                )
                .map(entry => (entry.actorId === seat.own.playerId ? entry.targetId : entry.actorId));

        const found = findState(seat => {
            const informant = holding(seat, 1);
            if (informant === undefined) return false;
            const targets = seat.own.legalTargets[informant] ?? [];
            const partners = tradePartners(seat);
            return seat.revealed.some(
                record =>
                    partners.includes(record.subjectId) &&
                    targets.includes(record.subjectId) &&
                    CARD_CATALOG[record.cardTypeId].value !== 1
            );
        });
        expect(found, 'no post-trade Informant position found').toBeDefined();

        const seat = found!.seat;
        const partners = tradePartners(seat);
        const known = seat.revealed.find(
            record =>
                partners.includes(record.subjectId) &&
                (seat.own.legalTargets[holding(seat, 1)!] ?? []).includes(record.subjectId) &&
                CARD_CATALOG[record.cardTypeId].value !== 1
        )!;

        const decision = heuristicPolicy.decide(seat, makeRng('king-trade'))!;
        expect(valueOf(decision.cardInstanceId)).toBe(1);
        expect(decision.target).toBe(known.subjectId);
        expect(decision.guess).toBe(CARD_CATALOG[known.cardTypeId].value);
    });

    test('does not trade an Informant away on a King when the target could name it back', () => {
        // The worst case for a King: the kept card IS the Informant, so a trade
        // hands the target a certain, nameable read the instant they can play
        // their own Informant — keptValue === INFORMANT_VALUE is the case the
        // scorer cannot distinguish from a safe trade without a leak term.
        //
        // Excludes a live peek and a one-opponent endgame: either lets the
        // census collapse to certainty on its own (a known hand, or a single
        // unseen card late in the deck), which makes an Informant guess the
        // obvious top move for a reason that has nothing to do with the King's
        // own leak — and would pass even against the unfixed scorer.
        const found = findState(seat => {
            const king = holding(seat, 6);
            if (king === undefined || holding(seat, 1) === undefined) return false;
            const targets = seat.own.legalTargets[king] ?? [];
            if (targets.length === 0 || seat.revealed.length !== 0) return false;
            const aliveOpponents = seat.players.filter(
                player => player.alive && player.id !== seat.own.playerId
            ).length;
            return aliveOpponents >= 2;
        }, 20_000);
        expect(found, 'no King-beside-Informant position with a diffuse census found').toBeDefined();

        const decision = heuristicPolicy.decide(found!.seat, makeRng('king-leak'))!;
        expect(decision.cardInstanceId).not.toBe(holding(found!.seat, 6));
    });

    test('shields the Mule rather than carrying it unprotected', () => {
        const found = findState(
            seat => holding(seat, 8) !== undefined && holding(seat, 4) !== undefined,
            800
        );
        expect(found, 'no Mule-beside-Shielded-Mind position found').toBeDefined();

        expect(heuristicPolicy.decide(found!.seat, makeRng('shield'))!.cardInstanceId).toBe(
            holding(found!.seat, 4)
        );
    });

    test('beats random by a margin outside the confidence intervals', () => {
        // The gate that matters (Design §10, gate 3). One heuristic seat against
        // three random ones: its interval must clear every random seat's, so
        // "better" means the ranges separated rather than a number looking bigger.
        const report = runArena({
            seats: FOUR_SEATS,
            policies: {
                p1: heuristicPolicy,
                p2: randomPolicy,
                p3: randomPolicy,
                p4: randomPolicy
            },
            seeds: seeds(400, 'gate')
        });

        const [tested, ...baseline] = report.seats;
        expect(tested.policyId).toBe('heuristic');
        for (const seat of baseline) {
            expect(tested.low).toBeGreaterThan(seat.high);
        }
    });

    test('wins from every seat, not just the one it was tuned in', () => {
        for (const seatIndex of [0, 1, 2, 3]) {
            const policies = Object.fromEntries(
                FOUR_SEATS.map((id, i) => [id, i === seatIndex ? heuristicPolicy : randomPolicy])
            );
            const report = runArena({
                seats: FOUR_SEATS,
                policies,
                seeds: seeds(200, `rotate-${seatIndex}`)
            });

            expect(report.seats[seatIndex].rate).toBeGreaterThan(0.25);
        }
    });
});
