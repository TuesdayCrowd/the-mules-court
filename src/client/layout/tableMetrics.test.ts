import { describe, expect, it } from 'vitest';
import { MAX_PANEL_INSET_FRACTION, panelSafeTop } from './tableMetrics';

/**
 * The rule shared by the action sheet and the reference dock: a right-edge
 * panel starts below the seat band so opening it never hides an opponent's
 * discards. One function so the two surfaces cannot drift apart.
 */
describe('panelSafeTop', () => {
    it('starts the panel exactly at the floor of the seat band', () => {
        expect(panelSafeTop(276, 950)).toBe(276);
    });

    it('never insets past its share of the viewport', () => {
        expect(panelSafeTop(900, 950)).toBe(950 * MAX_PANEL_INSET_FRACTION);
    });

    it('never returns a negative inset', () => {
        expect(panelSafeTop(-40, 950)).toBe(0);
    });

    it('leaves realistic desktop seat bands untouched by the clamp', () => {
        // A wide viewport puts the band around 29% down, comfortably clear.
        for (const [bottom, height] of [
            [386, 1330],
            [285, 982],
            [261, 900]
        ] as const) {
            expect(panelSafeTop(bottom, height)).toBe(bottom);
            expect(panelSafeTop(bottom, height)).toBeLessThan(height * MAX_PANEL_INSET_FRACTION);
        }
    });

    it('keeps the clamp generous enough to be a guard rather than a negotiation', () => {
        expect(MAX_PANEL_INSET_FRACTION).toBeGreaterThanOrEqual(0.5);
        expect(MAX_PANEL_INSET_FRACTION).toBeLessThan(1);
    });
});
