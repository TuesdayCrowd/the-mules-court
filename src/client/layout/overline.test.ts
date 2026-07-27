import { describe, expect, it } from 'vitest';
import { MIN_OVERLINE_PX, fitOverline } from './overline';

describe('fitOverline', () => {
    it('leaves a caption that already fits alone', () => {
        expect(fitOverline(80, 60, 10)).toBe(1);
    });

    it('never enlarges a caption to fill the room', () => {
        expect(fitOverline(200, 60, 10)).toBe(1);
    });

    it('scales a caption down to the room it has', () => {
        expect(fitOverline(60, 80, 10)).toBeCloseTo(0.75, 5);
    });

    it('keeps a caption that stays legible after scaling', () => {
        // 10px * 0.8 = 8px, above the floor.
        expect(fitOverline(64, 80, 10)).toBeCloseTo(0.8, 5);
    });

    it('drops a caption that would have to shrink below the legible floor', () => {
        // 10px * 0.5 = 5px.
        expect(fitOverline(40, 80, 10)).toBeNull();
    });

    it('places the boundary exactly at the legible floor', () => {
        const fontSize = 10;
        const textWidth = 100;
        const atFloor = (MIN_OVERLINE_PX / fontSize) * textWidth;

        expect(fitOverline(atFloor, textWidth, fontSize)).not.toBeNull();
        expect(fitOverline(atFloor - 1, textWidth, fontSize)).toBeNull();
    });

    it('drops a caption with no room at all', () => {
        expect(fitOverline(0, 80, 10)).toBeNull();
        expect(fitOverline(-5, 80, 10)).toBeNull();
    });

    it('treats an unmeasurable caption as fitting rather than dividing by zero', () => {
        expect(fitOverline(40, 0, 10)).toBe(1);
    });

    // The case that was reported: a two-player burn panel on a landscape phone.
    // The face-up card is 39px wide before the fan takes two 5px slivers out of
    // it, the band is MIN_NAME_H tall so the caption sets at 7px, and
    // "Removed from play" measures about 60px at that size.
    it('drops the caption on a landscape-phone burn panel', () => {
        expect(fitOverline(29 - 6, 60, 7)).toBeNull();
    });

    // The same panel on a desktop: 101px wide less two 14px slivers, a 21px
    // band, so the caption sets at 10px and measures about 82px.
    it('keeps the caption on a desktop burn panel', () => {
        const scale = fitOverline(73 - 6, 82, 10);

        expect(scale).not.toBeNull();
        expect(scale!).toBeLessThan(1); // it does still have to shrink
    });
});
