import { describe, expect, it } from 'vitest';
import { CARD_CATALOG } from '../../game/engine';
import type { CardTypeId } from '../../game/engine';
import { QUICK_REFERENCE, totalCards } from './quickReference';

describe('quick reference', () => {
    it('runs from 8 down to 1', () => {
        expect(QUICK_REFERENCE.map(r => r.value)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    });

    it('accounts for all sixteen physical cards', () => {
        expect(totalCards()).toBe(16);
    });

    it('puts five Informants at value 1', () => {
        const row = QUICK_REFERENCE.find(r => r.value === 1)!;
        expect(row.count).toBe(5);
        expect(row.cards).toHaveLength(1);
    });

    it('shares value 5 between both Darells', () => {
        const row = QUICK_REFERENCE.find(r => r.value === 5)!;
        expect(row.cards.map(c => c.displayName).sort()).toEqual(['Bayta Darell', 'Toran Darell']);
        expect(row.count).toBe(2);
    });

    it('shares value 2 and value 3 between two characters each', () => {
        for (const value of [2, 3]) {
            expect(QUICK_REFERENCE.find(r => r.value === value)!.cards).toHaveLength(2);
        }
    });

    it('marks value 1 as unguessable and every other value as guessable', () => {
        for (const row of QUICK_REFERENCE) {
            expect(row.guessable).toBe(row.value !== 1);
        }
    });

    it('names every card in the catalog exactly once across all rows', () => {
        const listed = QUICK_REFERENCE.flatMap(row => row.cards.map(c => c.id)).sort();
        const catalog = (Object.keys(CARD_CATALOG) as CardTypeId[]).sort();
        expect(listed).toEqual(catalog);
    });

    it('sums each row count from the catalog rather than a retyped literal', () => {
        for (const row of QUICK_REFERENCE) {
            const expected = row.cards.reduce((sum, card) => sum + CARD_CATALOG[card.id].count, 0);
            expect(row.count, `value ${row.value}`).toBe(expected);
        }
    });
});
