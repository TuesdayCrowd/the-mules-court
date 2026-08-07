import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast';
import { TOKENS } from './tokens';

const AA_SMALL = 4.5;
const AA_LARGE = 3.0;

type TokenName = keyof typeof TOKENS;

describe('contrastRatio', () => {
    it('is 21 for black on white', () => {
        expect(contrastRatio(0x000000, 0xffffff)).toBeCloseTo(21, 1);
    });

    it('is 1 for a colour against itself', () => {
        expect(contrastRatio(0x123456, 0x123456)).toBeCloseTo(1, 5);
    });
});

/**
 * Every token is classified by the job it does, and the classification is checked
 * for completeness below. Tokens are listed by NAME rather than by value on
 * purpose: several share a hex (paused and match-over are both #fbbf24), so a
 * value-keyed table would collapse them into one indistinguishable case and let a
 * token go silently untested.
 */

/** Carries small text. AA governs these strictly. */
const SMALL_TEXT = [
    'colorTextPrimary',
    'colorTextSecondary',
    'colorStateYourTurn',
    'colorStateWaiting',
    'colorStateRoundOver',
    'colorStatePaused',
    'colorStateMatchOver',
    'colorSeatEliminated',
    'colorSeatProtected'
] as const satisfies readonly TokenName[];

/**
 * Borders, large numerals, and other component boundaries.
 *
 * #6b7280 measures 4.34 — just under small-text AA, which is exactly why it
 * borders seats and never labels them. #9ca3af (8.27) is the grey to reach for
 * whenever grey has to carry words.
 */
const NON_TEXT = [
    'colorSeatOther',
    'colorSeatDisconnected',
    'colorSeatCurrent',
    'colorNebulaRed',
    'colorNebulaPurple'
] as const satisfies readonly TokenName[];

/**
 * Surface fills behind `view.deckCount` (UIX §6.4) — not text, not a component
 * boundary, so the 3:1 UI threshold asks the wrong question of them. #991b1b
 * measures 2.53 against black and is kept anyway: the design specifies dark red
 * as the empty-deck dread signal, and lightening it to clear a threshold it was
 * never governed by would trade the signal for a number.
 *
 * What has to hold is that the count stays readable whatever the fill beneath it,
 * so that is what is asserted. Deck state is never carried by colour alone in any
 * case — the numeral and the pulse rate both say it (WCAG 1.4.1).
 *
 * Deliberately not asserted: that the three fills contrast with *each other*.
 * Purple #9333ea and orange #b45309 differ by hue, not luminance (they measure
 * 1.07 apart), so that assertion would fail while describing nothing real.
 */
const DECK_FILLS = ['colorDeckFull', 'colorDeckLow', 'colorDeckEmpty'] as const satisfies readonly TokenName[];

/** The page behind everything. Nothing is measured against itself. */
const BACKGROUND = ['colorBg'] as const satisfies readonly TokenName[];

describe('palette legibility on the black background', () => {
    it.each(SMALL_TEXT)('%s clears AA for small text on black', name => {
        expect(contrastRatio(TOKENS[name], TOKENS.colorBg)).toBeGreaterThanOrEqual(AA_SMALL);
    });

    it.each(NON_TEXT)('%s clears AA for large text and UI on black', name => {
        expect(contrastRatio(TOKENS[name], TOKENS.colorBg)).toBeGreaterThanOrEqual(AA_LARGE);
    });
});

describe('the deck count stays legible on every deck fill', () => {
    it.each(DECK_FILLS)('reads the count in the primary foreground on %s', name => {
        expect(contrastRatio(TOKENS.colorTextPrimary, TOKENS[name])).toBeGreaterThanOrEqual(AA_SMALL);
    });
});

describe('classification completeness', () => {
    it('assigns every palette token to exactly one contrast rule', () => {
        const classified = [...SMALL_TEXT, ...NON_TEXT, ...DECK_FILLS, ...BACKGROUND];

        // Unclassified: a token added to the palette without deciding what
        // legibility rule governs it, which is how a token goes untested.
        expect(Object.keys(TOKENS).filter(name => !classified.includes(name as never))).toEqual([]);

        // Double-classified: two rules would disagree about the same token.
        expect(classified.length, 'a token appears in more than one bucket').toBe(new Set(classified).size);
    });
});
