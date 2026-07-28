/**
 * Why a card will not play, in words.
 *
 * There are exactly three reasons, and the interface used to render the first
 * one's copy for all three. Off-turn it announced "every other player is
 * protected or eliminated" — a rule of the game, stated to a player for whom it
 * was simply not their turn.
 *
 * | Reason                          | How the client knows                                  |
 * | ------------------------------- | ----------------------------------------------------- |
 * | Not your turn                   | `currentPlayerId !== own.playerId`                    |
 * | Another card forces itself      | it is your turn, and `legalPlays` excludes this card   |
 * | Playable, but nothing to aim at | it is playable, and no target is eligible              |
 *
 * None of that derives a rule. `currentPlayerId` is public board state and
 * `legalPlays` is the engine's own answer — the same discipline `store/targets.ts`
 * keeps for eligibility, for the same reason.
 *
 * The wording lives here rather than in either surface because two surfaces say
 * it: the canvas captions a dimmed hand card, and the action sheet explains a
 * disabled Play button. Sharing the sentence is what stops them drifting into
 * describing one rule two ways.
 */

import type { CardTypeId } from '../../game/engine';
import { cardCopyFor } from './cardCopy';

/**
 * The fragment under a dimmed card on the table.
 *
 * Lower case and verbless because the card above it is already labelled with
 * its own value and name; a full sentence there would restate what the player
 * is looking at.
 */
export function forcedPlayCaption(mustPlay: CardTypeId): string {
    return `must play ${cardCopyFor(mustPlay).displayName}`;
}

/**
 * The same rule as a sentence, for the action sheet.
 *
 * This one stands alone and reaches the `aria-live` channel, so it names the
 * subject and says when: "this turn" is the difference between a rule the
 * player must satisfy now and a general fact about the card.
 */
export function forcedPlaySentence(mustPlay: CardTypeId): string {
    return `You must play ${cardCopyFor(mustPlay).displayName} this turn.`;
}

/**
 * Off-turn. Deliberately silent about targets: whether anyone is protected is
 * not what is stopping this play, and saying so was the original bug.
 */
export const NOT_YOUR_TURN = 'Not your turn — this is what the card does.';

/**
 * A legal play that will fizzle. Calm rather than an error: the card still
 * plays, and requiring a choice that cannot be made would strand the turn
 * (UIX §7.2). Reached only when the card genuinely is playable.
 */
export const NO_LEGAL_TARGET =
    'Every other player is protected or eliminated. This card will be discarded with no effect.';
