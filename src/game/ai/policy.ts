/**
 * The seam every computer opponent plugs into (Computer Opponent Design §3).
 *
 * A `RedactedView` goes in and a move comes out. That is the whole contract,
 * and its two omissions are the design:
 *
 * **A policy never sees `MatchState`.** It is handed the same projection a
 * browser receives, from the same `view()` call, so it cannot read a deck, a
 * set-aside card, the seed, or another player's hand — `RedactedView` is
 * declared standalone precisely so that those fields have nowhere to live
 * (`engine/types.ts:339`). Cheating is a missing capability here, not a rule
 * someone has to remember not to break.
 *
 * **A policy cannot name a player id.** `PolicyDecision` is a `PlayCardAction`
 * minus `type` and `playerId`; the driver supplies the seat from whoever
 * actually holds the turn. So a policy cannot move for a seat it does not
 * occupy, and the transport makes the same trade for the same reason — it
 * deletes `playerId` from `PLAY_CARD` rather than validating it.
 *
 * Randomness arrives as a parameter. A policy that reached for `Math.random`
 * would break replay, which is what `selfPlay` and every seeded arena run
 * depend on.
 */

import type { CardInstanceId, GuessValue, PlayerId, RedactedView } from '../engine';
import type { Rng } from './rng';

/** A move, minus the seat making it. Shaped like `PLAY_CARD`'s payload. */
export interface PolicyDecision {
    readonly cardInstanceId: CardInstanceId;
    /** Omitted, never null, when the card takes no target or none is legal. */
    readonly target?: PlayerId;
    /** Informant only. A value from 2 to 8; never 1, which is the Informant itself. */
    readonly guess?: GuessValue;
}

export interface Policy {
    /** Stable and short. It labels seats in arena reports and in failure messages. */
    readonly id: string;
    /**
     * Choose a move, or `null` when this seat has no legal play.
     *
     * `null` means "the engine offered nothing", which happens on any view where
     * the seat does not hold the turn. It does not mean "pass": a seat holding
     * the turn always has a legal play, and `selfPlay` treats `null` there as a
     * bug in the policy rather than as a move.
     */
    decide(view: RedactedView, rng: Rng): PolicyDecision | null;
}
