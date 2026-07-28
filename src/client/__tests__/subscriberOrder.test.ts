/**
 * The single subscriber's ordering constraints (interface rule 6).
 *
 * `main.ts` is the composition root and has no test of its own — it is the one
 * file that supplies the real `window`, `WebSocket` and `localStorage`, so there
 * is nothing to construct it against. What it does have is an order, and one
 * step of that order is a correctness requirement rather than a preference:
 *
 *   `a11yTwin` positions its hand proxies from `court.currentLayout()`, and
 *   `renderView` is what sets that layout. With the twin updated first it read
 *   the layout from the previous push, so on the first deal there was none and
 *   the accessible hand was empty. Measured in a browser: nought proxies until
 *   some later state update happened along, then one.
 *
 * So this reads `main.ts` as text, the way `purity.test.ts` does. It cannot
 * prove the surfaces agree; it can prove nobody quietly swaps two lines back.
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
    it('draws the table before mirroring it', () => {
        const render = positionOf('court?.renderView(state)');
        const twin = positionOf('twin.update(state)');

        expect(render, 'renderView left the subscriber').toBeGreaterThan(-1);
        expect(twin, 'the twin left the subscriber').toBeGreaterThan(-1);
        expect(render, 'the twin reads the layout renderView has not computed yet').toBeLessThan(twin);
    });

    it('wakes the render loop before anything that needs drawing', () => {
        // The loop stops when the table is still, and a push is the commonest
        // reason it must start again. Waking after the draw would leave the
        // new frame sitting unrendered until the next thing woke it.
        const wake = positionOf('pump.wake()');
        const render = positionOf('court?.renderView(state)');

        expect(wake, 'the pump left the subscriber').toBeGreaterThan(-1);
        expect(wake).toBeLessThan(render);
    });

    it('reassembles an open action sheet after the state it reassembles from', () => {
        expect(positionOf('resyncOpenSheet(state)')).toBeGreaterThan(positionOf('uiRoot.update(state)'));
    });
});
