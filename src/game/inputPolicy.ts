/**
 * How much of the page Phaser is allowed to hear about (interface rule 9).
 *
 * Kept out of `main.ts` so it can be asserted without constructing a Game — and
 * so the reasoning sits with the value rather than in a config literal someone
 * would reasonably tidy away.
 */
export const POINTER_POLICY = {
    /**
     * **Off, and load-bearing.**
     *
     * With this on — Phaser's default — `MouseManager` binds `mousedown` and
     * `mouseup` to `window.top`, and its handler reads:
     *
     * ```js
     * // Only process the event if the target isn't the canvas
     * if (... && event.target !== canvas) manager.onMouseDown(event);
     * ```
     *
     * So a tap on a DOM button *above* the canvas is precisely the case Phaser
     * decides to process. It hit-tests the game objects under those coordinates
     * and fires `pointerdown` on whatever is there — which made every tap on the
     * action sheet also select the hand card beneath it, reopening the sheet for
     * that card instead of choosing a target or a guess. `TouchManager` binds
     * the same pair, so touch behaved identically.
     *
     * The canvas keeps its own listeners either way, so taps on the table are
     * unaffected. What is given up is `POINTER_UP_OUTSIDE` — a press released
     * off-canvas — which this game has no use for: every interaction is a tap,
     * and there is nothing to drag.
     */
    windowEvents: false
} as const;
