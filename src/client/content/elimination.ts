/**
 * Why the viewer is out of the round, in their own words.
 *
 * The public log already narrates every elimination — "Ana is out of the round —
 * the lower card" — but that line is written for the table, and it deliberately
 * names no cards. To the player it just happened to, it is not an explanation:
 * *whose* card, and which one, is exactly what they want and exactly what it
 * withholds. Reported against the value-3 comparison, where the answer is a
 * number they never saw.
 *
 * **It discloses nothing the engine has not already disclosed to this viewer.**
 * Three sources, all of them already in their own `RedactedView`:
 *
 *  - **Their own card.** `eliminate()` pushes the whole hand onto the public
 *    discard pile before anything else, so the top of their own pile *is* what
 *    they were holding.
 *  - **The other player's card, on a comparison only.** `resolvers/baron.ts`
 *    records a peek for *both* players, unconditionally and before the tie
 *    check, because "they physically compared them". `view.revealed` is that
 *    peek. No other cause reveals an opponent's card and none of them try to.
 *  - **Who did it, and what they guessed.** Straight off `publicLog`, which
 *    every seat can already read.
 *
 * **Read at the moment of elimination, not on every render.** `view.revealed`
 * drops a peek the instant the subject stops holding that exact card, so the
 * winner playing their card next turn would take the explanation with it. The
 * caller captures the sentence once and keeps it; this only has to be correct
 * when asked.
 */

import { cardLabel } from './cardCopy';
import type { CardTypeId, PlayerId, PublicLogEntry, RedactedView } from '../../game/engine';
import type { NameOf } from './narration';

export interface EliminationReason {
    /** The fact, stated first and without hedging. */
    readonly headline: string;
    /** Why it happened, naming what this viewer is entitled to know. */
    readonly detail: string;
}

type Eliminated = Extract<PublicLogEntry, { kind: 'ELIMINATED' }>;

export const ELIMINATION_HEADLINE = 'You are out of the round.';

/** The card on top of a seat's discard pile — for a seat just eliminated, their hand. */
function revealedHand(view: RedactedView, playerId: PlayerId): CardTypeId | null {
    const pile = view.players.find(player => player.id === playerId)?.discardPile ?? [];
    return pile.length === 0 ? null : pile[pile.length - 1].cardId;
}

/** "3 · Ebling Mis", or a bare phrase when there was no card to name. */
function held(cardId: CardTypeId | null): string {
    return cardId === null ? 'nothing at all' : cardLabel(cardId);
}

/** The entries before this elimination, most recent first. */
function before(log: readonly PublicLogEntry[], index: number): PublicLogEntry[] {
    return log.slice(0, index).reverse();
}

function comparisonDetail(
    view: RedactedView,
    earlier: PublicLogEntry[],
    own: PlayerId,
    nameOf: NameOf
): string {
    const compare = earlier.find(
        (entry): entry is Extract<PublicLogEntry, { kind: 'COMPARE' }> =>
            entry.kind === 'COMPARE' && (entry.actorId === own || entry.targetId === own)
    );
    if (compare === undefined) return `Your card was the lower of the two. You held ${held(revealedHand(view, own))}.`;

    const otherId = compare.actorId === own ? compare.targetId : compare.actorId;
    const theirs = view.revealed.find(peek => peek.subjectId === otherId)?.cardTypeId ?? null;
    const mine = held(revealedHand(view, own));

    // The peek expires the moment they play that card, and this sentence may be
    // read after they have. Say what is still true rather than a blank.
    if (theirs === null) {
        return `${nameOf(otherId)} compared hands with you and yours was the lower card. You held ${mine}.`;
    }

    return `${nameOf(otherId)} compared hands with you. You held ${mine}; they held ${cardLabel(theirs)}. The lower card is out.`;
}

function guessDetail(view: RedactedView, earlier: PublicLogEntry[], own: PlayerId, nameOf: NameOf): string {
    const guess = earlier.find(
        (entry): entry is Extract<PublicLogEntry, { kind: 'GUESS' }> =>
            entry.kind === 'GUESS' && entry.targetId === own
    );
    const mine = held(revealedHand(view, own));

    if (guess === undefined) return `A guess found you holding ${mine}.`;
    return `${nameOf(guess.actorId)} guessed ${guess.guessedValue}, and you were holding ${mine}.`;
}

function forcedDetail(earlier: PublicLogEntry[], nameOf: NameOf): string {
    // No REDREW is logged when the forced discard is The Mule — `prince.ts`
    // eliminates and returns before it — so the play that caused this is the
    // most recent one.
    const play = earlier.find(
        (entry): entry is Extract<PublicLogEntry, { kind: 'PLAY' }> => entry.kind === 'PLAY'
    );
    const who = play === undefined ? 'Another player' : nameOf(play.actorId);
    return `${who} made you discard your hand, and it was The Mule. Discarding The Mule puts you out.`;
}

/**
 * The sentence the viewer is owed, or `null` when they are still in the round.
 *
 * Takes the *latest* elimination of this viewer in the log. A round's log starts
 * empty, so two of them means the caller is holding a stale concatenation, and
 * the newer one is the one being explained.
 */
export function eliminationReason(view: RedactedView, nameOf: NameOf): EliminationReason | null {
    const own = view.own.playerId;
    const log = view.publicLog;

    let index = -1;
    for (let i = log.length - 1; i >= 0; i--) {
        const entry = log[i];
        if (entry.kind === 'ELIMINATED' && entry.playerId === own) {
            index = i;
            break;
        }
    }
    if (index === -1) return null;

    const entry = log[index] as Eliminated;
    const earlier = before(log, index);

    const detail = ((): string => {
        switch (entry.cause) {
            case 'baron':
                return comparisonDetail(view, earlier, own, nameOf);
            case 'guard':
                return guessDetail(view, earlier, own, nameOf);
            case 'mule-voluntary':
                return 'You played The Mule. Discarding it puts you out of the round.';
            case 'mule-forced':
                return forcedDetail(earlier, nameOf);
            default: {
                // A cause added to the engine must be given words here rather
                // than silently reaching the player as a blank dialog.
                const exhaustive: never = entry.cause;
                return exhaustive;
            }
        }
    })();

    return { headline: ELIMINATION_HEADLINE, detail };
}
