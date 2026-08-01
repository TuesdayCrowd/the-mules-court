import { describe, expect, it } from 'vitest';
import { bottom, contains, intersects, right } from './rect';
import {
    MAX_DISCARDS,
    MEDALLION_GAP,
    MIN_PIP_PX,
    computeLayout,
    medallionRunWidth,
    pipBlockHeight,
    pipFaceHeight,
    pipRowHeight
} from './tableLayout';
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

const VIEWPORTS = [
    { name: 'rotated phone', w: 844, h: 390, topology: 'landscape-narrow' },
    { name: 'tablet', w: 1024, h: 768, topology: 'wide' },
    { name: 'desktop', w: 1920, h: 1080, topology: 'wide' },
    // A 4:3 monitor: tall, but an aspect well short of the old 1.45 wide test.
    // It used to draw a rotated phone's table — see `the landscape split` in
    // topology.test.ts. Held to the same invariants as every other viewport.
    { name: 'desktop 4:3', w: 1633, h: 1221, topology: 'wide' },
    { name: 'phone', w: 390, h: 844, topology: 'portrait' }
] as const;

describe.each(VIEWPORTS)('$name ($w x $h)', viewport => {
    it(`classifies as ${viewport.topology}`, () => {
        expect(computeLayout({ ...viewport, opponentCount: 1, handCount: 1, showsRemovedCard: false, maxDiscards: 0 }).topology).toBe(
            viewport.topology
        );
    });

    // The full cross product: every seat count, every hand size, with the burn
    // panel wherever a two-player round would put it, at the worst-case pile.
    for (const opponentCount of [1, 2, 3] as const) {
        for (const handCount of [1, 2] as const) {
            const input: LayoutInput = {
                w: viewport.w,
                h: viewport.h,
                opponentCount,
                handCount,
                showsRemovedCard: opponentCount === 1,
                maxDiscards: MAX_DISCARDS
            };

            it(`keeps every element inside the viewport at ${opponentCount} opponents and ${handCount} cards`, () => {
                expectInsideViewport(computeLayout(input));
            });

            it(`never overlaps two elements at ${opponentCount} opponents and ${handCount} cards`, () => {
                expectNoOverlaps(computeLayout(input));
            });

            it(`leaves the hand a real card at ${opponentCount} opponents and ${handCount} cards`, () => {
                // Compression may shrink the hand, but never to nothing.
                expect(computeLayout(input).hand[0].h).toBeGreaterThan(0);
            });
        }
    }
});

