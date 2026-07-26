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

import { classifyTopology } from './topology';
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

const STATUS_STRIP_H = 0.045;
const CHIP_H = 0.13;
/** Between adjacent opponent chips, as a fraction of viewport width. */
const CHIP_GAP = 0.021;
const DECK_H = 0.115;
/** The burn panel is a smaller card than the deck — it is reference, not focus. */
const REMOVED_CARD_SCALE = 0.8;
const BANNER_H = 0.04;
const OWN_STATUS_H = 0.05;
const HAND_GAP = 0.031;
/** A single hand card never spans more than this much of the width. */
const HAND_MAX_CARD_W = 0.42;
/** Nor more than this much of the height, which is what actually binds on a tall phone. */
const HAND_MAX_CARD_H = 0.26;

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

/** Evenly spaced boxes of equal width, filling `span` with `gap` between them. */
function row(count: number, x: number, span: number, gap: number, y: number, h: number): Rect[] {
    const w = (span - gap * (count - 1)) / count;
    return Array.from({ length: count }, (_, i) => ({ x: x + i * (w + gap), y, w, h }));
}

function centred(w: number, h: number, containerW: number, y: number): Rect {
    return { x: (containerW - w) / 2, y, w, h };
}

/** Card box for the hand: as large as width and height budgets both allow. */
function handCardSize(input: LayoutInput, availableW: number): { w: number; h: number } {
    const gaps = HAND_GAP * input.w * (input.handCount - 1);
    const byWidth = Math.min((availableW - gaps) / input.handCount, HAND_MAX_CARD_W * input.w);
    const byHeight = HAND_MAX_CARD_H * input.h * CARD_ASPECT;
    const w = Math.min(byWidth, byHeight);
    return { w, h: w / CARD_ASPECT };
}

// ------------------------------------------------------------------- layout

export function computeLayout(input: LayoutInput): LayoutSpec {
    const { w, h } = input;
    const topology = classifyTopology(w, h);
    const margin = MARGIN * Math.min(w, h);
    const gap = GAP * h;
    const contentW = w - margin * 2;

    // --- anchored to the top
    const statusStrip: Rect = { x: margin, y: margin, w: contentW, h: STATUS_STRIP_H * h };

    // Pips are fitted before the chip height is final, because on a very small
    // phone even floor-sized pips need more rows than the nominal chip affords —
    // and then the chip is what gives way, never a discard value.
    const chipGap = CHIP_GAP * w;
    const chipW = (contentW - chipGap * (input.opponentCount - 1)) / input.opponentCount;
    const nominalChipH = CHIP_H * h;
    const pip = fitPips(input.maxDiscards, { w: chipW, h: nominalChipH });
    const chipH = Math.max(nominalChipH, chipHeightFor(pip));

    const opponents = row(
        input.opponentCount,
        margin,
        contentW,
        chipGap,
        statusStrip.y + statusStrip.h + gap,
        chipH
    );

    const deckH = DECK_H * h;
    const deckW = deckH * CARD_ASPECT;
    const deckY = opponents[0].y + chipH + gap;

    // Portrait and landscape-narrow stack the burn panel below the deck; only
    // `wide` has the horizontal room to set it beside (UIX §6.1).
    const removedH = deckH * REMOVED_CARD_SCALE;
    const removedW = removedH * CARD_ASPECT;
    const sideBySide = topology === 'wide';

    let removedCard: Rect | null = null;
    let deck: Rect;

    if (input.showsRemovedCard && sideBySide) {
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

    const deckBlockBottom = removedCard === null ? deck.y + deck.h : removedCard.y + removedCard.h;
    const banner: Rect = { x: margin, y: deckBlockBottom + gap, w: contentW, h: BANNER_H * h };

    // --- anchored to the bottom
    const card = handCardSize(input, contentW);
    const handW = card.w * input.handCount + HAND_GAP * w * (input.handCount - 1);
    const handY = h - margin - card.h;
    const hand = row(input.handCount, (w - handW) / 2, handW, HAND_GAP * w, handY, card.h);

    const ownStatusH = OWN_STATUS_H * h;
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
        cardScale: card.w / CARD_ART_WIDTH,
        pip
    };
}
