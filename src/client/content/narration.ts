import type { CardTypeId, PlayerId, PublicLogEntry } from '../../game/engine';
import { cardCopyFor } from './cardCopy';

/** Resolves a seat id to the nickname the transport supplied. */
export type NameOf = (id: PlayerId) => string;

/** `['Ana']` → `Ana`; `['Ana','Toran']` → `Ana and Toran`; three or more → `Ana, Bayta and Toran`. */
function joinNames(ids: readonly PlayerId[], nameOf: NameOf): string {
    const names = ids.map(nameOf);
    if (names.length <= 1) return names[0] ?? '';
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "takes" for one winner, "take" for a shared win. */
function takesTheRound(ids: readonly PlayerId[], nameOf: NameOf): string {
    return `${joinNames(ids, nameOf)} take${ids.length === 1 ? 's' : ''} the round.`;
}

/**
 * One public log entry, one sentence (UIX §6.5).
 *
 * This is the entire vocabulary of the `aria-live` channel, so it covers every
 * entry kind exhaustively — a missing case is a silent screen reader, not a
 * cosmetic gap. The `never` default turns a future log kind into a compile
 * error rather than a blank announcement.
 *
 * It narrates only what the entry carries. A missed guess never names a card,
 * because `PublicLogEntry` is safe by construction and this function must not
 * reintroduce what the engine took care to leave out.
 */
export function narrate(entry: PublicLogEntry, nameOf: NameOf): string {
    switch (entry.kind) {
        case 'PLAY':
            return `${nameOf(entry.actorId)} played ${cardCopyFor(entry.cardId).displayName}.`;

        case 'GUESS':
            return `${nameOf(entry.actorId)} guessed ${entry.guessedValue} against ${nameOf(entry.targetId)} — ${
                entry.hit ? 'hit' : 'missed'
            }.`;

        case 'COMPARE': {
            const opening = `${nameOf(entry.actorId)} and ${nameOf(entry.targetId)} compared hands`;
            switch (entry.result) {
                case 'tie':
                    return `${opening} — a tie.`;
                case 'actor-eliminated':
                    return `${opening} — ${nameOf(entry.actorId)} is out.`;
                case 'target-eliminated':
                    return `${opening} — ${nameOf(entry.targetId)} is out.`;
            }
        }

        case 'PROTECTED':
            return `${nameOf(entry.actorId)} is protected until their next turn.`;

        case 'TRADED':
            return `${nameOf(entry.actorId)} traded hands with ${nameOf(entry.targetId)}.`;

        case 'REDREW': {
            // The subject is the target, who may be the actor: a Prince can be
            // played on oneself, and "Ana discarded their hand" is right either way.
            const subject = nameOf(entry.targetId);
            switch (entry.drewFrom) {
                case 'deck':
                    return `${subject} discarded their hand and drew from the deck.`;
                case 'set-aside':
                    return `${subject} discarded their hand and drew the set-aside card.`;
                case 'none':
                    return `${subject} discarded their hand — no card left to draw.`;
            }
        }

        case 'FIZZLE':
            return `${nameOf(entry.actorId)} played ${cardCopyFor(entry.cardId).displayName} with no legal target — no effect.`;

        case 'ELIMINATED': {
            // Always emitted straight after the GUESS or COMPARE that caused it,
            // so each cause says something the previous line did not.
            const subject = nameOf(entry.playerId);
            switch (entry.cause) {
                case 'guard':
                    return `${subject} is out of the round — the guess was right.`;
                case 'baron':
                    return `${subject} is out of the round — the lower card.`;
                case 'mule-voluntary':
                    return `${subject} discarded The Mule — out of the round.`;
                case 'mule-forced':
                    return `${subject} was forced to discard The Mule — out of the round.`;
            }
        }

        case 'ROUND_END': {
            const tail = takesTheRound(entry.winners, nameOf);
            switch (entry.reason) {
                case 'deck-out':
                    return `Deck ran out — highest card wins. ${tail}`;
                case 'last-survivor':
                    return `Everyone else is out. ${tail}`;
            }
        }

        default: {
            const exhaustive: never = entry;
            return exhaustive;
        }
    }
}

/**
 * A private peek, for the aria-live channel and the toast beside it (UIX §8.1).
 *
 * Separate from `narrate` on purpose: that function turns a `PublicLogEntry`
 * into a line every player hears, and a peek is the opposite of public. The
 * engine keeps peeks out of `publicLog` entirely and surfaces them only through
 * `view.revealed`, which is redacted per viewer — so this is the one line in the
 * game that names a living player's card, and it says plainly why it is allowed.
 */
export function narratePeek(subjectName: string, cardId: CardTypeId): string {
    return `Only you see this — ${subjectName} holds ${cardCopyFor(cardId).displayName}.`;
}

/** The same knowledge going stale: the card was played, traded, or redrawn. */
export function narratePeekLost(subjectName: string): string {
    return `You no longer know what ${subjectName} holds.`;
}
