import { describe, expect, test } from 'vitest';
import { CARD_CATALOG } from '../../game/engine';
import { DEFAULT_DIFFICULTY, DIFFICULTY_COPY, difficultyCopy } from './difficulty';

describe('difficulty copy', () => {
    test('covers every tier the protocol allows', () => {
        expect(DIFFICULTY_COPY.map(entry => entry.id)).toEqual(['novice', 'adept', 'master']);
    });

    test('reads weakest first', () => {
        expect(DIFFICULTY_COPY[0].id).toBe('novice');
        expect(DIFFICULTY_COPY[DIFFICULTY_COPY.length - 1].id).toBe('master');
    });

    test('never names a card', () => {
        // A seat labelled "Speaker" beside a First Speaker in play reads as a
        // revealed hand. In a deduction game that is worse than a dull name.
        const cardNames = Object.values(CARD_CATALOG).map(card => card.displayName.toLowerCase());

        for (const entry of DIFFICULTY_COPY) {
            for (const cardName of cardNames) {
                expect(cardName.split(' ')).not.toContain(entry.name.toLowerCase());
            }
        }
    });

    test('gives every tier a sentence about what it knows', () => {
        for (const entry of DIFFICULTY_COPY) {
            expect(entry.description.length).toBeGreaterThan(20);
            expect(entry.description.endsWith('.')).toBe(true);
        }
    });

    test('defaults to the middle tier, never the hardest', () => {
        expect(DEFAULT_DIFFICULTY).toBe('adept');
        expect(DEFAULT_DIFFICULTY).not.toBe(DIFFICULTY_COPY[DIFFICULTY_COPY.length - 1].id);
    });

    test('resolves a tier to its copy', () => {
        expect(difficultyCopy('master').name).toBe('Mentalic');
    });
});
