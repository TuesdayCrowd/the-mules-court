import { describe, expect, test } from 'vitest';
import { rulesFor } from './rules';

const flat = (tokensToWin: number, playerCount: number): string =>
    rulesFor(tokensToWin, playerCount)
        .flatMap(section => [section.heading, ...section.lines])
        .join('\n');

describe('rulesFor', () => {
    test('states the devotion-token target for this table', () => {
        // The gap these rules exist to close: the target is on every view and
        // was rendered nowhere during play.
        expect(flat(4, 4)).toContain('first player to 4 tokens');
        expect(flat(5, 3)).toContain('first player to 5 tokens');
        expect(flat(7, 2)).toContain('first player to 7 tokens');
    });

    test('describes the cards set aside for this table size', () => {
        expect(flat(7, 2)).toContain('face up');
        expect(flat(5, 3)).toContain('one card is set aside face down');
        expect(flat(4, 4)).toContain('nothing is set aside');
    });

    test('covers the endings a player has to understand', () => {
        const text = flat(4, 4);
        expect(text).toContain('only one player is left');
        expect(text).toContain('deck runs out');
        // The deck-out tiebreak is genuinely obscure and decides real rounds.
        expect(text).toContain('discarded values');
    });

    test('names cards rather than restating their values', () => {
        // Sourced from CARD_CATALOG, so a renamed card renames itself here.
        const text = flat(4, 4);
        expect(text).toContain('The Mule');
        expect(text).toContain('The First Speaker');
        expect(text).toContain('Shielded Mind');
    });

    test('gives every section a heading and at least one line', () => {
        for (const section of rulesFor(4, 4)) {
            expect(section.heading.length).toBeGreaterThan(0);
            expect(section.lines.length).toBeGreaterThan(0);
            for (const line of section.lines) expect(line.endsWith('.')).toBe(true);
        }
    });

    test('reads the same for every table except the numbers that differ', () => {
        const four = rulesFor(4, 4).map(s => s.heading);
        const two = rulesFor(7, 2).map(s => s.heading);
        expect(two).toEqual(four);
    });
});
