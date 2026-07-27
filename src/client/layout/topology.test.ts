import { describe, expect, it } from 'vitest';
import { MIN_WIDE_HEIGHT, classifyTopology } from './topology';

describe('classifyTopology', () => {
    it.each([
        [390, 844, 'portrait'], // iPhone 14 portrait, aspect 0.46
        [768, 1024, 'portrait'], // iPad portrait, aspect 0.75
        [844, 390, 'landscape-narrow'], // rotated phone, aspect 2.16 — height decides, not aspect
        [1024, 768, 'wide'], // iPad landscape, aspect 1.33 — §6.1's "large tablet"
        [1633, 1221, 'wide'], // 4:3 desktop window, aspect 1.34
        [1920, 1080, 'wide'] // aspect 1.78
    ] as const)('classifies %ix%i as %s', (w, h, expected) => {
        expect(classifyTopology(w, h)).toBe(expected);
    });
});

describe('the portrait boundary', () => {
    // Probed at h = 1000 so the viewport clears MIN_WIDE_HEIGHT and aspect is the
    // only variable. The plan's own snippet probed at h = 100, where the height
    // split decides every case and the boundary under test never runs.
    const TALL = 1000;

    it('places the portrait boundary exactly at 0.9', () => {
        expect(classifyTopology(899, TALL)).toBe('portrait');
        expect(classifyTopology(900, TALL)).toBe('wide'); // inclusive lower edge, and tall enough to breathe
    });
});

describe('the landscape split', () => {
    // UIX §6.1 names the classes by device rather than by number:
    // `landscape-narrow` is "rotated phone, small tablet", `wide` is "desktop,
    // large tablet". Height is what tells those apart. Aspect does not — it
    // misroutes a rotated phone (2.16) into `wide` and a 4:3 monitor (1.34)
    // into `landscape-narrow`, the two devices furthest apart in this design.
    it('refuses wide to a viewport too short for its generous seat panels', () => {
        expect(classifyTopology(1600, MIN_WIDE_HEIGHT - 1)).toBe('landscape-narrow');
        expect(classifyTopology(1600, MIN_WIDE_HEIGHT)).toBe('wide'); // inclusive
    });

    it('keeps a very wide but short viewport out of wide', () => {
        expect(classifyTopology(2400, 400)).toBe('landscape-narrow'); // aspect 6.0
    });

    it('gives a tall window wide however modest its aspect', () => {
        // Desktops and monitors, not phones on their side. Under the aspect
        // rule every one of these drew a rotated phone's table.
        expect(classifyTopology(1633, 1221)).toBe('wide'); // 4:3, aspect 1.34
        expect(classifyTopology(1280, 1024)).toBe('wide'); // 5:4, aspect 1.25
        expect(classifyTopology(1024, 768)).toBe('wide'); // 4:3, aspect 1.33
    });

    it('does not let the height split promote a portrait viewport', () => {
        // Short AND tall-shaped stays portrait: aspect is still checked first.
        expect(classifyTopology(300, 400)).toBe('portrait');
    });
});
