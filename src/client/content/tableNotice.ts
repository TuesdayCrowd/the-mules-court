/**
 * Whether a log entry is a third-person event that must be READ, not merely heard.
 *
 * ## Why this exists
 *
 * `toasts.ts`/`ui.css` draw exactly two things: `personal` (something a card did
 * to the viewer) and `notice` (a server refusal). Everything else is `narration`
 * — the running third-person commentary — and `ui.css` clips it to a 1px box on
 * purpose (see the comment above `.toast[data-kind='narration']`): a bot turn can
 * emit five log lines in a row, and painting all of them buried the table behind
 * its own commentary. Narration reaches a screen reader through `aria-live` and
 * reaches nobody else. That trade is right for most of the log.
 *
 * It is wrong for a guess. Reported by a player, verbatim: *"when someone
 * guesses your card and text shows on your screen indicating what they guessed,
 * the same should be when another player guesses against another player."* A
 * `GUESS` between two other seats is the one bystander event that states a card
 * VALUE in public — every other player's deduction for the rest of the round
 * leans on having seen it, hit or miss, because a miss eliminates a value from
 * that hand exactly as informatively as a hit confirms one. Losing it to the
 * clipped channel is losing the one piece of public evidence the whole game
 * runs on, not losing colour commentary.
 *
 * ## Why a boolean, not a second string
 *
 * `personalNotice.ts` already found this shape: a line must not exist in two
 * phrasings, or a screen-reader player and a sighted player are told two
 * different sentences about one event. So this function does not write new
 * copy — it only decides whether `narrate()`'s existing string, the same one
 * every player already gets through `aria-live`, ALSO gets painted this time.
 * `main.ts` is what acts on the boolean; the words stay `narrate()`'s.
 *
 * ## Why this is a narrow predicate, not an exhaustive switch
 *
 * `narrate` and `personalNotice` both close their switch with a `never` default,
 * because each is the entire vocabulary for its channel — a missed case there is
 * a silent screen reader or a player told nothing happened to them. This
 * function is not a vocabulary; it is one carve-out from a channel that is
 * otherwise correctly clipped. A future log kind should default to "not drawn"
 * — that is what `narration` already means and is the safe reading until
 * someone argues a specific new kind belongs beside `GUESS` here. Do not turn
 * this into a `switch` with a `never` default: the day a twelfth card adds a
 * new `PublicLogEntry` kind, that default would force a decision this file has
 * no business making by omission.
 */

import type { PlayerId, PublicLogEntry } from '../../game/engine';

/**
 * True for a `GUESS` where the viewer is neither the guesser nor the target.
 *
 * The target case stays `false` on purpose: `personalNotice` already draws that
 * one, in the second person, at a length and timeout tuned for "this concerns
 * you". Drawing it again here would put the same event on screen twice, once in
 * each grammatical person. The actor's own guess stays `false` too — a player
 * does not need their own move narrated back at them; they just made it.
 */
export function isTableNotice(entry: PublicLogEntry, viewerId: PlayerId): boolean {
    return entry.kind === 'GUESS' && entry.actorId !== viewerId && entry.targetId !== viewerId;
}
