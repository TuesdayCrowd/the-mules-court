/**
 * Designed copy for every failure a player can meet (UIX §5).
 *
 * The design's promise is that *none* fall through to a generic message, so this
 * map is exhaustive over `ErrorCode` — transport codes and the engine's
 * validation codes alike — and `satisfies` makes a new protocol code a compile
 * error rather than a silent gap.
 *
 * Every entry carries an action. A code that reaches the fatal screen without
 * one would be a dead end with no way out, and "which codes can reach it" is
 * exactly the kind of thing that changes without anyone revisiting this file.
 */

import { INFORMANT_VALUE, MAX_CARD_VALUE } from '../../game/engine';
import type { ErrorCode } from '../../server/protocol';

export type FailureAction =
    | { readonly kind: 'menu'; readonly label: string }
    | { readonly kind: 'takeover'; readonly label: string };

export interface FailureCopy {
    readonly message: string;
    readonly action: FailureAction;
}

const BACK_TO_MENU: FailureAction = { kind: 'menu', label: 'Back to menu' };
const TAKE_OVER: FailureAction = { kind: 'takeover', label: 'Take over here' };

/** The Informant's own value is never guessable, so the grid starts one above it. */
const GUESS_RANGE = `${INFORMANT_VALUE + 1} to ${MAX_CARD_VALUE}`;

const COPY = {
    // ---------------------------------------------------------- transport
    MALFORMED: { message: 'The court did not understand that. Try again.', action: BACK_TO_MENU },
    // Deliberately ambiguous: the server makes a wrong link and an expired room
    // indistinguishable, so the copy must not claim to know which happened.
    ROOM_NOT_FOUND: { message: 'That court has dissolved — the link may be old or mistyped.', action: BACK_TO_MENU },
    SEAT_TAKEN: { message: 'This match is open in another window.', action: TAKE_OVER },
    ROOM_FULL: { message: 'The court is full.', action: BACK_TO_MENU },
    ALREADY_SEATED: { message: 'You already hold a seat at this court.', action: BACK_TO_MENU },
    BAD_TOKEN: { message: 'That seat is no longer yours. Take another.', action: BACK_TO_MENU },
    NOT_YOUR_SEAT: { message: 'That seat belongs to someone else.', action: BACK_TO_MENU },
    NOT_HOST: { message: 'Only the host can do that.', action: BACK_TO_MENU },
    // Only reachable by racing the lobby — two host windows emptying the same
    // seat, or a click landing after a person took it. Says which of the two
    // things was wrong, rather than SEAT_TAKEN's opposite claim.
    NOT_A_BOT: { message: 'That seat holds no computer opponent.', action: BACK_TO_MENU },
    CANNOT_START: { message: 'The match needs 2 to 4 players, all connected.', action: BACK_TO_MENU },
    PAUSED: { message: 'The match is paused while a player reconnects.', action: BACK_TO_MENU },
    MATCH_OVER: { message: 'This match has ended.', action: BACK_TO_MENU },
    RATE_LIMITED: { message: 'Slow down a moment — that was a lot at once.', action: BACK_TO_MENU },
    INTERNAL: { message: 'Something went wrong on our side. Try again.', action: BACK_TO_MENU },

    // ------------------------------------------------------------- engine
    // These name the rule that was broken and never a card in anyone's hand —
    // the engine forwards rule names precisely so the copy cannot leak.
    ROUND_NOT_IN_PROGRESS: { message: 'The round is not in play right now.', action: BACK_TO_MENU },
    NOT_YOUR_TURN: { message: 'It is not your turn.', action: BACK_TO_MENU },
    CARD_NOT_IN_HAND: { message: 'You are not holding that card.', action: BACK_TO_MENU },
    FORCED_PLAY_VIOLATION: { message: 'You must play The First Speaker this turn.', action: BACK_TO_MENU },
    TARGET_REQUIRED: { message: 'That card needs a target.', action: BACK_TO_MENU },
    TARGET_NOT_ALLOWED: { message: 'That card takes no target.', action: BACK_TO_MENU },
    TARGET_NOT_LEGAL: { message: 'That player cannot be chosen right now.', action: BACK_TO_MENU },
    GUESS_REQUIRED: { message: 'The Informant needs a value to guess.', action: BACK_TO_MENU },
    GUESS_NOT_ALLOWED: { message: 'That card takes no guess.', action: BACK_TO_MENU },
    GUESS_CANNOT_BE_INFORMANT: { message: `Guess a value from ${GUESS_RANGE}.`, action: BACK_TO_MENU }
} satisfies Record<ErrorCode, FailureCopy>;

export const FAILURE_COPY: Readonly<Record<ErrorCode, FailureCopy>> = COPY;

export function failureCopy(code: ErrorCode): FailureCopy {
    return COPY[code];
}
