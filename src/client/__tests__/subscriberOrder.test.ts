/**
 * The single subscriber's ordering constraints (interface rule 6).
 *
 * `main.ts` is the composition root and has no test of its own — it is the one
 * file that supplies the real `window`, `WebSocket` and `localStorage`, so there
 * is nothing to construct it against. What it does have is an order, and parts
 * of that order are correctness requirements rather than preferences.
 *
 * So this reads `main.ts` as text, the way `purity.test.ts` does. It cannot
 * prove the surfaces agree; it can prove nobody quietly swaps two lines back.
 *
 * **Two of these constraints retired with the canvas**, and they are recorded
 * here rather than deleted, because both look like things a future change might
 * reintroduce:
 *
 *   - *Draw before mirroring.* `a11yTwin` positioned its hand proxies from
 *     `court.currentLayout()`, which `renderView` set, so updating the twin
 *     first read the PREVIOUS push's layout — an empty accessible hand on the
 *     first deal, measured in a browser. There is no twin now: the cards are
 *     real buttons, so nothing mirrors anything and the hazard cannot recur.
 *   - *Wake before drawing.* The Phaser loop stopped when the table was still
 *     and had to be running for a new frame to reach the screen. The browser's
 *     compositor has no loop to wake.
 *
 * If either a shadow tree or a render pump ever comes back, the corresponding
 * ordering test has to come back with it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MAIN = readFileSync(join(import.meta.dirname, '..', '..', 'main.ts'), 'utf8');

/** Where a call appears inside the store subscriber, or -1. */
function positionOf(call: string): number {
    const start = MAIN.indexOf('store.subscribe(state => {');
    expect(start, 'the single subscriber was renamed').toBeGreaterThan(-1);
    const found = MAIN.indexOf(call, start);
    return found === -1 ? -1 : found;
}

describe('the single subscriber', () => {
    it('reassembles an open action sheet after the state it reassembles from', () => {
        // `uiRoot.update` is what tells the sheet about the connection and the
        // screen; `resyncOpenSheet` adds the half it cannot, and needs the
        // first to have happened.
        const resync = positionOf('resyncOpenSheet(state)');
        const uiRoot = positionOf('uiRoot.update(state)');

        expect(uiRoot, 'uiRoot left the subscriber').toBeGreaterThan(-1);
        expect(resync, 'resyncOpenSheet left the subscriber').toBeGreaterThan(-1);
        expect(resync).toBeGreaterThan(uiRoot);
    });

    it('redraws the table before queueing the beats that animate over it', () => {
        // A beat measures its rect from `table.currentLayout()`. Queued before
        // the table has taken this push, the layout it reads is the previous
        // one — so an elimination beat would play over the seat's OLD position
        // on any push that moved it. This is the surviving shape of the
        // draw-before-mirror constraint the twin used to impose.
        const update = positionOf('table.update(state)');
        const enqueue = positionOf('queue.enqueue(');

        expect(update, 'the table left the subscriber').toBeGreaterThan(-1);
        expect(enqueue, 'the beat queue left the subscriber').toBeGreaterThan(-1);
        expect(update, 'a beat would measure the layout from the previous push').toBeLessThan(enqueue);
    });

    it('closes the socket on a fatal before anything else reacts to it', () => {
        // Reconnecting into SEAT_TAKEN makes two tabs evict each other forever
        // — 22 evictions in three seconds against the real server. Every other
        // step in the subscriber may run on a fatal push; none may run first.
        const close = positionOf('socket?.close()');
        const uiRoot = positionOf('uiRoot.update(state)');

        expect(close, 'the fatal guard left the subscriber').toBeGreaterThan(-1);
        expect(close).toBeLessThan(uiRoot);
    });
});