describe('landscape-narrow composition', () => {
    const ROTATED = { w: 844, h: 390 } as const;

    function rotated(overrides: Partial<LayoutInput> = {}): LayoutSpec {
        return computeLayout({ ...ROTATED, opponentCount: 3, handCount: 2, showsRemovedCard: false, maxDiscards: 3, ...overrides });
    }

    it('spreads three opponents into a shallow arc', () => {
        const chips = rotated({ opponentCount: 3 }).opponents;
        const ys = chips.map(chip => chip.y);

        expect(new Set(ys).size).toBeGreaterThan(1); // not a flat row
        expect(ys[0]).toBeGreaterThan(ys[1]); // outer chips sit lower than the centre
        expect(ys[2]).toBeGreaterThan(ys[1]);
        expect(ys[0]).toBeCloseTo(ys[2], 5); // and symmetrically so
    });

    it('keeps two opponents level, because two points are not an arc', () => {
        const chips = rotated({ opponentCount: 2 }).opponents;
        expect(chips[0].y).toBe(chips[1].y);
    });

    it('keeps the deck clear of the lowest chip in the arc', () => {
        const spec = rotated({ opponentCount: 3 });
        for (const chip of spec.opponents) expect(spec.deck.y).toBeGreaterThanOrEqual(bottom(chip));
    });

    // Superseding UIX §6.1, which spread the hand to both margins here on the
    // reasoning that a phone in landscape has a thumb at each edge. It read as
    // broken on every viewport it reached and was removed outright.
    it('centres the hand as a block, like every other class', () => {
        const spec = rotated({ handCount: 2 });

        expect((spec.hand[0].x + right(last(spec.hand))) / 2).toBeCloseTo(ROTATED.w / 2, 5);
        expect(spec.hand[1].x - right(spec.hand[0])).toBeLessThan(spec.hand[0].w);
    });

    it('still centres a single card', () => {
        const spec = rotated({ handCount: 1 });
        expect(spec.hand[0].x + spec.hand[0].w / 2).toBeCloseTo(ROTATED.w / 2, 5);
    });

    it('stays this class however wide the viewport, as long as it is short', () => {
        // The tightened bands are for a phone on its side. Aspect does not
        // decide that — a rotated phone is 2.16, deep in wide territory.
        expect(computeLayout({ w: 2400, h: 400, opponentCount: 3, handCount: 2, showsRemovedCard: false, maxDiscards: 3 }).topology).toBe(
            'landscape-narrow'
        );
    });

    // The bands belong to the whole class, but the hand spread does not: it is
    // a thumb-reach affordance, and a short desktop window has no thumbs at its
    // edges. At 1400×559 the spread put one card under the quick-reference
    // button with 1100px of nothing between the two.
    describe('on a short window too wide to hold', () => {
        const SHORT_WINDOW = { w: 1400, h: 559 } as const;

        function shortWindow(overrides: Partial<LayoutInput> = {}): LayoutSpec {
            return computeLayout({ ...SHORT_WINDOW, opponentCount: 1, handCount: 2, showsRemovedCard: true, maxDiscards: 3, ...overrides });
        }

        it('is still landscape-narrow, because the bands still want a short screen', () => {
            expect(shortWindow().topology).toBe('landscape-narrow');
        });

        it('centres the hand as a block rather than spreading it', () => {
            const spec = shortWindow();
            expect((spec.hand[0].x + right(last(spec.hand))) / 2).toBeCloseTo(SHORT_WINDOW.w / 2, 5);
            expect(spec.hand[1].x - right(spec.hand[0])).toBeLessThan(spec.hand[0].w);
        });

        it('crosses the height boundary without the hand jumping', () => {
            // Two pixels of height may change the composition. They may not
            // teleport the cards from the centre to opposite corners.
            const below = computeLayout({ w: 1400, h: 559, opponentCount: 1, handCount: 2, showsRemovedCard: true, maxDiscards: 3 });
            const above = computeLayout({ w: 1400, h: 561, opponentCount: 1, handCount: 2, showsRemovedCard: true, maxDiscards: 3 });

            const gapOf = (spec: LayoutSpec): number => spec.hand[1].x - right(spec.hand[0]);
            expect(Math.abs(gapOf(below) - gapOf(above))).toBeLessThan(below.hand[0].w);
        });
    });

    it('stacks the removed card below the deck, as portrait does', () => {
        const spec = rotated({ opponentCount: 1, showsRemovedCard: true });
        expect(spec.removedCard!.y).toBeGreaterThanOrEqual(bottom(spec.deck));
    });

    it('is fully fluid within the class', () => {
        const small = computeLayout({ w: 760, h: 360, opponentCount: 3, handCount: 2, showsRemovedCard: false, maxDiscards: 3 });
        const large = computeLayout({ w: 1024, h: 500, opponentCount: 3, handCount: 2, showsRemovedCard: false, maxDiscards: 3 });

        expect(large.deck.w).toBeGreaterThan(small.deck.w);
        expect(large.opponents[0].w).toBeGreaterThan(small.opponents[0].w);
        expect(large.cardScale).toBeGreaterThan(small.cardScale);
    });
});

