import { describe, it, expect } from 'vitest';
import { CARD_CATALOG, cardTypeOf, makeCardInstanceId } from '../cardCatalog';
import type { CardTypeId } from '../types';

describe('CARD_CATALOG', () => {
    it('contains exactly 16 physical cards', () => {
        const total = Object.values(CARD_CATALOG).reduce((sum, card) => sum + card.count, 0);
        expect(total).toBe(16);
    });

    it('defines 11 card identities', () => {
        expect(Object.keys(CARD_CATALOG)).toHaveLength(11);
    });

    it('maps paired identities onto one shared effect type', () => {
        expect(CARD_CATALOG['han-pritcher'].effectType).toBe('PRIEST');
        expect(CARD_CATALOG['bail-channis'].effectType).toBe('PRIEST');
        expect(CARD_CATALOG['ebling-mis'].effectType).toBe('BARON');
        expect(CARD_CATALOG['magnifico'].effectType).toBe('BARON');
        expect(CARD_CATALOG['bayta-darell'].effectType).toBe('PRINCE');
        expect(CARD_CATALOG['toran-darell'].effectType).toBe('PRINCE');
    });

    it('gives each paired identity the same value but a distinct name and portrait', () => {
        expect(CARD_CATALOG['han-pritcher'].value).toBe(CARD_CATALOG['bail-channis'].value);
        expect(CARD_CATALOG['han-pritcher'].displayName).not.toBe(CARD_CATALOG['bail-channis'].displayName);
        expect(CARD_CATALOG['han-pritcher'].assetSlug).not.toBe(CARD_CATALOG['bail-channis'].assetSlug);
    });

    it('matches the spec counts', () => {
        expect(CARD_CATALOG.informant.count).toBe(5);
        expect(CARD_CATALOG['shielded-mind'].count).toBe(2);
        expect(CARD_CATALOG.mule.count).toBe(1);
    });

    it('matches the spec values', () => {
        const values: Record<CardTypeId, number> = {
            informant: 1,
            'han-pritcher': 2,
            'bail-channis': 2,
            'ebling-mis': 3,
            magnifico: 3,
            'shielded-mind': 4,
            'bayta-darell': 5,
            'toran-darell': 5,
            'mayor-indbur': 6,
            'first-speaker': 7,
            mule: 8
        };
        for (const [id, value] of Object.entries(values)) {
            expect(CARD_CATALOG[id as CardTypeId].value, id).toBe(value);
        }
    });

    it('keys every entry by its own id', () => {
        for (const [key, card] of Object.entries(CARD_CATALOG)) {
            expect(card.id).toBe(key);
        }
    });

    it('declares exactly one COUNTESS and one PRINCESS', () => {
        const byEffect = (effect: string) =>
            Object.values(CARD_CATALOG).filter(card => card.effectType === effect);
        expect(byEffect('COUNTESS')).toHaveLength(1);
        expect(byEffect('PRINCESS')).toHaveLength(1);
    });
});

describe('cardTypeOf', () => {
    it('recovers the card type from an instance id', () => {
        expect(cardTypeOf('informant#3')).toBe('informant');
        expect(cardTypeOf('mule#0')).toBe('mule');
    });

    it('handles hyphenated slugs', () => {
        expect(cardTypeOf('first-speaker#0')).toBe('first-speaker');
        expect(cardTypeOf('shielded-mind#1')).toBe('shielded-mind');
    });

    it('round-trips every catalog identity', () => {
        for (const id of Object.keys(CARD_CATALOG) as CardTypeId[]) {
            expect(cardTypeOf(makeCardInstanceId(id, 2))).toBe(id);
        }
    });
});

describe('makeCardInstanceId', () => {
    it('joins type and ordinal', () => {
        expect(makeCardInstanceId('informant', 4)).toBe('informant#4');
    });
});
