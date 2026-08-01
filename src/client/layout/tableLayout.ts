/**
 * Table geometry as pure data (UIX §2.2, §6.1).
 *
 * `computeLayout(input) → LayoutSpec` is the whole surface. It imports nothing
 * from Phaser and reads no globals, so every spatial promise the design makes —
 * three chips fit a 390px phone, nothing overlaps, nothing escapes the viewport,
 * no discard value is ever hidden — is a Vitest assertion rather than a hope.
 *
 * Within a topology class the composition is fixed and every dimension is a
 * fraction of the live viewport. Elements are laid out as bands: some anchored
 * to the top, some to the bottom, with the toast zone absorbing whatever is
 * left. That is what keeps the invariants true at every seat count without a
 * table of hand-tuned offsets — only the flexible band changes size, and it is
 * defined by its neighbours' edges, so it cannot collide with them.
 */

import { MEDALLIONS_BEFORE_COLLAPSE } from './renderPlan';
import { classifyTopology } from './topology';
import type { Topology } from './topology';
import type { ChipSpec, LayoutInput, LayoutSpec, OwnRowSpec, PipSpec, Rect } from './types';

// --------------------------------------------------------------- proportions

/** Native width of the card art in `public/assets/card-front/`. `cardScale` is relative to it. */
const CARD_ART_WIDTH = 768;
/** 768×1024. Deck, removed card, and hand cards all keep it. */
const CARD_ASPECT = 0.75;

/** Outer margin, as a fraction of the shorter viewport edge. */
const MARGIN = 0.028;
/** Breathing room between bands, as a fraction of viewport height. */
const GAP = 0.012;
/** The toast zone may be squeezed to this, but never past it. */
const MIN_TOAST_H = 0.02;

/** Between adjacent opponent chips, as a fraction of viewport width. */
const CHIP_GAP = 0.021;
/** The burn panel is a smaller card than the deck — it is reference, not focus. */
const REMOVED_CARD_SCALE = 0.8;
const HAND_GAP = 0.031;
/** A single hand card never spans more than this much of the width. */
const HAND_MAX_CARD_W = 0.42;

/**
 * What differs between the three compositions (UIX §6.1).
 *
 * Every value is a fraction of the live viewport, so within a class the table is
 * fully fluid and the class boundaries are the layout's only discrete jumps.
 */
interface Proportions {
    readonly statusStripH: number;
    readonly chipH: number;
    readonly deckH: number;
    readonly bannerH: number;
    readonly ownStatusH: number;
    /** Cap on hand-card height; on every real viewport this is what binds, not width. */
    readonly handMaxCardH: number;
    /** How far the outer opponent chips drop below the centre one. Zero outside landscape-narrow. */
    readonly arcDepth: number;
    /** Only `wide` has the horizontal room to set the burn panel beside the deck. */
    readonly sideBySideRemoved: boolean;
}

const PROPORTIONS: Readonly<Record<Topology, Proportions>> = {
    portrait: {
        statusStripH: 0.045,
        chipH: 0.13,
        deckH: 0.115,
        bannerH: 0.04,
        ownStatusH: 0.05,
        handMaxCardH: 0.26,
        arcDepth: 0,
        sideBySideRemoved: false
    },
    // A rotated phone is short, so the bands take a larger share of a smaller
    // height. This class no longer spreads the hand — see `handStarts`.
    'landscape-narrow': {
        statusStripH: 0.06,
        chipH: 0.16,
        deckH: 0.13,
        bannerH: 0.055,
        ownStatusH: 0.06,
        handMaxCardH: 0.3,
        arcDepth: 0.045,
        sideBySideRemoved: false
    },
    // Generous seat panels with room for portrait art, and the burn panel beside
    // the deck rather than under it.
    wide: {
        statusStripH: 0.05,
        chipH: 0.2,
        deckH: 0.17,
        bannerH: 0.045,
        ownStatusH: 0.055,
        handMaxCardH: 0.3,
        arcDepth: 0,
        sideBySideRemoved: true
    }
};

// ---------------------------------------------------------------------- pips

