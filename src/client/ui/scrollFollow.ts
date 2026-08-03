/**
 * Terminal scroll semantics for a container that is rebuilt rather than diffed.
 *
 * The match log is append-only and unbounded, and both surfaces that show it —
 * the dock's log tab and the seat dossier's — rebuild their whole body on every
 * state push. Replacing the scroll container discards its `scrollTop`, so every
 * new line threw the reader back to the top of the match.
 *
 * The rule is the one a terminal follows, and it is two rules:
 *
 *  - **Resting at the bottom means follow.** New lines arrive and stay in view.
 *  - **Scrolled up means stay put.** Someone reading round two is not dragged
 *    to round six because round six happened.
 *
 * Capture before the rebuild, apply after. This is deliberately not a diffing
 * renderer: the log is a few dozen list items, and rebuilding it is cheap. It
 * is only the scroll position that cannot survive the rebuild by itself.
 */

export interface ScrollAnchor {
    /** Where the reader was, in pixels from the top. */
    readonly top: number;
    /** True when they were resting at the bottom and should be carried along. */
    readonly pinnedToBottom: boolean;
}

/**
 * The anchor for a container that does not exist yet.
 *
 * Following, not `top: 0`: a log opened mid-match should show what just
 * happened, which is the same answer a terminal gives on a fresh window.
 */
export const FOLLOWING: ScrollAnchor = { top: 0, pinnedToBottom: true };

/**
 * How near the bottom still counts as being at it.
 *
 * Not zero. A fractional device pixel ratio or browser zoom leaves `scrollTop`
 * a hair under `scrollHeight - clientHeight`, and an exact comparison reads a
 * pinned log as scrolled — so following would stop the moment someone zoomed.
 */
const BOTTOM_TOLERANCE_PX = 4;

export function isAtBottom(top: number, clientHeight: number, scrollHeight: number): boolean {
    return scrollHeight - top - clientHeight <= BOTTOM_TOLERANCE_PX;
}

/** Where the reader is now, read before the container is replaced. */
export function anchorOf(element: HTMLElement | null | undefined): ScrollAnchor {
    if (element === null || element === undefined) return FOLLOWING;
    return {
        top: element.scrollTop,
        pinnedToBottom: isAtBottom(element.scrollTop, element.clientHeight, element.scrollHeight)
    };
}

/**
 * Where the rebuilt container should sit.
 *
 * A follower goes to the NEW bottom, which is the whole point — the container
 * just grew by however many lines arrived. `Math.max` guards the case where the
 * content is shorter than the box, which would otherwise be a negative top.
 */
export function scrollTopFor(anchor: ScrollAnchor, clientHeight: number, scrollHeight: number): number {
    return anchor.pinnedToBottom ? Math.max(scrollHeight - clientHeight, 0) : anchor.top;
}

export function applyAnchor(element: HTMLElement, anchor: ScrollAnchor): void {
    element.scrollTop = scrollTopFor(anchor, element.clientHeight, element.scrollHeight);
}
