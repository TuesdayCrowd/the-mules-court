import { describe, expect, it } from 'vitest';
import { CARD_CATALOG } from '../../game/engine';
import type { CardTypeId } from '../../game/engine';
import { CARD_COPY, cardCopyFor } from './cardCopy';

const ALL_IDS = Object.keys(CARD_CATALOG) as CardTypeId[];

describe('card copy', () => {
    it('covers every card in the catalog', () => {
        for (const id of ALL_IDS) expect(CARD_COPY).toHaveProperty(id);
    });

    it('never drifts from the catalog on name or value', () => {
        for (const id of ALL_IDS) {
            const copy = cardCopyFor(id);
            expect(copy.displayName).toBe(CARD_CATALOG[id].displayName);
            expect(copy.value).toBe(CARD_CATALOG[id].value);
        }
    });

    it('points every card at an existing portrait directory', () => {
        for (const id of ALL_IDS) {
            expect(cardCopyFor(id).portraitKey).toBe(`portrait-${CARD_CATALOG[id].assetSlug}`);
        }
    });

    it('gives every card a non-empty effect sentence', () => {
        for (const id of ALL_IDS) {
            expect(cardCopyFor(id).effect.length, id).toBeGreaterThan(0);
        }
    });

    it('gives the Informant guess-range copy that excludes its own value', () => {
        expect(cardCopyFor('informant').effect).toContain('2 to 8');
        expect(cardCopyFor('informant').effect).not.toContain('1 to 8');
    });

    it('states the Mule consequence in the second person', () => {
        expect(cardCopyFor('mule').playWarning).toBe('Discard The Mule — you are eliminated.');
    });

    it('leaves playWarning undefined for every card but the Mule', () => {
        for (const id of ALL_IDS) {
            if (id !== 'mule') expect(cardCopyFor(id).playWarning).toBeUndefined();
        }
    });
});