/**
 * The deepest single-seat discard pile the layout reserves room for.
 *
 * **Eight, not the seven UIX §6.2 states.** Measured against the engine rather
 * than taken on trust — `discardCapacity.test.ts` sweeps seeds and play choices
 * at two, three, and four players and reaches eight at every seat count — and
 * the arithmetic says why. A two-player round deals a deck of ten, so turns
 * alternate and one seat takes five of them: five own-turn discards, plus the
 * two Prince-effect cards (Bayta and Toran) each forcing that seat to discard
 * out of turn, plus the one held card revealed on elimination. The design's
 * figure is one short because it counted a single Prince.
 *
 * The layout must fit reality rather than the estimate: a pip block sized for
 * seven would truncate the eighth value, and interface rule 7 makes that a
 * design failure rather than a graceful degradation.
 */
export const MAX_DISCARDS = 8;

/** Below this a pip's face stops reading as a card and becomes a smudge. */
export const MIN_PIP_PX = 8;
/**
 * The comfortable pip size on the smallest screen the game supports.
 *
 * A floor rather than a ceiling. It used to be a flat cap of 14px, which meant
 * a discard pile set at the same size on a 390px phone and a 1080p monitor —
 * correct on the phone and unreadable on the monitor, which is exactly how it
 * was reported. Pips now scale with the viewport like every other dimension
 * here, and this is where that scale starts.
 */
const BASE_PIP_PX = 14;
/** Share of viewport height a pip may claim once the screen is big enough to. */
const PIP_H_FRACTION = 0.02;
export const PIP_GAP_PX = 3;

/** The largest pip worth drawing on a viewport this tall. */
function comfortablePipPx(viewportH: number): number {
    return Math.max(BASE_PIP_PX, Math.round(viewportH * PIP_H_FRACTION));
}
/**
 * Share of the chip's height the pip block may claim.
 *
 * **0.4, where a block of bare numerals took 0.22.** A pip is a card face with
 * its value under it now, so one row is roughly two and a half times as tall as
 * the numeral it replaces: the face alone is `size / CARD_ASPECT` — a third
 * taller than it is wide — and the value rides beneath it. Left at 0.22 the
 * search below would have shrunk every face towards the floor to fit a share of
 * the chip sized for something else, and `chipHeightFor` would then have grown
 * the chip by the same misjudged ratio — on a 320px phone to nearly three times
 * its nominal height, pushing the deck and the hand off the bottom of the
 * table. The fraction describes what the block actually contains.
 *
 * It is not the safety net. `chipBands` still anchors the block to the chip's
 * bottom edge and `bandsFit` still holds the bands above it clear, so this only
 * decides how hard the pips are squeezed before the chip is asked to give.
 */
const PIP_AREA_H = 0.4;
/** Share of the chip's width, inside its padding. */
const PIP_AREA_W = 0.88;

/**
 * The value under a face, as a share of the face's width, with a legible floor.
 *
 * The floor is the point. A face may shrink until it is barely a card, but the
 * number under it is what every rule in the game is written in and what a player
 * counts to work out who is holding what — so it stops at the same 10px the own
 * row and the chip's small lines already stop at, whatever the pile does.
 */
const PIP_VALUE_FRACTION = 0.85;
const MIN_PIP_VALUE_PX = 10;

function pipValuePx(size: number): number {
    return Math.max(MIN_PIP_VALUE_PX, Math.round(size * PIP_VALUE_FRACTION));
}

function pipRowsAt(size: number, count: number, areaW: number): { perRow: number; rows: number } {
    const perRow = Math.max(1, Math.floor((areaW + PIP_GAP_PX) / (size + PIP_GAP_PX)));
    return { perRow, rows: Math.ceil(count / perRow) };
}

/**
 * How tall one discard's face is: `size` is its width, and a card is a card.
 *
 * A function rather than a field for the reason `pipBlockHeight` is one — it is
 * derived geometry, and the renderer must read it rather than reach for an
 * aspect constant of its own. Rounded so the block's height is the sum of whole
 * pixels the renderer actually writes into `style.height`.
 */
export function pipFaceHeight(spec: PipSpec): number {
    return Math.round(spec.size / CARD_ASPECT);
}

