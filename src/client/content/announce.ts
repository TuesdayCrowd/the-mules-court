/**
 * One presentation event → one line, or deliberate silence.
 *
 * This exists because the alternative failed in exactly the way it was always
 * going to. `diffSnapshots` computes four kinds of beat; `main.ts` handled one
 * of them with an `if`, and the private peek shipped doing nothing visible at
 * all — the card was learned by the engine, sent to the client, diffed into a
 * `peek-gained` event, and then dropped on the floor.
 *
 * An exhaustive `switch` with a `never` default makes the next omission a
 * compile error instead. Silence is still allowed, but it has to be *chosen*.
 *
 * `announcementForViewer` below then answers the second half of the question —
 * not *what* is said but *which channel says it* — and it lives here for the
 * same reason: the alternative was a ternary in `main.ts`, which has no test
 * file and cannot get one.
 */

import type { PlayerId } from '../../game/engine';
import type { PresentationEvent } from '../store/diff';
import type { AnnounceKind } from '../store/presentationQueue';
import type { NameOf } from './narration';
import { narrate, narratePeek, narratePeekLost } from './narration';
import { personalNotice } from './personalNotice';
import { isTableNotice } from './tableNotice';

export function announcementFor(event: PresentationEvent, nameOf: NameOf): string | null {
    switch (event.kind) {
        case 'log':
            return narrate(event.entry, nameOf);

        case 'peek-gained':
            return narratePeek(nameOf(event.subjectId), event.cardTypeId);

        case 'peek-lost':
            return narratePeekLost(nameOf(event.subjectId));

        // Chosen silence, and the easiest of the three to argue: a card is
        // drawn at the start of every single turn. Narrating it would put a
        // line nobody needs between a screen-reader player and the play that
        // actually happened, several times a round. The hand itself is already
        // read from the table.
        case 'card-drawn':
            return null;

        // Chosen silence, not an oversight: the round-over overlay renders the
        // result from state, with the revealed hands and the countdown together.
        // Announcing it here would say it twice.
        case 'round-over':
            return null;

        // Chosen silence for the same reason: the match-over overlay states the
        // winner, the target, and the final tallies, and it is an `aria-live`
        // dialog in its own right.
        case 'match-over':
            return null;

        default: {
            const exhaustive: never = event;
            return exhaustive;
        }
    }
}

/** A line, and the channel that carries it. */
export interface Announcement {
    readonly line: string;
    readonly kind: AnnounceKind;
}

/**
 * The same event, resolved for one seat: what to say, and whether to paint it.
 *
 * Three channels, in strict precedence, and the order is the whole content of
 * this function:
 *
 * 1. **`personal`** — the card did something to this viewer, so `personalNotice`
 *    tells it in the second person and *replaces* the third-person line rather
 *    than adding to it. Two toasts saying one thing in two grammatical persons
 *    would be worse for a screen reader than either alone.
 * 2. **`table`** — a guess exchanged by two *other* seats (`tableNotice.ts` argues
 *    why that one is special). Same words `narrate` already produces, promoted
 *    out of the clipped channel so a bystander can read the value that was named.
 * 3. **`narration`** — everything else: heard through `aria-live`, never painted.
 *
 * `personal` outranking `table` is load-bearing rather than incidental. A guess
 * aimed at the viewer satisfies neither predicate at once — `isTableNotice`
 * excludes the target — but the precedence is what makes that a *guarantee*
 * instead of a coincidence between two files, and one event drawn twice is the
 * failure both of them exist to avoid.
 *
 * ## Why this is here and not in `main.ts`
 *
 * It was in `main.ts`, as a ternary, duplicated at both `queue.enqueue` sites.
 * `main.ts` is the composition root: it owns the socket, the document and every
 * ambient global, which is exactly why nothing tests it. A decision parked there
 * compiles, passes the whole suite, and is only ever checked by a person sitting
 * at a real table. Swapping the precedence or dropping the `kind === 'log'`
 * guard would have been invisible to every gate in the repo. Pure, both are a
 * test that fails when they change.
 */
export function announcementForViewer(event: PresentationEvent, viewerId: PlayerId, nameOf: NameOf): Announcement | null {
    const personal = event.kind === 'log' ? personalNotice(event.entry, viewerId, nameOf) : null;
    if (personal !== null) return { line: personal, kind: 'personal' };

    const line = announcementFor(event, nameOf);
    if (line === null) return null;

    const drawn = event.kind === 'log' && isTableNotice(event.entry, viewerId);
    return { line, kind: drawn ? 'table' : 'narration' };
}