describe('wide composition', () => {
    const DESKTOP = { w: 1920, h: 1080 } as const;

    function wide(overrides: Partial<LayoutInput> = {}): LayoutSpec {
        return computeLayout({ ...DESKTOP, opponentCount: 3, handCount: 2, showsRemovedCard: false, maxDiscards: 3, ...overrides });
    }

    it('sets the removed card beside the deck, not below it', () => {
        const spec = wide({ opponentCount: 1, showsRemovedCard: true });
        expect(spec.removedCard).not.toBeNull();
        expect(spec.removedCard!.x).toBeGreaterThanOrEqual(right(spec.deck));
        expect(spec.removedCard!.y).toBe(spec.deck.y); // level with it, sharing the band
    });

    it('keeps the deck and removed card centred as a pair', () => {
        const spec = wide({ opponentCount: 1, showsRemovedCard: true });
        const pairCentre = (spec.deck.x + right(spec.removedCard!)) / 2;
        expect(pairCentre).toBeCloseTo(DESKTOP.w / 2, 5);
    });

    it('draws larger cards than portrait at the same seat count', () => {
        const portraitSpec = computeLayout({ w: 390, h: 844, opponentCount: 3, handCount: 2, showsRemovedCard: false, maxDiscards: 3 });
        expect(wide({ opponentCount: 3, handCount: 2 }).cardScale).toBeGreaterThan(portraitSpec.cardScale);
    });

    it('gives seats more generous panels than portrait does', () => {
        const portraitSpec = computeLayout({ w: 390, h: 844, opponentCount: 3, handCount: 2, showsRemovedCard: false, maxDiscards: 3 });
        const spec = wide({ opponentCount: 3, handCount: 2 });
        expect(spec.opponents[0].h / DESKTOP.h).toBeGreaterThan(portraitSpec.opponents[0].h / 844);
    });

    // A 4:3 monitor is a desktop by every measure §6.1 names, but its aspect
    // (1.34) sat below the old 1.45 wide test, so it drew a rotated phone's
    // table: tight bands, a small deck, the burn panel stacked under it, and a
    // hand flung to both margins with 1068px between the two cards.
    describe('on a 4:3 window, which the aspect rule used to call a phone', () => {
        const MONITOR = { w: 1633, h: 1221 } as const;

        function monitor(overrides: Partial<LayoutInput> = {}): LayoutSpec {
            return computeLayout({ ...MONITOR, opponentCount: 1, handCount: 2, showsRemovedCard: true, maxDiscards: 3, ...overrides });
        }

        it('centres the hand as a block', () => {
            const spec = monitor();
            expect((spec.hand[0].x + right(last(spec.hand))) / 2).toBeCloseTo(MONITOR.w / 2, 5);
        });

        it('keeps the two cards adjacent rather than pinned to the margins', () => {
            const spec = monitor();
            expect(spec.hand[1].x - right(spec.hand[0])).toBeLessThan(spec.hand[0].w);
        });

        it('sets the removed card beside the deck rather than stacking it', () => {
            const spec = monitor();
            expect(spec.removedCard!.x).toBeGreaterThanOrEqual(right(spec.deck));
            expect(spec.removedCard!.y).toBe(spec.deck.y);
        });

        it('draws a bigger deck and roomier seats than the phone composition did', () => {
            const phoneish = computeLayout({ w: 844, h: 390, opponentCount: 1, handCount: 2, showsRemovedCard: true, maxDiscards: 3 });
            const spec = monitor();

            expect(spec.deck.h / MONITOR.h).toBeGreaterThan(phoneish.deck.h / 390);

            /**
             * Seats compared in pixels, not as a share of height.
             *
             * The share stopped being the right measure once the chip carried a
             * budget: a rotated phone is 390px tall and its chip has the same
             * five bands to hold as a monitor's, so landscape-narrow now claims
             * a LARGER fraction of a much smaller screen. "Roomier" is what a
             * player sees, and that is absolute.
             */
            expect(spec.opponents[0].h).toBeGreaterThan(phoneish.opponents[0].h);
        });
    });

    it('keeps opponents level — the arc belongs to landscape-narrow', () => {
        const ys = wide({ opponentCount: 3 }).opponents.map(chip => chip.y);
        expect(new Set(ys).size).toBe(1);
    });

    it('is fully fluid within the class', () => {
        const small = computeLayout({ w: 1440, h: 900, opponentCount: 3, handCount: 2, showsRemovedCard: false, maxDiscards: 3 });
        const large = computeLayout({ w: 2560, h: 1440, opponentCount: 3, handCount: 2, showsRemovedCard: false, maxDiscards: 3 });

        expect(large.deck.w).toBeGreaterThan(small.deck.w);
        expect(large.hand[0].h).toBeGreaterThan(small.hand[0].h);
        expect(large.cardScale).toBeGreaterThan(small.cardScale);
    });
});

