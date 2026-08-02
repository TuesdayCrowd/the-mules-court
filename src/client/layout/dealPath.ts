/**
 * The arc a dealt card flies along, as an SVG path string.
 *
 * A card that slides in a straight line reads as a box moving. A card that
 * banks into its curve reads as *dealt* — so the deal beat drives its wrapper
 * with CSS motion path (`offset-path` / `offset-distance` / `offset-rotate`)
 * rather than interpolating a `translate()`. `offset-rotate: auto` then turns
 * the card to face along the tangent for free, which is the whole reason the
 * curve is worth generating at all.
 *
 * **It has to be generated.** The path string is coordinates, and this table is
 * responsive: the deck and a hand slot sit somewhere different at every
 * viewport. A literal path would be right at one size and wrong at every other.
 *
 * The coordinate space is **`from`'s own box** — origin at its top-left corner —
 * because that is where the drawing layer places the wrapper element, and
 * `path()` resolves against the element's own box. The start point is therefore
 * `(from.w / 2, from.h / 2)`, the centre of the deck, and everything else is
 * expressed relative to that same origin.
 *
 * Pure, and in `layout/` for the reason every other decision here is: geometry
 * is data. `dealPath.test.ts` holds it to its promises under plain Node with no
 * DOM at all — a path string is exactly the kind of thing that is easy to get
 * subtly wrong and impossible to eyeball in a screenshot.
 */

import type { Rect } from './types';

/**
 * How far the arc bows out of the straight line, as a fraction of the chord.
 *
 * Proportional rather than absolute, so a deal to the far side of a desktop
 * table and a deal to a hand slot two inches away on a phone read as the same
 * gesture. At 0 this degenerates to a slide; much past 0.25 the card loops
 * theatrically and stops looking like a hand dealing a card.
 */
const BOW = 0.18;

/**
 * Below this, the two rects are the same place and there is no chord to bow
 * around — normalising by a near-zero length is how a path string acquires a
 * `NaN` that silently disables the whole animation.
 */
const MIN_CHORD_PX = 1;

/** Two decimals: enough precision for a subpixel path, stable enough to assert on. */
function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

/**
 * The path from the centre of `from` to the centre of `to`, bowed upward.
 *
 * "Upward" is the side of the chord with the smaller `y`, chosen per direction
 * so a card dealt left and a card dealt right mirror each other instead of one
 * of them dipping under the table. A vertical chord has no upward side, so it
 * bows sideways; that is the degenerate case, not the intent.
 */
export function dealPath(from: Rect, to: Rect): string {
    const startX = from.w / 2;
    const startY = from.h / 2;
    const endX = to.x + to.w / 2 - from.x;
    const endY = to.y + to.h / 2 - from.y;

    const dx = endX - startX;
    const dy = endY - startY;
    const chord = Math.hypot(dx, dy);

    if (chord < MIN_CHORD_PX) {
        return `M ${round2(startX)},${round2(startY)} L ${round2(endX)},${round2(endY)}`;
    }

    // The unit normal to the chord, taken on the upward side. For a rightward
    // chord that is (dy, -dx); for a leftward one, its negation. Both give a
    // control point above the straight line between the two centres.
    const sign = dx >= 0 ? 1 : -1;
    const normalX = (sign * dy) / chord;
    const normalY = (-sign * dx) / chord;

    const bow = chord * BOW;
    const controlX = startX + dx / 2 + normalX * bow;
    const controlY = startY + dy / 2 + normalY * bow;

    return `M ${round2(startX)},${round2(startY)} Q ${round2(controlX)},${round2(controlY)} ${round2(endX)},${round2(endY)}`;
}
