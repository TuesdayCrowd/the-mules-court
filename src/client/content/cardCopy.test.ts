import { describe, expect, it } from 'vitest';
import { CARD_CATALOG } from '../../game/engine';
import type { CardTypeId } from '../../game/engine';
import { CARD_COPY, cardCopyFor, cardLabel } from './cardCopy';

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

describe('cardLabel', () => {
    it('puts the value first', () => {
        expect(cardLabel('informant')).toBe('1 · Informant');
        expect(cardLabel('first-speaker')).toBe('7 · The First Speaker');
    });

    it('leads with the value for every card in the catalog', () => {
        for (const id of ALL_IDS) {
            expect(cardLabel(id).startsWith(String(CARD_CATALOG[id].value)), id).toBe(true);
        }
    });

    it('distinguishes cards whose portraits resemble each other', () => {
        // The reason this exists. The First Speaker (7) and the Informant (1)
        // have visually similar portrait art, and a card face carrying only art
        // is a card a player has to recognise rather than read — which cost a
        // real misread of a comparison during play.
        expect(cardLabel('first-speaker')).not.toBe(cardLabel('informant'));
        expect(cardLabel('first-speaker')).toContain('7');
        expect(cardLabel('informant')).toContain('1');
    });

    it('gives the two characters sharing a value distinct labels', () => {
        // Value alone is not identity: 5 is both Darells, and the name is what
        // separates them.
        expect(cardLabel('bayta-darell')).not.toBe(cardLabel('toran-darell'));
        expect(cardLabel('bayta-darell')).toContain('5');
        expect(cardLabel('toran-darell')).toContain('5');
    });
});
