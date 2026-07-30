/**
 * Drives a whole match between policies, headlessly (Design §6).
 *
 * This is the training and evaluation loop, and its only unusual property is
 * how little it does: it owns no rule. Turn order comes from `seatOrder`,
 * legality from `reduce`, round transitions from `startNextRound`, and the
 * match ending from `matchWinnerId`. The engine is already a pure deterministic
 * reducer with no I/O, so a million matches here need nothing the browser does
 * not already run.
 *
 * **A rejected action throws.** It is tempting to retry with a different move,
 * and it is exactly wrong: a policy proposing something the engine refuses has
 * restated a rule somewhere, and quietly correcting it converts a bug that
 * fails a test into a bot that plays slightly the wrong game forever. Design §10
 * makes this gate 2.
 */

import type { MatchState, PlayCardAction, PlayerId } from '../engine';
import { createMatch, reduce, startNextRound, view } from '../engine';
import type { Policy } from './policy';
import { makeRng } from './rng';

export interface MatchSetup {
    /** Seating order. The first seat leads round one. */
    readonly seats: readonly PlayerId[];
    readonly policies: Readonly<Record<PlayerId, Policy>>;
    /** Seeds the deck and every policy's randomness, so a run replays exactly. */
    readonly seed: string;
}

export interface MatchOutcome {
    readonly winnerId: PlayerId | null;
    readonly tokens: Readonly<Record<PlayerId, number>>;
    readonly rounds: number;
    readonly actions: number;
}

/**
 * A runaway backstop, far above any real match.
 *
 * A four-player match to four tokens takes tens of actions. This exists so a
 * policy that somehow stops the match progressing fails in a second rather than
 * hanging a training run, and the number is deliberately not tuned close.
 */
const MAX_ACTIONS = 5000;

export function playMatch(setup: MatchSetup): MatchOutcome {
    // One stream for every policy at the table. Seeding it from the match seed
    // is what makes a whole arena run reproducible from its seed list alone.
    const rng = makeRng(`policy:${setup.seed}`);

    let match: MatchState = createMatch(setup.seats, setup.seed, 'self-play');
    let actions = 0;

    while (match.matchWinnerId === null) {
        // A concluded round stops at 'round-over' carrying its result, so the
        // showdown is visible before the table is swept. Nothing is watching
        // here, so sweep immediately.
        if (match.round.phase === 'round-over') {
            match = startNextRound(match);
            continue;
        }

        const actorId = match.round.seatOrder[match.round.currentPlayerIndex];
        const policy = setup.policies[actorId];
        if (policy === undefined) {
            throw new Error(`No policy is seated at ${actorId}`);
        }

        const decision = policy.decide(view(match, actorId), rng);
        if (decision === null) {
            throw new Error(
                `Policy '${policy.id}' at ${actorId} declined to act while holding the turn`
            );
        }

        const action: PlayCardAction = { type: 'PLAY_CARD', playerId: actorId, ...decision };
        const result = reduce(match, action);
        if (!result.ok) {
            throw new Error(
                `Policy '${policy.id}' at ${actorId} proposed an illegal action ` +
                    `(${decision.cardInstanceId}): ${result.error.code}`
            );
        }

        match = result.state;
        actions += 1;

        if (actions > MAX_ACTIONS) {
            throw new Error(`Match did not conclude within ${MAX_ACTIONS} actions`);
        }
    }

    return {
        winnerId: match.matchWinnerId,
        tokens: Object.fromEntries(match.players.map(player => [player.id, player.tokens])),
        // The deciding round is still `match.round` and is never archived, so
        // history is one short of the rounds actually played.
        rounds: match.roundHistory.length + 1,
        actions
    };
}
