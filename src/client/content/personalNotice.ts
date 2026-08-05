/**
 * The same events as `narration.ts`, told to the player they happened to.
 *
 * ## Why this exists
 *
 * Every log entry already reaches the screen: `main.ts` runs `announcementFor`
 * and hands the line to `toasts.show`. But `narrate` is uniformly third-person,
 * so a player targeted by a value-5 was shown **their own nickname** —
 * *"Janov Pelorat discarded their hand and drew from the deck."* — in a toast
 * styled exactly like the running commentary about everyone else. It reads as
 * something that happened to somebody, and the somebody happens to be you.
 *
 * Reported as: *"I get targeted by 5 to discard and it is unclear what just
 * happened to me without looking at the log."* The information was on screen
 * and still did not arrive, which makes this a point-of-view problem rather
 * than a missing notification.
 *
 * So these lines **replace** the third-person one for the viewer, rather than
 * adding a second toast. The same string feeds the `aria-live` region, so a
 * screen-reader player gets the same improvement for free — and two toasts
 * saying one thing in two grammatical persons would be worse than either.
 *
 * ## What it deliberately stays out of
 *
 * **Anything that eliminates the viewer returns `null`.** Going out already has
 * `eliminationNotice.ts` — a dedicated, dismissible surface that states the
 * cause and stays up while the round plays on. A three-second toast racing that
 * overlay would be two answers to one question, and the worse one would be the
 * one that vanishes.
 *
 * **A card played on oneself returns `null`.** A player can target themselves
 * with a redraw; being told "you made yourself discard" is narrating a choice
 * back at the person who just made it. `actorId === viewerId` is the test.
 */

import type { PlayerId, PublicLogEntry } from '../../game/engine';
import type { NameOf } from './narration';

/**
 * What a card just did to this viewer, or `null` when it did nothing to them.
 *
 * Exhaustive over `PublicLogEntry` for the same reason `narrate` is: a new kind
 * that targets somebody should be a compile error here, not a silent gap that
 * only shows up as a player asking what happened to them.
 */
export function personalNotice(entry: PublicLogEntry, viewerId: PlayerId, nameOf: NameOf): string | null {
    switch (entry.kind) {
        case 'REDREW': {
            if (entry.targetId !== viewerId || entry.actorId === viewerId) return null;
            const actor = nameOf(entry.actorId);
            switch (entry.drewFrom) {
                case 'deck':
                    return `${actor} made you discard your hand. You drew a new card.`;
                case 'set-aside':
                    return `${actor} made you discard your hand. You drew the set-aside card.`;
                case 'none':
                    return `${actor} made you discard your hand. The deck was empty.`;
            }
        }

        case 'PEEKED':
            if (entry.targetId !== viewerId || entry.actorId === viewerId) return null;
            return `${nameOf(entry.actorId)} looked at your hand.`;

        case 'TRADED':
            if (entry.targetId !== viewerId || entry.actorId === viewerId) return null;
            return `${nameOf(entry.actorId)} traded hands with you.`;

        case 'GUESS':
            // A hit puts the viewer out, and the elimination notice says so.
            if (entry.targetId !== viewerId || entry.actorId === viewerId || entry.hit) return null;
            return `${nameOf(entry.actorId)} guessed you held a ${entry.guessedValue}. They were wrong.`;

        case 'COMPARE': {
            if (entry.targetId !== viewerId || entry.actorId === viewerId) return null;
            const actor = nameOf(entry.actorId);
            switch (entry.result) {
                // Again the elimination notice's job, not this one's.
                case 'target-eliminated':
                    return null;
                case 'actor-eliminated':
                    return `${actor} compared hands with you and is out.`;
                case 'tie':
                    return `${actor} compared hands with you. A tie — you both stay in.`;
            }
        }

        /**
         * Silent, and each for its own reason rather than by omission.
         *
         * `PLAY` and `FIZZLE` are the actor's own move, already narrated to the
         * table and visible as a card landing on their discard pile. `PROTECTED`
         * is a state a player put themselves in. `ELIMINATED` and `ROUND_END`
         * belong to surfaces that outlive a toast.
         */
        case 'PLAY':
        case 'FIZZLE':
        case 'PROTECTED':
        case 'ELIMINATED':
        case 'ROUND_END':
            return null;

        default: {
            const exhaustive: never = entry;
            return exhaustive;
        }
    }
}

/**
 * How long a personal notice stays up.
 *
 * Three seconds, as asked for. Shorter than the five a narration line gets, and
 * deliberately so: this one answers "what just happened to me", which is a
 * question the player is asking at that moment and has stopped asking shortly
 * after. A notice that outstays it is sitting over the table during the turn it
 * just told you about.
 */
export const PERSONAL_NOTICE_MS = 3000;
