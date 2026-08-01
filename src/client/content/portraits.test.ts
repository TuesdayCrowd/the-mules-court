import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CARD_CATALOG } from '../../game/engine';
import type { CardTypeId } from '../../game/engine';
import { CARD_BACK_ASSET, PORTRAIT_CHOICE, portraitPath } from './portraits';

const ALL_IDS = Object.keys(CARD_CATALOG) as CardTypeId[];

describe('the portrait manifest', () => {
    it('names one portrait variant for every character', () => {
        for (const id of ALL_IDS) {
            expect(PORTRAIT_CHOICE[id], id).toMatch(/^portrait_[0-3]$/);
        }
    });

    it('names no character the catalog does not have', () => {
        expect(Object.keys(PORTRAIT_CHOICE).sort()).toEqual([...ALL_IDS].sort());
    });

    it("resolves to a path under the character's own asset directory", () => {
        expect(portraitPath('magnifico')).toBe('magnifico/portrait_0.png');
    });

    it('uses the asset slug, which is not always the display name', () => {
        // README's mapping: Magnifico Giganticus lives in magnifico/, and
        // The First Speaker in first-speaker/.
        expect(portraitPath('first-speaker')).toBe('first-speaker/portrait_0.png');
        expect(portraitPath('mule')).toBe('mule/portrait_0.png');
    });
});

describe('every path resolves to a file that exists', () => {
    // The manifest is the only place a variant is named, so a typo here is a
    // missing texture at runtime with nothing else to catch it.
    it.each(ALL_IDS)('%s', id => {
        expect(existsSync(`public/assets/${portraitPath(id)}`), portraitPath(id)).toBe(true);
    });

    it('finds the chosen card back', () => {
        expect(existsSync(`public/assets/${CARD_BACK_ASSET}`)).toBe(true);
    });
});
