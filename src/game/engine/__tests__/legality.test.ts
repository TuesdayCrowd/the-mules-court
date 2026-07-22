import { describe, it, expect } from 'vitest';
import { computeLegalPlays, computeLegalTargets } from '../legality';
import { EFFECT_DEFS } from '../effectRegistry';
import { makeRound, makePlayers } from './helpers';

describe('computeLegalPlays — the First Speaker forced-play rule', () => {
    it('returns both cards for an ordinary hand', () => {
        const round = makeRound({
            players: makePlayers({ p0: { hand: ['informant#0', 'mayor-indbur#0'] }, p1: {} })
        });
        expect(computeLegalPlays(round, 'p0')).toEqual(['informant#0', 'mayor-indbur#0']);
    });

    it('forces the First Speaker when held with Mayor Indbur (KING)', () => {
        const round = makeRound({
            players: makePlayers({ p0: { hand: ['first-speaker#0', 'mayor-indbur#0'] }, p1: {} })
        });
        expect(computeLegalPlays(round, 'p0')).toEqual(['first-speaker#0']);
    });

    it('forces the First Speaker when held with Bayta Darell (PRINCE)', () => {
        const round = makeRound({
            players: makePlayers({ p0: { hand: ['bayta-darell#0', 'first-speaker#0'] }, p1: {} })
        });
        expect(computeLegalPlays(round, 'p0')).toEqual(['first-speaker#0']);
    });

    it('forces the First Speaker when held with Toran Darell (the other PRINCE)', () => {
        const round = makeRound({
            players: makePlayers({ p0: { hand: ['toran-darell#0', 'first-speaker#0'] }, p1: {} })
        });
        expect(computeLegalPlays(round, 'p0')).toEqual(['first-speaker#0']);
    });

    it('leaves both playable when the First Speaker is held with a GUARD', () => {
        const round = makeRound({
            players: makePlayers({ p0: { hand: ['first-speaker#0', 'informant#0'] }, p1: {} })
        });
        expect(computeLegalPlays(round, 'p0')).toEqual(['first-speaker#0', 'informant#0']);
    });

    it('leaves both playable when the First Speaker is held with a BARON', () => {
        const round = makeRound({
            players: makePlayers({ p0: { hand: ['first-speaker#0', 'ebling-mis#0'] }, p1: {} })
        });
        expect(computeLegalPlays(round, 'p0')).toEqual(['first-speaker#0', 'ebling-mis#0']);
    });

    it('returns the single card of a one-card hand', () => {
        const round = makeRound({ players: makePlayers({ p0: { hand: ['mule#0'] }, p1: {} }) });
        expect(computeLegalPlays(round, 'p0')).toEqual(['mule#0']);
    });

    it('returns nothing for an empty hand', () => {
        const round = makeRound({ players: makePlayers({ p0: { hand: [] }, p1: {} }) });
        expect(computeLegalPlays(round, 'p0')).toEqual([]);
    });
});

describe('computeLegalTargets', () => {
    const guard = EFFECT_DEFS.GUARD;
    const prince = EFFECT_DEFS.PRINCE;

    it('includes living, unprotected opponents', () => {
        const round = makeRound({ players: makePlayers({ p0: {}, p1: {}, p2: {} }) });
        expect(computeLegalTargets(round, 'p0', guard)).toEqual(['p1', 'p2']);
    });

    it('excludes eliminated opponents', () => {
        const round = makeRound({ players: makePlayers({ p0: {}, p1: { alive: false }, p2: {} }) });
        expect(computeLegalTargets(round, 'p0', guard)).toEqual(['p2']);
    });

    it('excludes protected opponents', () => {
        const round = makeRound({ players: makePlayers({ p0: {}, p1: { protected: true }, p2: {} }) });
        expect(computeLegalTargets(round, 'p0', guard)).toEqual(['p2']);
    });

    it('excludes the actor when the effect forbids self-targeting', () => {
        const round = makeRound({ players: makePlayers({ p0: {}, p1: {} }) });
        expect(computeLegalTargets(round, 'p0', guard)).not.toContain('p0');
    });

    it('includes the actor when the effect allows self-targeting', () => {
        const round = makeRound({ players: makePlayers({ p0: {}, p1: {} }) });
        expect(computeLegalTargets(round, 'p0', prince)).toContain('p0');
    });

    it('includes a self-targeting actor even while that actor is protected', () => {
        const round = makeRound({ players: makePlayers({ p0: { protected: true }, p1: {} }) });
        expect(computeLegalTargets(round, 'p0', prince)).toContain('p0');
    });

    it('excludes a dead actor even when the effect allows self-targeting', () => {
        const round = makeRound({ players: makePlayers({ p0: { alive: false }, p1: {} }) });
        expect(computeLegalTargets(round, 'p0', prince)).not.toContain('p0');
    });

    // The audited bug: a single `canTargetSelf || !protected` predicate applied to
    // every candidate lets a Prince reach a protected opponent. The actor check and
    // the opponent check must stay separate.
    it('still excludes a PROTECTED OPPONENT when the effect allows self-targeting', () => {
        const round = makeRound({ players: makePlayers({ p0: {}, p1: { protected: true }, p2: {} }) });
        const targets = computeLegalTargets(round, 'p0', prince);
        expect(targets).not.toContain('p1');
        expect(targets).toEqual(['p0', 'p2']);
    });

    it('still excludes an ELIMINATED OPPONENT when the effect allows self-targeting', () => {
        const round = makeRound({ players: makePlayers({ p0: {}, p1: { alive: false }, p2: {} }) });
        expect(computeLegalTargets(round, 'p0', prince)).not.toContain('p1');
    });

    it('returns nothing when every opponent is protected or dead and self is forbidden', () => {
        const round = makeRound({
            players: makePlayers({ p0: {}, p1: { protected: true }, p2: { alive: false } })
        });
        expect(computeLegalTargets(round, 'p0', guard)).toEqual([]);
    });

    it('never leaves a PRINCE without a target, since the actor always qualifies', () => {
        const round = makeRound({
            players: makePlayers({ p0: {}, p1: { protected: true }, p2: { alive: false } })
        });
        expect(computeLegalTargets(round, 'p0', prince)).toEqual(['p0']);
    });

    it('returns nothing for an effect that takes no target', () => {
        const round = makeRound({ players: makePlayers({ p0: {}, p1: {} }) });
        expect(computeLegalTargets(round, 'p0', EFFECT_DEFS.HANDMAID)).toEqual([]);
    });
});