/** One face plus the value beneath it — what a row of the block occupies. */
export function pipRowHeight(spec: PipSpec): number {
    return pipFaceHeight(spec) + spec.valuePx;
}

export function pipBlockHeight(spec: PipSpec): number {
    return spec.rows * pipRowHeight(spec) + (spec.rows - 1) * PIP_GAP_PX;
}

/** The chip height a pip block needs, given the share of the chip it may claim. */
function chipHeightFor(spec: PipSpec): number {
    return pipBlockHeight(spec) / PIP_AREA_H;
}

// --------------------------------------------------------------- chip contents

/** Breathing room from a chip's edges, and between the bands inside it. */
const CHIP_PAD = 6;

/** The nickname, as a share of chip height with a legible floor. */
const MIN_SEAT_NAME_PX = 14;
const SEAT_NAME_FRACTION = 0.13;

/**
 * A devotion medallion, sized the same way.
 *
 * It used to be a flat 12px — the exact complaint the pips already answered: one
 * size is right for a 390px phone or for a 1080p monitor, never both.
 */
const MIN_MEDALLION_PX = 10;
const MEDALLION_FRACTION = 0.06;

/**
 * The two small lines under the tokens: the peek marker and the state caption.
 *
 * Both were pinned at 11px and neither had any space reserved for it — the
 * caption was positioned from the chip's bottom edge, which is where the pip
 * block already lives.
 */
const MIN_SMALL_LINE_PX = 10;
const SMALL_LINE_FRACTION = 0.075;

/**
 * What one line of text actually occupies, as a multiple of its size.
 *
 * Generous on purpose: this budget is what keeps two bands apart, and only
 * Phaser knows exactly how tall a string set, so the reserve has to be at least
 * as large as the tallest it could be. A little slack costs a few pixels; too
 * little puts the caption back in the pips.
 */
const LINE_HEIGHT = 1.3;

/** Between the two small lines, which are close kin and need less air than a band. */
const SMALL_GAP = 3;

/**
 * Where a chip's bands sit, for a chip of this height.
 *
 * Stacked strictly: name band, then tokens, then pips against the bottom edge.
 * The bug this replaces was a token row at a literal `y + 26` beneath a name
 * that grew with the viewport, so this derives every offset from the one before
 * it and no two can drift apart.
 */
function chipBands(chipH: number, pip: PipSpec): ChipSpec {
    const nameH = Math.max(MIN_SEAT_NAME_PX, Math.round(chipH * SEAT_NAME_FRACTION));
    const medallion = Math.max(MIN_MEDALLION_PX, Math.round(chipH * MEDALLION_FRACTION));
    const nameBandH = nameH + CHIP_PAD * 2;

    const smallPx = Math.max(MIN_SMALL_LINE_PX, Math.round(chipH * SMALL_LINE_FRACTION));
    const smallH = Math.round(smallPx * LINE_HEIGHT);

    const tokenTop = nameBandH;
    const markerTop = tokenTop + medallion + SMALL_GAP;
    const captionTop = markerTop + smallH + SMALL_GAP;

    return {
        pad: CHIP_PAD,
        nameH,
        nameBandH,
        medallion,
        tokenTop,
        smallPx,
        smallH,
        markerTop,
        captionTop,
        // Against the bottom edge, so the pile grows upward into the space the
        // bands above are guaranteed to have left.
        pipTop: chipH - pipBlockHeight(pip) - CHIP_PAD
    };
}

/**
 * Whether a chip of this height holds every band without them meeting.
 *
 * The caption is the lowest, so clearing the pips clears everything above it —
 * each band's top is derived from the one before, which is the property that
 * makes one comparison enough.
 */
function bandsFit(chipH: number, pip: PipSpec): boolean {
    const bands = chipBands(chipH, pip);
    return bands.captionTop + bands.smallH + SMALL_GAP <= bands.pipTop;
}

/**
 * The smallest chip that holds name, tokens and pips at once.
 *
 * Iterated rather than solved: `nameH` and `medallion` are both `max(floor,
 * fraction × chipH)`, so the requirement is piecewise linear and a closed form
 * would be a rounding bug waiting to happen. It converges — the bands claim
 * about a fifth of any growth — and the loop is bounded so a future proportion
 * that did not converge would give a slightly small chip rather than hang.
 */
