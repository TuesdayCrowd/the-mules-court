import { describe, expect, it } from 'vitest';
import { FONT_DISPLAY, FONT_UI } from './fonts';

/**
 * A family name with a space in it must be quoted, or the whole `ctx.font`
 * assignment is invalid and the canvas silently keeps `10px sans-serif`. That
 * is a rendering bug with no error attached to it, so it is worth a test that
 * fails the moment someone tidies the quotes away.
 */
function firstFamily(stack: string): string {
    return stack.split(',')[0].trim();
}

function isValidUnquotedIdentifier(family: string): boolean {
    // CSS custom-ident: no spaces, and may not start with a digit.
    return /^[A-Za-z_-][A-Za-z0-9_-]*$/.test(family);
}

describe.each([
    ['FONT_DISPLAY', FONT_DISPLAY],
    ['FONT_UI', FONT_UI]
])('%s', (_name, stack) => {
    it('ends in a generic family, so there is something to fall back to', () => {
        expect(stack.split(',').map(part => part.trim())).toContain('sans-serif');
    });

    it('quotes its first family unless that family is a bare identifier', () => {
        const family = firstFamily(stack);
        const quoted = family.startsWith('"') && family.endsWith('"');

        expect(quoted || isValidUnquotedIdentifier(family), `${family} must be quoted to survive ctx.font`).toBe(true);
    });
});

describe('FONT_DISPLAY specifically', () => {
    it('quotes "Exo 2", whose space makes an unquoted stack invalid', () => {
        expect(FONT_DISPLAY).toContain('"Exo 2"');
    });
});
