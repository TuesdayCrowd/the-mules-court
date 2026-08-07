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
    'colorTextSecondary',
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

/**
 * Every custom property a stylesheet reads must be one a stylesheet defines.
 *
 * This is not tidiness. An undefined `var()` makes the whole declaration
 * *invalid at computed-value time*, and the consequence is one most people
 * guess wrong: the declaration becomes `unset`. It does **not** fall back to an
 * earlier rule for the same property. `unset` then splits by inheritance —
 * `initial` for a non-inherited property, `inherit` for an inherited one — and
 * that split is exactly why these two failures looked so different.
 *
 * `padding` is not inherited, so `padding: var(--space-3) var(--space-5)` with
 * no `--space-5` anywhere is not "the base padding"; it is `0`, on all four
 * sides, silently. `color` *is* inherited, so a missing `--color-text-secondary`
 * quietly served the parent's colour and looked entirely fine while the palette
 * had no such token at all.
 *
 * That shipped. The personal toast — the one surface in the game whose whole
 * job is to be noticed — wore no padding at all on every viewport, its text
 * against its own border, and nothing said so: jsdom applies the same cascade
 * and would have measured the same zero without minding it, and the visual
 * harness had never photographed a toast.
 *
 * A fallback does not make a missing token harmless, so it does not earn an
 * exemption either. Three hid that way — `--color-text-secondary`,
 * `--font-size-sm` and `--color-border-subtle` were each read with a fallback
 * and defined nowhere, so each rendered as its fallback while the palette had no
 * idea it owed a value. `--font-size-sm` was read twice with two *different*
 * fallbacks, which is one name quietly meaning two sizes.
 *
 * The only real exemption is a property a surface sets from script at runtime.
 * Those are named below with the line that sets them, so the list cannot grow
 * by shrug.
 */
describe('custom properties', () => {
    const SHEETS = ['tokens.css', 'ui.css', 'table.css', 'fonts.css'] as const;

    /** Comments are stripped first: a doc block naming `var(--color-*)` is prose, not a reference. */
    function withoutComments(css: string): string {
        return css.replace(/\/\*[\s\S]*?\*\//g, '');
    }

    const sources = SHEETS.map(name => ({
        name,
        css: withoutComments(readFileSync(`src/client/styles/${name}`, 'utf8'))
    }));

    const defined = new Set(sources.flatMap(({ css }) => [...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map(m => m[1])));

    /** Written by a surface at runtime, so a stylesheet cannot define them. */
    const SET_FROM_SCRIPT: Readonly<Record<string, string>> = {
        '--dock-safe-top': 'ui/referenceDock.ts — clearance measured off the live table layout',
        '--pulse-floor': 'ui/table.ts — the deck pulse depth, which depends on deckCount'
    };

    it('defines every property any stylesheet reads', () => {
        for (const { name, css } of sources) {
            for (const [, property] of css.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
                if (property in SET_FROM_SCRIPT) continue;
                expect(defined.has(property), `${name} reads ${property}, which nothing defines`).toBe(true);
            }
        }
    });

    it('keeps the script-set exemptions honest', () => {
        // An exemption that no stylesheet reads any more is a stale licence, and
        // the next person to add one will copy the list rather than the argument.
        const read = new Set(sources.flatMap(({ css }) => [...css.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map(m => m[1])));
        for (const property of Object.keys(SET_FROM_SCRIPT)) {
            expect(read.has(property), `${property} is exempted but no longer read`).toBe(true);
        }
    });

    it('names the tokens whose absence was silent', () => {
        // Each of these was read and undefined at some point, and each failed in
        // a way nothing caught: zero padding, a fallback standing in for a
        // palette entry, one name meaning two sizes. Named individually so
        // deleting the last reference cannot quietly retire the token with it.
        for (const property of ['--space-5', '--color-text-secondary', '--font-size-sm', '--color-border-subtle']) {
            expect(defined.has(property), `${property} must stay defined`).toBe(true);
        }
    });
});
