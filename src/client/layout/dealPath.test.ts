import { describe, expect, it } from 'vitest';
import type { Rect } from './types';
import { dealPath } from './dealPath';

/** The deck, roughly where a 1024×768 table puts it. */
const DECK: Rect = { x: 480, y: 320, w: 64, h: 86 };

/**
 * Pulls the numbers back out of a path string.
 *
 * The tests assert on geometry, not on formatting: a change of separator or of
 * rounding should not have to be restated in fifteen expectations.
 */
function pointsOf(path: string): Array<{ x: number; y: number }> {
    const numbers = path.match(/-?\d+(?:\.\d+)?/g) ?? [];
    const points: Array<{ x: number; y: number }> = [];
    for (let i = 0; i + 1 < numbers.length; i += 2) {
        points.push({ x: Number(numbers[i]), y: Number(numbers[i + 1]) });
    }
    return points;
}

describe('dealPath endpoints', () => {
    it('starts at the centre of the deck, in the deck box own coordinates', () => {
        const path = dealPath(DECK, { x: 700, y: 600, w: 100, h: 140 });
        const [start] = pointsOf(path);

        // The wrapper element is placed at the deck rect, and `path()` resolves
        // against the element own box — so the deck centre is (w/2, h/2), never
        // the deck absolute position.
        expect(start).toEqual({ x: DECK.w / 2, y: DECK.h / 2 });
    });

    it('ends at the centre of the destination, offset from the deck origin', () => {
        const to: Rect = { x: 700, y: 600, w: 100, h: 140 };
        const points = pointsOf(dealPath(DECK, to));
        const end = points[points.length - 1];

        expect(end).toEqual({ x: to.x + to.w / 2 - DECK.x, y: to.y + to.h / 2 - DECK.y });
    });

    it('moves the destination with the deck, so a resized table is still consistent', () => {
        const to: Rect = { x: 700, y: 600, w: 100, h: 140 };
        const shifted = dealPath({ ...DECK, x: DECK.x + 50 }, to);
        const points = pointsOf(shifted);

        expect(points[points.length - 1].x).toBe(to.x + to.w / 2 - (DECK.x + 50));
    });
});

describe('dealPath is an arc, not a slide', () => {
    it('emits a quadratic curve with a control point', () => {
        const path = dealPath(DECK, { x: 900, y: 320, w: 100, h: 140 });

        expect(path).toMatch(/^M /);
        expect(path).toContain('Q');
        expect(pointsOf(path)).toHaveLength(3);
    });

    it('puts the control point off the straight line between the two centres', () => {
        // A control point on the chord IS a slide, however it is spelled.
        const to: Rect = { x: 900, y: 320, w: 100, h: 140 };
        const [start, control, end] = pointsOf(dealPath(DECK, to));

        const cross = (end.x - start.x) * (control.y - start.y) - (end.y - start.y) * (control.x - start.x);
        expect(Math.abs(cross)).toBeGreaterThan(0);
    });

    it('bows upward, so a dealt card lifts off the deck rather than dipping under the table', () => {
        const [start, control, end] = pointsOf(dealPath(DECK, { x: 900, y: 320, w: 64, h: 86 }));
        const midY = (start.y + end.y) / 2;

        expect(control.y).toBeLessThan(midY);
    });

    it('bows the same way dealing left as dealing right', () => {
        const rightward = pointsOf(dealPath(DECK, { x: 900, y: 320, w: 64, h: 86 }));
        const leftward = pointsOf(dealPath(DECK, { x: 60, y: 320, w: 64, h: 86 }));

        // Mirrored, not rotated: both control points sit above their chord.
        expect(rightward[1].y).toBeLessThan((rightward[0].y + rightward[2].y) / 2);
        expect(leftward[1].y).toBeLessThan((leftward[0].y + leftward[2].y) / 2);
    });

    it('bows proportionally, so the gesture reads the same on a phone and a desktop', () => {
        const near = pointsOf(dealPath(DECK, { x: DECK.x + 100, y: DECK.y, w: 64, h: 86 }));
        const far = pointsOf(dealPath(DECK, { x: DECK.x + 400, y: DECK.y, w: 64, h: 86 }));

        const rise = (points: Array<{ x: number; y: number }>) => (points[0].y + points[2].y) / 2 - points[1].y;
        expect(rise(far)).toBeGreaterThan(rise(near));
    });
});

describe('dealPath degenerate cases', () => {
    it('never emits NaN when the destination sits exactly on the deck', () => {
        const path = dealPath(DECK, { x: DECK.x, y: DECK.y, w: DECK.w, h: DECK.h });

        expect(path).not.toContain('NaN');
        expect(pointsOf(path).every(p => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    });

    it('never emits NaN for a zero-sized deck rect', () => {
        expect(dealPath({ x: 0, y: 0, w: 0, h: 0 }, { x: 10, y: 10, w: 0, h: 0 })).not.toContain('NaN');
    });

    it('stays finite across a spread of real-looking table geometry', () => {
        for (let x = 0; x <= 1024; x += 97) {
            for (let y = 0; y <= 768; y += 79) {
                const path = dealPath(DECK, { x, y, w: 92, h: 128 });
                expect(path, `${x},${y}`).not.toContain('NaN');
                expect(path, `${x},${y}`).not.toContain('Infinity');
            }
        }
    });

    it('is deterministic and rounded, so the same geometry produces the same string', () => {
        const to: Rect = { x: 701.239_1, y: 600.777, w: 100, h: 140 };
        expect(dealPath(DECK, to)).toBe(dealPath(DECK, to));
        expect(dealPath(DECK, to)).not.toMatch(/\d\.\d{3}/);
    });
});
