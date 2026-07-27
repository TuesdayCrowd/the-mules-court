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

import { classifyTopology, isHandheldLandscape } from './topology';
import type { Topology } from './topology';
import type { LayoutInput, LayoutSpec, PipSpec, Rect } from './types';

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
    /** Landscape-narrow spreads the hand to both thumbs instead of centring it. */
    readonly spreadHand: boolean;
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
        spreadHand: false,
        sideBySideRemoved: false
    },
    // A rotated phone is short: bands take a larger share of a smaller height,
    // and the hand spreads wide because both thumbs are at the edges.
    'landscape-narrow': {
        statusStripH: 0.06,
        chipH: 0.16,
        deckH: 0.13,
        bannerH: 0.055,
        ownStatusH: 0.06,
        handMaxCardH: 0.3,
        arcDepth: 0.045,
        spreadHand: true,
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
        spreadHand: false,
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

/** Below this a pip stops reading as a value and becomes a dot. */
export const MIN_PIP_PX = 8;
/** Above this pips crowd the nickname out of the chip. */
const MAX_PIP_PX = 14;
const PIP_GAP_PX = 3;
/** Share of the chip's height the pip block may claim. */
const PIP_AREA_H = 0.22;
/** Share of the chip's width, inside its padding. */
const PIP_AREA_W = 0.88;

function pipRowsAt(size: number, count: number, areaW: number): { perRow: number; rows: number } {
    const perRow = Math.max(1, Math.floor((areaW + PIP_GAP_PX) / (size + PIP_GAP_PX)));
    return { perRow, rows: Math.ceil(count / perRow) };
}

export function pipBlockHeight(spec: PipSpec): number {
    return spec.rows * spec.size + (spec.rows - 1) * PIP_GAP_PX;
}

/** The chip height a pip block needs, given the share of the chip it may claim. */
function chipHeightFor(spec: PipSpec): number {
    return pipBlockHeight(spec) / PIP_AREA_H;
}

/**
 * The largest legible pip size that shows every value in the pile (UIX §6.2).
 *
 * Searched downward from the comfortable size rather than solved, because
 * `perRow` steps in integers: shrinking a pip can drop a whole row, so the
 * height needed is not a smooth function of the size and a closed form would be
 * a rounding bug waiting to happen. Seven candidate sizes, once per resize.
 *
 * Pips give way before the chip does — interface rule 7 makes a hidden value a
 * design failure, and a chip that grew instead would push the deck off a phone.
 * Only when the floor itself will not fit does the caller widen the block.
 */
function fitPips(count: number, chip: { w: number; h: number }): PipSpec {
    const areaW = chip.w * PIP_AREA_W;
    const areaH = chip.h * PIP_AREA_H;
    const pips = Math.max(1, count);

    for (let size = MAX_PIP_PX; size >= MIN_PIP_PX; size--) {
        const { perRow, rows } = pipRowsAt(size, pips, areaW);
        if (pipBlockHeight({ size, perRow, rows }) <= areaH) return { size, perRow, rows };
    }

    // The floor still overflows on a very small phone: keep every value and let
    // the block be tall. `computeLayout` grows the chip to match — the values do
    // not disappear, which is the whole of interface rule 7.
    const { perRow, rows } = pipRowsAt(MIN_PIP_PX, pips, areaW);
    return { size: MIN_PIP_PX, perRow, rows };
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

/** Horizontal starts for the hand: spread to the margins, or centred as a block. */
function handStarts(count: number, cardW: number, margin: number, contentW: number, gapPx: number, spread: boolean): number[] {
    if (count === 1) return [margin + (contentW - cardW) / 2];

    if (spread) {
        const step = (contentW - cardW) / (count - 1);
        return Array.from({ length: count }, (_, i) => margin + i * step);
    }

    const blockW = cardW * count + gapPx * (count - 1);
    const startX = margin + (contentW - blockW) / 2;
    return Array.from({ length: count }, (_, i) => startX + i * (cardW + gapPx));
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
    // Pips are fitted before the chip height is final, because on a very small
    // phone even floor-sized pips need more rows than the nominal chip affords —
    // and then the chip is what gives way, never a discard value.
    const chipGap = CHIP_GAP * w;
    const chipW = (contentW - chipGap * (input.opponentCount - 1)) / input.opponentCount;
    const nominalChipH = p.chipH * h;
    const pip = fitPips(input.maxDiscards, { w: chipW, h: nominalChipH });
    const chipH = Math.max(nominalChipH, chipHeightFor(pip));

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

    // The spread is a reach affordance, not a composition choice: it puts both
    // cards under the thumbs of a phone held in landscape. The class alone is
    // not enough to authorise it — `landscape-narrow` is decided by height, and
    // a 1400×559 desktop window is short without being holdable. Both questions
    // have to agree: this composition spreads, AND this viewport has edges a
    // thumb can reach.
    const spreadHand = p.spreadHand && isHandheldLandscape(w, h);

    const hand: Rect[] = handStarts(input.handCount, cardW, margin, contentW, handGapPx, spreadHand).map(x => ({
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
        pip
    };
}
