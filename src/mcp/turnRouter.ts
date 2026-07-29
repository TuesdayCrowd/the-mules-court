/**
 * What `await_turn` answers (Design §4).
 *
 * Pure, and deliberately the thinnest thing in this package: it decides which
 * of the held seats — if any — should be handed the turn, from facts every
 * player at the table already has. `currentPlayerId` is in every
 * `RedactedView`, so a referee reading this signal learns nothing a spectator
 * could not. That is the whole point. The referee routes on public
 * information and never opens a hand, which is what keeps three seats from
 * collapsing into one mind.
 *
 * `TurnSignal` has no field capable of holding a card, so a future edit cannot
 * quietly widen it into a peek — the same structural trick `view()` uses
 * against `MatchState` and `PublicSeat` uses against a handle.
 */

import type { PlayerId } from '../game/engine';

/** The wire's own phase, mirrored rather than restated. */
export type WirePhase = 'active' | 'round_over' | 'ended';

export type TurnStatus = 'your_turn' | 'waiting' | 'round_over' | 'match_over';

export interface TurnSignal {
    readonly status: TurnStatus;
    /** Present only for `your_turn` — the seat to dispatch. */
    readonly seat?: PlayerId;
    readonly turnNumber: number;
    readonly phase: WirePhase;
}

export interface TurnInput {
    readonly heldPlayerIds: readonly PlayerId[];
    readonly currentPlayerId: PlayerId;
    readonly turnNumber: number;
    readonly phase: WirePhase;
    /** From `STATE_UPDATE`. A paused room refuses PLAY_CARD with `PAUSED`. */
    readonly paused: boolean;
}

/**
 * Precedence is not arbitrary — each earlier case makes the later ones
 * unanswerable rather than merely less interesting:
 *
 * 1. `ended` is terminal; there is no next turn to route.
 * 2. `round_over` is the reveal window, advanced by a server timer
 *    (`room.ts` `armRevealTimer`). No seat may play through it, so naming one
 *    would send an agent to be refused.
 * 3. `paused` is the same refusal from a different cause: `dispatch.ts`
 *    answers PLAY_CARD with `PAUSED` while a seat is missing. Routing here
 *    would burn a turn earning an error the seat cannot act on.
 *
 * Only then does whose-turn-it-is matter.
 */
export function routeTurn(input: TurnInput): TurnSignal {
    const { turnNumber, phase } = input;

    if (phase === 'ended') return { status: 'match_over', turnNumber, phase };
    if (phase === 'round_over') return { status: 'round_over', turnNumber, phase };
    if (input.paused) return { status: 'waiting', turnNumber, phase };

    // `includes` over an array of at most four ids. A Set would be faster in a
    // way nothing here could measure, and harder to read.
    if (!input.heldPlayerIds.includes(input.currentPlayerId)) {
        return { status: 'waiting', turnNumber, phase };
    }

    return { status: 'your_turn', seat: input.currentPlayerId, turnNumber, phase };
}