function chipHeightForBands(floor: number, pip: PipSpec): number {
    let chipH = floor;

    for (let attempt = 0; attempt < 8 && !bandsFit(chipH, pip); attempt++) {
        const bands = chipBands(chipH, pip);
        // Exactly the shortfall, so growth stops as soon as the bands clear.
        chipH += bands.captionTop + bands.smallH + SMALL_GAP - bands.pipTop;
    }

    return chipH;
}

/**
 * The largest legible pip size that shows every discard in the pile (UIX §6.2).
 *
 * Searched downward from the comfortable size rather than solved, because
 * `perRow` steps in integers: shrinking a pip can drop a whole row, so the
 * height needed is not a smooth function of the size and a closed form would be
 * a rounding bug waiting to happen. Candidate sizes are cheap and this runs
 * once per resize.
 *
 * Pips give way before the chip does — interface rule 7 makes a hidden discard a
 * design failure, and a chip that grew instead would push the deck off a phone.
 * Only when the floor itself will not fit does the caller widen the block.
 *
 * Faces are wider than the numerals this used to pack, so a size that fitted one
 * row of eight numerals fits fewer faces and the search settles lower. That is
 * the trade the design asks for: the face is an aid, and it is the aid that
 * shrinks — `pipValuePx` floors the value it sits above.
 */
function fitPips(count: number, chip: { w: number; h: number }, maxSize: number): PipSpec {
    const areaW = chip.w * PIP_AREA_W;
    const areaH = chip.h * PIP_AREA_H;
    const pips = Math.max(1, count);

    for (let size = maxSize; size >= MIN_PIP_PX; size--) {
        const { perRow, rows } = pipRowsAt(size, pips, areaW);
        const spec: PipSpec = { size, valuePx: pipValuePx(size), perRow, rows };
        if (pipBlockHeight(spec) <= areaH) return spec;
    }

    // The floor still overflows on a very small phone: keep every discard and
    // let the block be tall. `computeLayout` grows the chip to match — nothing
    // disappears, which is the whole of interface rule 7.
    const { perRow, rows } = pipRowsAt(MIN_PIP_PX, pips, areaW);
    return { size: MIN_PIP_PX, valuePx: pipValuePx(MIN_PIP_PX), perRow, rows };
}

// ------------------------------------------------------------------- helpers

function centred(w: number, h: number, containerW: number, y: number): Rect {
    return { x: (containerW - w) / 2, y, w, h };
}

/**
 * How far chip `index` drops below the top of the opponent band.
 *
 * A shallow arc: the centre chip sits highest and the outer ones swing down, so
 * the far side of the table reads as further away (UIX §6.1). Fewer than three
 * chips have no centre to arc around, so they stay level — two chips pushed
 * down by the same amount is not an arc, just a lower row.
 */
function arcOffset(index: number, count: number, depth: number): number {
    if (depth === 0 || count < 3) return 0;
    const fromCentre = Math.abs((2 * index) / (count - 1) - 1); // 1 at the ends, 0 at the centre
    return depth * fromCentre * fromCentre;
}

/**
 * Horizontal starts for the hand, always centred as one block.
 *
 * *UIX §6.1* had `landscape-narrow` spread the hand to both margins, on the
 * reasoning that a phone held in landscape has a thumb at each edge. In
 * practice it read as broken on every screen it reached — the two cards sat in
 * opposite corners with the whole table between them, and the right-hand one
 * landed under the quick-reference button. It was reported three times, from
 * three different viewports, before the spread was removed outright rather
 * than narrowed again.
 *
 * **Superseding §6.1**, recorded here rather than decided quietly: the hand is
 * one block in the middle at every size. A player looks at their hand as a
 * pair, and a pair split across a metre of desk is not a pair.
 */
function handStarts(count: number, cardW: number, margin: number, contentW: number, gapPx: number): number[] {
    const blockW = cardW * count + gapPx * (count - 1);
    const startX = margin + (contentW - blockW) / 2;
    return Array.from({ length: count }, (_, i) => startX + i * (cardW + gapPx));
}