/**
 * The reported bug: "devotion tokens for other seats are hidden under their
 * name as text grows with screen size."
 *
 * The nickname was sized from the chip — `max(14, chipH * 0.13)`, no ceiling —
 * while the token row sat at a literal `y + 26`, and the name's scrim was drawn
 * over the medallions. One number scaled with the viewport and its neighbour did
 * not, so the two met on any display bigger than a phone.
 *
 * The chip's contents are budgeted here now, the way the pip block already was,
 * and swept rather than spot-checked — the bug was invisible at the size it was
 * first written at.
 */
describe('the seat chip content budget', () => {
    const SEAT_COUNTS = [1, 2, 3] as const;

    function sweep(run: (spec: LayoutSpec, label: string) => void): void {
        for (const viewport of VIEWPORTS) {
            for (const opponentCount of SEAT_COUNTS) {
                for (const maxDiscards of [0, 1, 4, MAX_DISCARDS]) {
                    const spec = computeLayout({
                        w: viewport.w,
                        h: viewport.h,
                        opponentCount,
                        handCount: 2,
                        showsRemovedCard: false,
                        maxDiscards
                    });
                    run(spec, `${viewport.name} · ${opponentCount} seats · ${maxDiscards} discards`);
                }
            }
        }
    }

    it('starts the token row below the whole name band', () => {
        sweep((spec, label) => {
            expect(spec.chip.tokenTop, label).toBeGreaterThanOrEqual(spec.chip.nameBandH);
        });
    });

    it('finishes the token row before the peek marker begins', () => {
        sweep((spec, label) => {
            expect(spec.chip.tokenTop + spec.chip.medallion, label).toBeLessThanOrEqual(spec.chip.markerTop);
        });
    });

    it('finishes the peek marker before the state caption begins', () => {
        sweep((spec, label) => {
            expect(spec.chip.markerTop + spec.chip.smallH, label).toBeLessThanOrEqual(spec.chip.captionTop);
        });
    });

    /**
     * The second reported collision. "Protected — cannot be targeted" was drawn
     * at a literal `seat.rect.h - 16` while the pip block was budgeted against
     * the bottom edge, so the caption landed inside the discard values at every
     * viewport — and unlike the nickname and the pips it carried no scrim, so it
     * was bare text over both the nebula and the numerals underneath.
     */
    it('finishes the state caption before the pips begin', () => {
        sweep((spec, label) => {
            expect(spec.chip.captionTop + spec.chip.smallH, label).toBeLessThanOrEqual(spec.chip.pipTop);
        });
    });

    it('keeps every band inside the chip', () => {
        sweep((spec, label) => {
            expect(spec.chip.captionTop + spec.chip.smallH, label).toBeLessThanOrEqual(spec.opponents[0].h);
        });
    });

    it('keeps the pip block inside the chip it was fitted to', () => {
        sweep((spec, label) => {
            expect(spec.chip.pipTop + pipBlockHeight(spec.pip), label).toBeLessThanOrEqual(spec.opponents[0].h);
        });
    });

    it('grows the nickname with the chip rather than pinning it to a phone', () => {
        const phone = computeLayout({
            w: 390,
            h: 844,
            opponentCount: 3,
            handCount: 1,
            showsRemovedCard: false,
            maxDiscards: 3
        });
        const desktop = computeLayout({
            w: 1920,
            h: 1080,
            opponentCount: 3,
            handCount: 1,
            showsRemovedCard: false,
            maxDiscards: 3
        });

        expect(desktop.chip.nameH).toBeGreaterThan(phone.chip.nameH);
    });

    it('grows the medallion too, so tokens do not shrink into a large chip', () => {
        // The same complaint the pips had before they were fitted: one size for
        // a 390px phone and a 1080p monitor is right for exactly one of them.
        const phone = computeLayout({
            w: 390,
            h: 844,
            opponentCount: 3,
            handCount: 1,
            showsRemovedCard: false,
            maxDiscards: 3
        });
        const desktop = computeLayout({
            w: 1920,
            h: 1080,
            opponentCount: 3,
            handCount: 1,
            showsRemovedCard: false,
            maxDiscards: 3
        });

        expect(desktop.chip.medallion).toBeGreaterThan(phone.chip.medallion);
    });

    it('keeps a legible floor under every band at the smallest supported screen', () => {
        sweep((spec, label) => {
            expect(spec.chip.nameH, label).toBeGreaterThanOrEqual(12);
            expect(spec.chip.medallion, label).toBeGreaterThanOrEqual(8);
            expect(spec.chip.smallPx, label).toBeGreaterThanOrEqual(10);
        });
    });

    it('grows the marker and caption with the chip, like every other band', () => {
        // Both were pinned at 11px. A seat panel on a 1080p monitor is nearly
        // twice the height of one on a phone, and the same text in both is
        // right for exactly one of them.
        const at = (w: number, h: number) =>
            computeLayout({ w, h, opponentCount: 3, handCount: 1, showsRemovedCard: false, maxDiscards: 3 }).chip;

        expect(at(1920, 1080).smallPx).toBeGreaterThan(at(390, 844).smallPx);
    });

    it('still keeps every rect inside the viewport once the chip carries a budget', () => {
        sweep(spec => {
            expectInsideViewport(spec);
            expectNoOverlaps(spec);
        });
    });
});

