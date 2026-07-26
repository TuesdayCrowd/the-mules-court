/**
 * Rectangle predicates, shared by the layout tests and by canvas hit-testing.
 *
 * Kept apart from `tableLayout` so the tests that check the layout's promises do
 * not borrow the layout's own arithmetic to check them with.
 */

import type { Rect } from './types';

export function right(rect: Rect): number {
    return rect.x + rect.w;
}

export function bottom(rect: Rect): number {
    return rect.y + rect.h;
}

/**
 * True when the two rectangles share any area.
 *
 * Strict on every edge, so rectangles that merely touch do not count as
 * overlapping — abutting panels are a normal composition, not a collision.
 */
export function intersects(a: Rect, b: Rect): boolean {
    return a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a);
}

/** True when `inner` lies entirely within `outer`. Touching the boundary counts as inside. */
export function contains(outer: Rect, inner: Rect): boolean {
    return inner.x >= outer.x && inner.y >= outer.y && right(inner) <= right(outer) && bottom(inner) <= bottom(outer);
}