// ------------------------------------------------------------- own status row

/** Share of the row's height a discard face may claim. */
const OWN_ICON_H_FRACTION = 0.86;
/** Below this a card face stops being recognisable and is just a rectangle. */
const MIN_OWN_ICON_H = 18;
const OWN_ICON_GAP = 4;
/** Room kept at the right end for the `= 14` running total. */
const OWN_TOTAL_RESERVE = 52;

/**
 * How the own row packs medallions, discard faces and a total across one line.
 *
 * Width is the binding constraint, not height: eight faces at the row's full
 * height overflow a phone long before they overflow the row. So the face is the
 * smaller of what the height allows and what the remaining width allows, with a
 * floor — and `tableLayout.test.ts` holds the whole run inside the row at every
 * viewport, the same promise `fitPips` makes for a chip.
 */
function fitOwnRow(row: Rect, count: number, medallion: number): OwnRowSpec {
    const medallionSpan = medallionRunWidth(medallion) + 12;
    const slots = Math.max(1, count);
    const available = Math.max(0, row.w - medallionSpan - OWN_TOTAL_RESERVE);

    const byHeight = row.h * OWN_ICON_H_FRACTION;
    const byWidth = (available - OWN_ICON_GAP * (slots - 1)) / slots / CARD_ASPECT;

    const iconH = Math.max(MIN_OWN_ICON_H, Math.min(byHeight, byWidth));
    const iconW = iconH * CARD_ASPECT;

    return {
        medallionSpan,
        iconH,
        iconW,
        step: iconW + OWN_ICON_GAP,
        // The value rides under the face, so it takes what the face left over.
        valuePx: Math.max(MIN_OWN_VALUE_PX, Math.round(Math.min(row.h - iconH, iconH * 0.4)))
    };
}

/**
 * The gap between two devotion medallions.
 *
 * Exported because the drawing needs the same number: `ownRow.medallionSpan` is
 * measured with it here, and whatever paints the medallions steps by it. It was
 * declared twice — once here, once at the bottom of `Court.ts` — with a comment
 * on each asking the reader to keep them in step by hand. One of the two is now
 * the other's import.
 */
export const MEDALLION_GAP = 2;
const MIN_OWN_VALUE_PX = 10;

/**
 * How wide a full run of devotion medallions is, at this medallion size.
 *
 * The run is what `medallionPlan` allows to be drawn — at most
 * `MEDALLIONS_BEFORE_COLLAPSE` of them, stepping by `medallion + MEDALLION_GAP`
 * — and `ownRow.medallionSpan` is this plus the multiplier's own room.
 *
 * Published because a renderer needs the same number for the run's tap target,
 * and the seat chip had been guessing at it with a literal `medallion * 5`
 * while the viewer's own row read `medallionSpan`: two formulas for one
 * measurement, neither of them the run actually drawn (46px against a 50px
 * target at `medallion = 10`). Re-deriving geometry the pure layer already
 * decided is exactly what `tableContract.test.ts` exists to catch.
 */
export function medallionRunWidth(medallion: number): number {
    return medallion * MEDALLIONS_BEFORE_COLLAPSE + MEDALLION_GAP * (MEDALLIONS_BEFORE_COLLAPSE - 1);
}

// ------------------------------------------------------------------- layout