/**
 * The own row draws each discard as its card face plus its value, so unlike a
 * seat chip's pips it cannot wrap — it is one line. Interface rule 7 still
 * holds: the deepest pile the engine can produce has to fit, not be truncated.
 */
describe('the own-status row', () => {
    function ownRowAt(w: number, h: number, maxDiscards: number): LayoutSpec {
        return computeLayout({ w, h, opponentCount: 3, handCount: 2, showsRemovedCard: true, maxDiscards });
    }

    it('fits every discard the engine can deal, at every viewport', () => {
        for (const viewport of VIEWPORTS) {
            const spec = ownRowAt(viewport.w, viewport.h, MAX_DISCARDS);
            const { ownRow, ownStatus } = spec;

            const run = ownRow.medallionSpan + MAX_DISCARDS * ownRow.step;
            expect(run, `${viewport.name}: ${MAX_DISCARDS} faces overflow the row`).toBeLessThanOrEqual(ownStatus.w);
        }
    });

    it('keeps a face and its value inside the row’s height', () => {
        for (const viewport of VIEWPORTS) {
            const spec = ownRowAt(viewport.w, viewport.h, MAX_DISCARDS);
            expect(spec.ownRow.iconH, viewport.name).toBeLessThanOrEqual(spec.ownStatus.h);
        }
    });

    it('keeps a face recognisable rather than shrinking it to a sliver', () => {
        for (const viewport of VIEWPORTS) {
            const spec = ownRowAt(viewport.w, viewport.h, MAX_DISCARDS);
            expect(spec.ownRow.iconH, viewport.name).toBeGreaterThanOrEqual(18);
            expect(spec.ownRow.valuePx, viewport.name).toBeGreaterThanOrEqual(10);
        }
    });

    it('keeps the card aspect, so a face is a card and not a square', () => {
        const spec = ownRowAt(1920, 1080, 4);
        expect(spec.ownRow.iconW / spec.ownRow.iconH).toBeCloseTo(0.75, 5);
    });

    it('reserves medallion width from the medallion size, not a fixed 60px', () => {
        // The old literal was right for a 12px medallion and wrong the moment
        // the medallion started scaling with the table.
        const phone = ownRowAt(390, 844, 4);
        const desktop = ownRowAt(1920, 1080, 4);

        expect(desktop.ownRow.medallionSpan).toBeGreaterThan(phone.ownRow.medallionSpan);
        expect(phone.ownRow.medallionSpan).toBeGreaterThanOrEqual(phone.chip.medallion * 4);
    });

    /**
     * One definition of the medallion run, read by both places that draw one.
     *
     * The seat chip's token tap target used to guess at it with a literal
     * `medallion * 5` while the viewer's own row read `medallionSpan` — two
     * formulas for one measurement, and neither of them the run actually
     * drawn (46px against a 50px target at `medallion = 10`).
     */
    it('publishes the medallion run width the renderer draws, and builds the span from it', () => {
        const spec = ownRowAt(390, 844, 4);
        const size = spec.chip.medallion;

        // Four medallions stepping by `size + MEDALLION_GAP`: the last one's
        // right edge, measured from the first one's left edge.
        expect(medallionRunWidth(size)).toBe(3 * (size + MEDALLION_GAP) + size);
        expect(spec.ownRow.medallionSpan).toBeGreaterThan(medallionRunWidth(size));
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

    /**
     * A pip is a card face with its value under it, mirroring the own row.
     *
     * The chips used to draw the pile as bare numerals while the viewer's own
     * row drew portraits — not because a chip was entitled to less (a discard is
     * public information) but because `SeatPlan` mapped the card's identity away
     * before the renderer ever saw it. Faces are wider and taller than numerals,
     * so the block's budget has to account for both parts of a pip, and the
     * value — the deduction datum — has to survive whatever the face gives up.
     */
    describe('a pip is a face plus its value', () => {
        it('budgets a row as a face AND the value beneath it', () => {
            const spec = portrait({ maxDiscards: MAX_DISCARDS });
            expect(pipRowHeight(spec.pip)).toBe(pipFaceHeight(spec.pip) + spec.pip.valuePx);
            expect(pipBlockHeight(spec.pip)).toBeGreaterThanOrEqual(spec.pip.rows * pipRowHeight(spec.pip));
        });

        it('keeps the face card-shaped rather than square, at every viewport', () => {
            for (const viewport of VIEWPORTS) {
                const spec = computeLayout({
                    w: viewport.w,
                    h: viewport.h,
                    opponentCount: 3,
                    handCount: 2,
                    showsRemovedCard: false,
                    maxDiscards: MAX_DISCARDS
                });
                expect(spec.pip.size / pipFaceHeight(spec.pip), viewport.name).toBeCloseTo(0.75, 1);
            }
        });

        it('never shrinks the value below the legible floor, however deep the pile', () => {
            // The face may shrink to its own floor and does, on a small phone
            // with a full pile. The value may not: it is what the pile is read
            // for, and the face is the aid beside it.
            for (let pile = 0; pile <= 20; pile++) {
                expect(portrait({ maxDiscards: pile }).pip.valuePx, `pile of ${pile}`).toBeGreaterThanOrEqual(10);
            }
        });

        it('grows the value with the chip, so a desktop is not read at phone size', () => {
            const phone = portrait({ maxDiscards: MAX_DISCARDS });
            const desktop = computeLayout({
                w: 1920,
                h: 1080,
                opponentCount: 3,
                handCount: 2,
                showsRemovedCard: false,
                maxDiscards: MAX_DISCARDS
            });
            expect(desktop.pip.valuePx).toBeGreaterThan(phone.pip.valuePx);
        });

        it('still gives the deepest pile a slot per discard at every viewport and seat count', () => {
            for (const viewport of VIEWPORTS) {
                for (const opponentCount of [1, 2, 3] as const) {
                    const spec = computeLayout({
                        w: viewport.w,
                        h: viewport.h,
                        opponentCount,
                        handCount: 2,
                        showsRemovedCard: opponentCount === 1,
                        maxDiscards: MAX_DISCARDS
                    });
                    const label = `${viewport.name} · ${opponentCount} seats`;
                    expect(spec.pip.perRow * spec.pip.rows, label).toBeGreaterThanOrEqual(MAX_DISCARDS);
                    expect(spec.chip.pipTop + pipBlockHeight(spec.pip), label).toBeLessThanOrEqual(spec.opponents[0].h);
                }
            }
        });
    });

    it('survives a small phone with a full pile without breaking the table', () => {
        const spec = computeLayout({ w: 320, h: 568, opponentCount: 3, handCount: 2, showsRemovedCard: false, maxDiscards: MAX_DISCARDS });
        expectInsideViewport(spec);
        expectNoOverlaps(spec);
    });
});
