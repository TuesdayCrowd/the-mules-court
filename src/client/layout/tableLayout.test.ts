import { describe, expect, it } from 'vitest';
import { bottom, contains, intersects, right } from './rect';
import { MAX_DISCARDS, MIN_PIP_PX, computeLayout, pipBlockHeight } from './tableLayout';
import type { LayoutInput, LayoutSpec, Rect } from './types';

// ------------------------------------------------------------------ helpers

/**
 * Last element, or a clear failure.
 *
 * Not `.at(-1)`: that is ES2022 and `tsconfig.json` sets `lib: ["ES2020", …]`,
 * so it fails `bunx tsc --noEmit` with TS2550. No file in `src/` reaches for an
 * ES2021+ array method, and widening `lib` alone would let tsc accept a runtime
 * method nothing in this pipeline polyfills.
 */
export function last<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('expected a non-empty array');
    return items[items.length - 1];
}

/** Every positioned rect in the spec, flattened. Skips nulls and the viewport itself. */
export function allRects(spec: LayoutSpec): Rect[] {
    return [
        spec.statusStrip,
        ...spec.opponents,
        spec.deck,
        ...(spec.removedCard === null ? [] : [spec.removedCard]),
        spec.banner,
        spec.toastZone,
        spec.ownStatus,
        ...spec.hand
    ];
}

/** Names in the same order as `allRects`, so a failure says which pair collided. */
export function rectNames(spec: LayoutSpec): string[] {
    return [
        'statusStrip',
        ...spec.opponents.map((_, i) => `opponent[${i}]`),
        'deck',
        ...(spec.removedCard === null ? [] : ['removedCard']),
        'banner',
        'toastZone',
        'ownStatus',
        ...spec.hand.map((_, i) => `hand[${i}]`)
    ];
}

export function expectNoOverlaps(spec: LayoutSpec): void {
    const rects = allRects(spec);
    const names = rectNames(spec);
    for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
            expect(intersects(rects[i], rects[j]), `${names[i]} overlaps ${names[j]}`).toBe(false);
        }
    }
}

export function expectInsideViewport(spec: LayoutSpec): void {
    const names = rectNames(spec);
    allRects(spec).forEach((rect, i) => {
        expect(contains(spec.viewport, rect), `${names[i]} escapes the viewport`).toBe(true);
    });
}

const PHONE = { w: 390, h: 844 } as const;

function portrait(overrides: Partial<LayoutInput> = {}): LayoutSpec {
    return computeLayout({
        ...PHONE,
        opponentCount: 3,
        handCount: 1,
        showsRemovedCard: false,
        maxDiscards: 3,
        ...overrides
    });
}

// -------------------------------------------------------------------- tests

describe('portrait layout', () => {
    it('classifies a phone as portrait and fills the viewport', () => {
        const spec = portrait();
        expect(spec.topology).toBe('portrait');
        expect(spec.viewport).toEqual({ x: 0, y: 0, w: 390, h: 844 });
    });

    it('fits three opponent chips across a 390px phone', () => {
        const spec = portrait({ opponentCount: 3 });

        expect(spec.opponents).toHaveLength(3);
        for (const chip of spec.opponents) expect(chip.w).toBeGreaterThanOrEqual(110);

        const rightmost = last(spec.opponents);
        const spanned = right(rightmost) - spec.opponents[0].x;
        expect(spanned).toBeLessThanOrEqual(PHONE.w);
    });

    it('gives one opponent the same chip height as three, so the table does not jump', () => {
        expect(portrait({ opponentCount: 1 }).opponents[0].h).toBe(portrait({ opponentCount: 3 }).opponents[0].h);
    });

    it('keeps every element inside the viewport at every seat count', () => {
        for (const opponentCount of [1, 2, 3] as const) {
            expectInsideViewport(
                portrait({ opponentCount, handCount: 2, showsRemovedCard: opponentCount === 1, maxDiscards: 7 })
            );
        }
    });

    it('never overlaps two elements', () => {
        expectNoOverlaps(portrait({ opponentCount: 3, handCount: 2, maxDiscards: 4 }));
    });

    it('never overlaps two elements in the crowded two-player composition', () => {
        expectNoOverlaps(portrait({ opponentCount: 1, handCount: 2, showsRemovedCard: true, maxDiscards: 7 }));
    });

    it('stacks the removed-card panel below the deck in a two-player round', () => {
        const spec = portrait({ opponentCount: 1, showsRemovedCard: true, maxDiscards: 2 });
        expect(spec.removedCard).not.toBeNull();
        expect(spec.removedCard!.y).toBeGreaterThanOrEqual(bottom(spec.deck));
    });

    it('omits the removed-card panel at three and four players', () => {
        expect(portrait({ opponentCount: 2 }).removedCard).toBeNull();
        expect(portrait({ opponentCount: 3 }).removedCard).toBeNull();
    });

    it('lays the bands out top to bottom in reading order', () => {
        const spec = portrait({ opponentCount: 3, handCount: 2 });
        const order = [spec.statusStrip, spec.opponents[0], spec.deck, spec.banner, spec.toastZone, spec.ownStatus, spec.hand[0]];
        for (let i = 1; i < order.length; i++) {
            expect(order[i].y, `band ${i} starts above band ${i - 1}`).toBeGreaterThanOrEqual(bottom(order[i - 1]));
        }
    });

    it('gives the hand one rect per card, side by side', () => {
        const spec = portrait({ handCount: 2 });
        expect(spec.hand).toHaveLength(2);
        expect(spec.hand[1].x).toBeGreaterThanOrEqual(right(spec.hand[0]));
        expect(spec.hand[0].h).toBe(spec.hand[1].h);
    });

    it('centres a single hand card', () => {
        const spec = portrait({ handCount: 1 });
        const card = spec.hand[0];
        expect(card.x + card.w / 2).toBeCloseTo(PHONE.w / 2, 5);
    });

    it('is fully fluid within the class — every rect scales with the viewport', () => {
        const small = computeLayout({ w: 360, h: 780, opponentCount: 3, handCount: 2, showsRemovedCard: false, maxDiscards: 3 });
        const large = computeLayout({ w: 430, h: 932, opponentCount: 3, handCount: 2, showsRemovedCard: false, maxDiscards: 3 });

        expect(large.deck.w).toBeGreaterThan(small.deck.w);
        expect(large.hand[0].h).toBeGreaterThan(small.hand[0].h);
        expect(large.opponents[0].w).toBeGreaterThan(small.opponents[0].w);
        expect(large.cardScale).toBeGreaterThan(small.cardScale);
    });

    it('keeps the deck a card-shaped rect', () => {
        const spec = portrait();
        expect(spec.deck.w / spec.deck.h).toBeCloseTo(0.75, 2);
    });
});