export function computeLayout(input: LayoutInput): LayoutSpec {
    const { w, h } = input;
    const topology = classifyTopology(w, h);
    const p = PROPORTIONS[topology];
    const margin = MARGIN * Math.min(w, h);
    const gap = GAP * h;
    const contentW = w - margin * 2;

    // --- anchored to the top
    const statusStrip: Rect = { x: margin, y: margin, w: contentW, h: p.statusStripH * h };

    // Pips are fitted before the chip height is final, because on a very small
    // phone even floor-sized pips need more rows than the nominal chip affords —
    // and then the chip is what gives way, never a discard value.
    const chipGap = CHIP_GAP * w;
    const chipW = (contentW - chipGap * (input.opponentCount - 1)) / input.opponentCount;
    const nominalChipH = p.chipH * h;
    const pip = fitPips(input.maxDiscards, { w: chipW, h: nominalChipH }, comfortablePipPx(h));
    // Then the same again for the nickname and the token row, which had no
    // budget at all and so collided with each other instead.
    const chipH = chipHeightForBands(Math.max(nominalChipH, chipHeightFor(pip)), pip);
    const chip = chipBands(chipH, pip);

    const chipTop = statusStrip.y + statusStrip.h + gap;
    const arcDepth = p.arcDepth * h;
    const opponents: Rect[] = Array.from({ length: input.opponentCount }, (_, i) => ({
        x: margin + i * (chipW + chipGap),
        y: chipTop + arcOffset(i, input.opponentCount, arcDepth),
        w: chipW,
        h: chipH
    }));

    const deckH = p.deckH * h;
    const deckW = deckH * CARD_ASPECT;
    // The band is as deep as the lowest chip in the arc, not just the first.
    const deckY = chipTop + (input.opponentCount >= 3 ? arcDepth : 0) + chipH + gap;

    const removedH = deckH * REMOVED_CARD_SCALE;
    const removedW = removedH * CARD_ASPECT;

    let removedCard: Rect | null = null;
    let deck: Rect;

    if (input.showsRemovedCard && p.sideBySideRemoved) {
        const pairW = deckW + gap + removedW;
        const pairX = (w - pairW) / 2;
        deck = { x: pairX, y: deckY, w: deckW, h: deckH };
        removedCard = { x: pairX + deckW + gap, y: deckY, w: removedW, h: removedH };
    } else {
        deck = centred(deckW, deckH, w, deckY);
        if (input.showsRemovedCard) {
            removedCard = centred(removedW, removedH, w, deckY + deckH + gap);
        }
    }

    // The lower of the two edges, not the burn panel's. Set side by side the
    // panel is the shorter card and sits level with the deck, so taking its
    // bottom would ride the banner up through the deck above it.
    const deckBlockBottom = Math.max(deck.y + deck.h, removedCard === null ? 0 : removedCard.y + removedCard.h);
    const banner: Rect = { x: margin, y: deckBlockBottom + gap, w: contentW, h: p.bannerH * h };

    // --- anchored to the bottom, compressed if the top block has taken the room
    const ownStatusH = p.ownStatusH * h;
    const handGapPx = HAND_GAP * w;

    const idealCardW = Math.min(
        (contentW - handGapPx * (input.handCount - 1)) / input.handCount,
        HAND_MAX_CARD_W * w,
        p.handMaxCardH * h * CARD_ASPECT
    );

    // Everything below the banner has to share what is left. The hand is the
    // biggest thing down there and the only one that can afford to give, so it
    // is what shrinks — a rotated phone showing a burn panel and two cards
    // otherwise drives the hand straight through the banner above it.
    const bottomBudget = h - margin - (banner.y + banner.h + gap + MIN_TOAST_H * h + gap);
    const cardH = Math.min(idealCardW / CARD_ASPECT, Math.max(0, bottomBudget - ownStatusH - gap));
    const cardW = cardH * CARD_ASPECT;

    const handY = h - margin - cardH;

    const hand: Rect[] = handStarts(input.handCount, cardW, margin, contentW, handGapPx).map(x => ({
        x,
        y: handY,
        w: cardW,
        h: cardH
    }));

    const ownStatus: Rect = { x: margin, y: handY - gap - ownStatusH, w: contentW, h: ownStatusH };

    // --- whatever is left in the middle
    const toastTop = banner.y + banner.h + gap;
    const toastZone: Rect = {
        x: margin,
        y: toastTop,
        w: contentW,
        h: Math.max(0, ownStatus.y - gap - toastTop)
    };

    return {
        topology,
        viewport: { x: 0, y: 0, w, h },
        statusStrip,
        opponents,
        deck,
        removedCard,
        banner,
        toastZone,
        ownStatus,
        hand,
        cardScale: cardW / CARD_ART_WIDTH,
        pip,
        chip,
        ownRow: fitOwnRow(ownStatus, input.maxDiscards, chip.medallion)
    };
}
