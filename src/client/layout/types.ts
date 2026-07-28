/**
 * The shape of a laid-out table (UIX §2.2, §6.1).
 *
 * Geometry is data. `computeLayout` returns one of these and the `Court` scene
 * consumes it; nothing in this directory has heard of Phaser, which is what lets
 * Vitest hold the design's spatial promises without booting a WebGL context.
 */

import type { Topology } from './topology';

export interface Rect {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
}

export interface LayoutInput {
    readonly w: number;
    readonly h: number;
    readonly opponentCount: 1 | 2 | 3;
    readonly handCount: 1 | 2;
    /** True in a two-player round: the face-up burn gets its own panel (UIX §6.1). */
    readonly showsRemovedCard: boolean;
    /** Worst-case discard count across all seats — drives pip sizing. */
    readonly maxDiscards: number;
}

/**
 * How the discard pips fit inside a seat chip (UIX §6.2).
 *
 * `perRow` is how many fit across at `size`; the renderer wraps at that count.
 * Between them they always account for every value in the pile — interface rule
 * 7 makes truncation a design failure, not a fallback.
 */
export interface PipSpec {
    readonly size: number;
    readonly perRow: number;
    readonly rows: number;
}

/**
 * How a seat chip's contents stack, top to bottom (UIX §6.2).
 *
 * Every offset is from the chip's own top edge, and every size scales with the
 * chip — which is the point. The nickname already scaled and the token row did
 * not: it sat at a literal `y + 26` while the name grew with the viewport, so
 * on anything larger than a phone the name's scrim was painted over the
 * devotion tokens and they simply vanished.
 *
 * Budgeting the chip here rather than in the scene is the same move `PipSpec`
 * already represents. Vitest can then hold "these bands do not overlap" at
 * every viewport size, which is what a literal offset could never be held to.
 */
export interface ChipSpec {
    /** Breathing room from the chip's edges, and between its bands. */
    readonly pad: number;
    /** Font size for the nickname. */
    readonly nameH: number;
    /** Height of the name's scrim, measured from the chip's top edge. */
    readonly nameBandH: number;
    /** Edge length of one devotion medallion, on a seat chip and the own row alike. */
    readonly medallion: number;
    /** Where the token row starts. Always at or below `nameBandH`. */
    readonly tokenTop: number;
    /** Where the pip block starts. Always at or below `tokenTop + medallion`. */
    readonly pipTop: number;
}

/**
 * The viewer's own "tokens + discards" row (UIX §6.1).
 *
 * Sized here rather than in the scene for the reason `ChipSpec` exists: the row
 * was the last place `Court.ts` still invented its own numbers, and it showed —
 * medallions at a flat 12px with the pips pushed past a hardcoded 60px span,
 * beside a discard list that could only render numerals.
 *
 * Every discard is drawn as its card face plus its value, so the row answers
 * "what have I played" the way a seat chip's revealed card does. Interface rule
 * 7 still holds: `iconW` is chosen so all of them fit rather than the last one
 * being dropped.
 */
export interface OwnRowSpec {
    /** Width the medallion run and its multiplier reserve on the left. */
    readonly medallionSpan: number;
    readonly iconH: number;
    readonly iconW: number;
    /** Distance between the left edges of two neighbouring discards. */
    readonly step: number;
    /** Font size for the value drawn under each face, and for the running total. */
    readonly valuePx: number;
}

export interface LayoutSpec {
    readonly topology: Topology;
    readonly viewport: Rect;
    readonly statusStrip: Rect;
    readonly opponents: readonly Rect[];
    readonly deck: Rect;
    readonly removedCard: Rect | null;
    readonly banner: Rect;
    readonly toastZone: Rect;
    readonly ownStatus: Rect;
    readonly hand: readonly Rect[];
    /**
     * Multiplier for a card sprite, relative to the 768×1024 art in
     * `public/assets/card-front/`. `sprite.setScale(cardScale)` renders a hand
     * card at `hand[i]`'s size.
     */
    readonly cardScale: number;
    readonly pip: PipSpec;
    readonly chip: ChipSpec;
    readonly ownRow: OwnRowSpec;
}
