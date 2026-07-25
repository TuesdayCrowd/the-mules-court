import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast';
import { TOKENS } from './tokens';

const AA_SMALL = 4.5;
const AA_LARGE = 3.0;

describe('contrastRatio', () => {
    it('is 21 for black on white', () => {
        expect(contrastRatio(0x000000, 0xffffff)).toBeCloseTo(21, 1);
    });

    it('is 1 for a colour against itself', () => {
        expect(contrastRatio(0x123456, 0x123456)).toBeCloseTo(1, 5);
    });
});

describe('palette legibility on the black background', () => {
    // Tokens that carry small text. These are the ones AA governs strictly.
    const SMALL_TEXT = [
        TOKENS.colorTextPrimary,
        TOKENS.colorStateYourTurn,
        TOKENS.colorStateWaiting,
        TOKENS.colorStateRoundOver,
        TOKENS.colorStatePaused,
        TOKENS.colorSeatEliminated,
        TOKENS.colorSeatProtected
    ];

    // Tokens used only as borders, large numerals, and other component boundaries.
    // #6b7280 measures 4.34 here — just under small-text AA, which is exactly why
    // it borders seats and never labels them. #9ca3af (8.27) is the grey to reach
    // for whenever grey has to carry words.
    const NON_TEXT = [
        TOKENS.colorSeatOther,
        TOKENS.colorSeatDisconnected,
        TOKENS.colorSeatCurrent,
        TOKENS.colorNebulaRed,
        TOKENS.colorNebulaPurple,
        TOKENS.colorDeckFull
    ];

    it.each(SMALL_TEXT)('%s clears AA for small text on black', colour => {
        expect(contrastRatio(colour, TOKENS.colorBg)).toBeGreaterThanOrEqual(AA_SMALL);
    });

    it.each(NON_TEXT)('%s clears AA for large text and UI on black', colour => {
        expect(contrastRatio(colour, TOKENS.colorBg)).toBeGreaterThanOrEqual(AA_LARGE);
    });
});

/**
 * The deck's three colours are surface fills behind `view.deckCount` (UIX §6.4),
 * not text and not a component boundary, so the 3:1 UI threshold asks the wrong
 * question of them. #991b1b measures 2.53 against black and is kept anyway: the
 * design specifies dark red as the empty-deck dread signal, and lightening it to
 * clear a threshold it was never governed by would trade the signal for a number.
 *
 * What actually has to hold is that the count stays readable whatever the fill
 * beneath it, so that is what is asserted. Deck state is never carried by colour
 * alone in any case — the numeral and the pulse rate both say it (WCAG 1.4.1).
 *
 * Deliberately not asserted: that the three fills contrast with *each other*.
 * Purple #9333ea and orange #b45309 differ by hue, not luminance (they measure
 * 1.07 apart), so that assertion would fail while describing nothing real.
 */
describe('the deck count stays legible on every deck fill', () => {
    const DECK_FILLS = [TOKENS.colorDeckFull, TOKENS.colorDeckLow, TOKENS.colorDeckEmpty];

    it.each(DECK_FILLS)('reads the count in the primary foreground on %s', fill => {
        expect(contrastRatio(TOKENS.colorTextPrimary, fill)).toBeGreaterThanOrEqual(AA_SMALL);
    });
});