describe('discard pips', () => {
    it('keeps pips legible at the worst-case pile', () => {
        const spec = portrait({ maxDiscards: MAX_DISCARDS });
        expect(spec.pip.size).toBeGreaterThanOrEqual(MIN_PIP_PX);
    });

    it('gives every value in the worst-case pile a slot', () => {
        const spec = portrait({ maxDiscards: MAX_DISCARDS });
        expect(spec.pip.perRow * spec.pip.rows).toBeGreaterThanOrEqual(MAX_DISCARDS);
    });

    it('wastes no row — the pile is spread as flat as it fits', () => {
        const spec = portrait({ maxDiscards: MAX_DISCARDS });
        expect(spec.pip.rows).toBe(Math.ceil(MAX_DISCARDS / spec.pip.perRow));
    });

    it('shrinks pips before it shrinks anything else in the chip', () => {
        const roomy = portrait({ maxDiscards: 2 });
        const crowded = portrait({ maxDiscards: MAX_DISCARDS });

        expect(crowded.pip.size).toBeLessThan(roomy.pip.size);
        expect(crowded.opponents[0].w).toBe(roomy.opponents[0].w); // the chip itself does not give way
    });

    it('gives every value a slot at every pile depth up to the worst case', () => {
        for (let pile = 0; pile <= MAX_DISCARDS; pile++) {
            const spec = portrait({ maxDiscards: pile });
            expect(spec.pip.size, `pile of ${pile}`).toBeGreaterThanOrEqual(MIN_PIP_PX);
            expect(spec.pip.perRow * spec.pip.rows, `pile of ${pile}`).toBeGreaterThanOrEqual(pile);
        }
    });

    it('never shrinks a pip below the legible floor, whatever the pile', () => {
        // Beyond MAX_DISCARDS is unreachable, but the floor is a floor.
        expect(portrait({ maxDiscards: 20 }).pip.size).toBe(MIN_PIP_PX);
    });

    it('grows the chip rather than dropping a value when the floor will not fit', () => {
        // A 320x568 phone with a full pile: even floor-sized pips need two rows,
        // and two rows need more than the nominal chip affords.
        const tiny = { w: 320, h: 568 } as const;
        const roomy = computeLayout({ ...tiny, opponentCount: 3, handCount: 1, showsRemovedCard: false, maxDiscards: 1 });
        const full = computeLayout({ ...tiny, opponentCount: 3, handCount: 1, showsRemovedCard: false, maxDiscards: MAX_DISCARDS });

        expect(full.pip.perRow * full.pip.rows).toBeGreaterThanOrEqual(MAX_DISCARDS);
        expect(full.opponents[0].h).toBeGreaterThan(roomy.opponents[0].h);
        expect(full.opponents[0].w).toBe(roomy.opponents[0].w); // it grows down, not sideways
    });

    it('keeps the pip block inside the chip it was fitted to', () => {
        for (const maxDiscards of [1, 4, MAX_DISCARDS]) {
            const spec = portrait({ maxDiscards });
            expect(pipBlockHeight(spec.pip), `pile of ${maxDiscards}`).toBeLessThanOrEqual(spec.opponents[0].h);
        }
    });

    it('survives a small phone with a full pile without breaking the table', () => {
        const spec = computeLayout({ w: 320, h: 568, opponentCount: 3, handCount: 2, showsRemovedCard: false, maxDiscards: MAX_DISCARDS });
        expectInsideViewport(spec);
        expectNoOverlaps(spec);
    });
});
