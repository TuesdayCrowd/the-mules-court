import { describe, it, expect } from 'vitest';
import { EFFECT_DEFS } from '../effectRegistry';
import { CARD_CATALOG } from '../cardCatalog';
import type { EffectType } from '../types';

const ALL_EFFECTS: EffectType[] = [
    'GUARD',
    'PRIEST',
    'BARON',
    'HANDMAID',
    'PRINCE',
    'KING',
    'COUNTESS',
    'PRINCESS'
];

const only = (predicate: (effect: EffectType) => boolean): EffectType[] => ALL_EFFECTS.filter(predicate);

describe('EFFECT_DEFS', () => {
    it('defines exactly 8 effect types', () => {
        expect(Object.keys(EFFECT_DEFS)).toHaveLength(8);
    });

    it('keys every entry by its own effect type', () => {
        for (const [key, def] of Object.entries(EFFECT_DEFS)) {
            expect(def.effectType).toBe(key);
        }
    });

    it('gives every card identity an effect definition', () => {
        for (const card of Object.values(CARD_CATALOG)) {
            expect(EFFECT_DEFS[card.effectType], card.id).toBeDefined();
        }
    });

    it('lets only PRINCE target itself', () => {
        expect(only(e => EFFECT_DEFS[e].canTargetSelf)).toEqual(['PRINCE']);
    });

    it('lets only GUARD name a card', () => {
        expect(only(e => EFFECT_DEFS[e].requiresGuess)).toEqual(['GUARD']);
    });

    it('lets only PRINCESS eliminate its holder on discard', () => {
        expect(only(e => EFFECT_DEFS[e].eliminatesOnDiscard)).toEqual(['PRINCESS']);
    });

    it('marks HANDMAID, COUNTESS and PRINCESS as passive', () => {
        expect(only(e => EFFECT_DEFS[e].isPassive)).toEqual(['HANDMAID', 'COUNTESS', 'PRINCESS']);
    });

    it('requires a target for exactly the five targeting effects', () => {
        expect(only(e => EFFECT_DEFS[e].requiresTarget)).toEqual([
            'GUARD',
            'PRIEST',
            'BARON',
            'PRINCE',
            'KING'
        ]);
    });

    it('forces the First Speaker only alongside KING or PRINCE', () => {
        expect(EFFECT_DEFS.COUNTESS.forcedPlayTriggers).toEqual(['KING', 'PRINCE']);
    });

    it('gives every other effect no forced-play triggers', () => {
        for (const effect of ALL_EFFECTS.filter(e => e !== 'COUNTESS')) {
            expect(EFFECT_DEFS[effect].forcedPlayTriggers, effect).toEqual([]);
        }
    });

    it('attaches a resolver to every effect', () => {
        for (const effect of ALL_EFFECTS) {
            expect(typeof EFFECT_DEFS[effect].resolve, effect).toBe('function');
        }
    });

    it('never requires a guess without also requiring a target', () => {
        for (const effect of ALL_EFFECTS) {
            const def = EFFECT_DEFS[effect];
            if (def.requiresGuess) expect(def.requiresTarget, effect).toBe(true);
        }
    });

    it('never marks a passive effect as requiring a target', () => {
        for (const effect of ALL_EFFECTS) {
            const def = EFFECT_DEFS[effect];
            if (def.isPassive) expect(def.requiresTarget, effect).toBe(false);
        }
    });
});
