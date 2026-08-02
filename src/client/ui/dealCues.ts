/**
 * One swish per card of a staggered deal, on the stagger the cards fly on.
 *
 * A module rather than four lines inside `main.ts`, for the two reasons the
 * four lines got wrong:
 *
 * **The offsets are not re-derived here.** `store/motion.ts` owns the stagger
 * and `dealDelayMs` is what `ui/beats.ts` flies the cards on, cap included. The
 * composition root computed `index * DEAL_STAGGER_MS` instead, so from the
 * eighth card the sound drifted away from the card it belonged to and kept
 * drifting — the renderer-re-derives-what-the-pure-layer-computed bug this
 * repository already knows by name. Past the cap the cards leave the deck
 * together and the swishes land together with them, which the `deal` spec's own
 * `minIntervalMs` then collapses to one sound. That is the correct number of
 * sounds for one visual event.
 *
 * **The timeouts are cancellable.** Fired and forgotten, a deal interrupted by a
 * fatal, by a return to the menu, or by the round ending kept swishing over a
 * screen with no table on it. `playDealCues` hands back the one function that
 * stops the rest.
 *
 * The first card sounds synchronously. It is the card leaving the deck at the
 * instant the beat starts, and a timer for a zero delay is a frame of slack
 * between a card and its own sound for nothing.
 */

import { dealDelayMs } from '../store/motion';
import type { SoundName } from '../store/sound';
import type { Timers } from './surface';

export interface DealCuesRequest {
    /** How many cards are flying. One sound each, at that card's own offset. */
    readonly count: number;
    readonly cue: SoundName;
    readonly play: (name: SoundName) => void;
    readonly timers: Timers;
}

/** Starts the deal's sounds and returns the cancel for whatever is still to come. */
export function playDealCues(request: DealCuesRequest): () => void {
    const pending: unknown[] = [];

    for (let index = 0; index < request.count; index += 1) {
        const delay = dealDelayMs(index);
        if (delay === 0) {
            request.play(request.cue);
            continue;
        }
        pending.push(request.timers.setTimeout(() => request.play(request.cue), delay));
    }

    return () => {
        for (const handle of pending) request.timers.clearTimeout(handle);
        pending.length = 0;
    };
}
