import { describe, expect, it } from 'vitest';
import { MIN_WIDE_HEIGHT, classifyTopology } from './topology';

describe('classifyTopology', () => {
    it.each([
        [390, 844, 'portrait'], // iPhone 14 portrait, aspect 0.46
        [768, 1024, 'portrait'], // iPad portrait, aspect 0.75
        [844, 390, 'landscape-narrow'], // rotated phone, aspect 2.16 — see the height guard below
        [1024, 768, 'landscape-narrow'], // aspect 1.33
        [1920, 1080, 'wide'] // aspect 1.78
    ] as const)('classifies %ix%i as %s', (w, h, expected) => {
        expect(classifyTopology(w, h)).toBe(expected);
    });
});

describe('the aspect boundaries', () => {
    // Probed at h = 1000 so the viewport clears MIN_WIDE_HEIGHT and aspect is the
    // only variable. The plan's own snippet probed at h = 100, where the height
    // guard decides every case and the boundary under test never runs.
    const TALL = 1000;

    it('places the portrait boundary exactly at 0.9', () => {
        expect(classifyTopology(899, TALL)).toBe('portrait');
        expect(classifyTopology(900, TALL)).toBe('landscape-narrow'); // inclusive lower edge
    });

    it('places the wide boundary exactly at 1.45', () => {
        expect(classifyTopology(1450, TALL)).toBe('landscape-narrow'); // exactly 1.45 is not yet wide
        expect(classifyTopology(1451, TALL)).toBe('wide');
    });
});

describe('the minimum height for wide', () => {
    // UIX §6.1 calls a rotated phone landscape-narrow, but its aspect (2.16) is
    // deep into wide territory. Height is the second dimension that separates a
    // desktop window from a phone on its side.
    it('refuses wide to a viewport too short for its generous seat panels', () => {
        expect(classifyTopology(1600, MIN_WIDE_HEIGHT - 1)).toBe('landscape-narrow');
        expect(classifyTopology(1600, MIN_WIDE_HEIGHT)).toBe('wide'); // inclusive
    });

    it('keeps a very wide but short viewport out of wide', () => {
        expect(classifyTopology(2400, 400)).toBe('landscape-narrow'); // aspect 6.0
    });

    it('does not let the height guard promote a portrait viewport', () => {
        // Short AND tall-shaped stays portrait: the guard only ever demotes.
        expect(classifyTopology(300, 400)).toBe('portrait');
    });
});
