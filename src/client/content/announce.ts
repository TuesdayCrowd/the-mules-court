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
 */

import type { PresentationEvent } from '../store/diff';
import type { NameOf } from './narration';
import { narrate, narratePeek, narratePeekLost } from './narration';

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
