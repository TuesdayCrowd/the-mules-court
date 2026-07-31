import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOKENS, hex } from './tokens';

/** `--color-nebula-red: #ef4444;` → `['colorNebulaRed', 0xef4444]` */
function parseCssTokens(css: string): Map<string, number> {
    const found = new Map<string, number>();
    const re = /--([a-z0-9-]+)\s*:\s*#([0-9a-f]{6})\s*;/gi;
    for (const [, name, hex] of css.matchAll(re)) {
        const camel = name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
        found.set(camel, parseInt(hex, 16));
    }
    return found;
}

/**
 * UIX §2.3's palette, named explicitly.
 *
 * The two drift checks below each walk one side and look for the other, so they
 * prove the CSS and TypeScript key sets are identical — but a token deleted from
 * *both* files leaves them identical and passes. Naming the design's tokens is
 * what makes that deletion fail. `colorTextPrimary` joins them because the deck's
 * legibility check is written against it.
 */
const REQUIRED_TOKENS = [
    'colorBg',
    'colorNebulaRed',
    'colorNebulaPurple',
    'colorTextPrimary',
    'colorSeatCurrent',
    'colorSeatOther',
    'colorSeatProtected',
    'colorSeatEliminated',
    'colorSeatDisconnected',
    'colorStateYourTurn',
    'colorStateWaiting',
    'colorStateRoundOver',
    'colorStatePaused',
    'colorStateMatchOver',
    'colorDeckFull',
    'colorDeckLow',
    'colorDeckEmpty'
] as const;

describe('design tokens', () => {
    const css = parseCssTokens(readFileSync('src/client/styles/tokens.css', 'utf8'));

    it('declares every colour the design names', () => {
        expect(REQUIRED_TOKENS.filter(name => !css.has(name))).toEqual([]);
    });

    it('mirrors every CSS colour token in TypeScript with the same value', () => {
        for (const [name, value] of css) {
            expect(TOKENS, `missing TS token ${name}`).toHaveProperty(name);
            expect(TOKENS[name as keyof typeof TOKENS], `value drift on ${name}`).toBe(value);
        }
    });

    it('declares no TypeScript colour token absent from CSS', () => {
        for (const name of Object.keys(TOKENS)) {
            expect(css.has(name), `TS token ${name} has no CSS counterpart`).toBe(true);
        }
    });
});

describe('hex', () => {
    it('renders a palette integer as the six-digit form CSS accepts', () => {
        expect(hex(TOKENS.colorNebulaPurple)).toBe('#a855f7');
    });

    it('pads a colour whose leading bytes are zero', () => {
        // The bug this pins: `(0).toString(16)` is '0', and '#0' is not black —
        // it is a parse failure that some engines swallow as transparent.
        expect(hex(TOKENS.colorBg)).toBe('#000000');
        expect(hex(0x00ff00)).toBe('#00ff00');
    });

    it('agrees with the stylesheet for every colour both sides name', () => {
        // tokens.css is authoritative (UIX §2.3); this is the same claim the
        // drift test makes, asserted through the conversion the DOM side uses.
        expect(hex(TOKENS.colorSeatProtected)).toBe('#22d3ee');
        expect(hex(TOKENS.colorTextPrimary)).toBe('#f5f5f5');
    });
});
