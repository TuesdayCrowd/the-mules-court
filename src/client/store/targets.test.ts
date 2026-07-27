import { describe, expect, it } from 'vitest';
import type { CardTypeId, RedactedView } from '../../game/engine';
import { makeView } from './__fixtures__/view';
import { sheetTargetsFor } from './targets';

function seat(id: string, overrides: Partial<RedactedView['players'][number]> = {}) {
    return {
        id,
        seat: 0,
        tokens: 0,
        alive: true,
        protected: false,
        discardPile: [] as ReadonlyArray<never>,
        discardValueTotal: 0,
        ...overrides
    };
}

/** Viewer is p1 throughout; the fixture's `own.playerId` says so. */
function view(players: ReturnType<typeof seat>[]): RedactedView {
    return makeView({ players, currentPlayerId: 'p1', own: { playerId: 'p1', hand: ['toran-darell#0'], legalPlays: ['toran-darell#0'] } });
}

const nameOf = (id: string) => ({ p1: 'Ana', p2: 'Bayta', p3: 'Toran' })[id] ?? id;

function targets(cardId: CardTypeId, players: ReturnType<typeof seat>[]) {
    return sheetTargetsFor(view(players), cardId, nameOf);
}

describe('sheetTargetsFor — self-targeting', () => {
    // The reported bug. Holding a Darell with the only opponent shielded, the
    // sheet offered no target at all, declared the play a fizzle, and sent a
    // frame the server refused with TARGET_REQUIRED — so the turn never moved.
    it('offers the viewer themselves for a Darell', () => {
        const list = targets('toran-darell', [seat('p1'), seat('p2', { protected: true })]);

        const self = list.find(entry => entry.playerId === 'p1')!;
        expect(self.eligible).toBe(true);
        expect(list.some(entry => entry.eligible)).toBe(true); // not a fizzle
    });

    it('offers self for both Darells, since they share the effect', () => {
        for (const id of ['bayta-darell', 'toran-darell'] as const) {
            expect(targets(id, [seat('p1'), seat('p2')]).find(e => e.playerId === 'p1')?.eligible).toBe(true);
        }
    });

    it('marks the viewer so they can tell which button is them', () => {
        expect(targets('toran-darell', [seat('p1'), seat('p2')]).find(e => e.playerId === 'p1')!.nickname).toBe('Ana (you)');
    });

    it('lets a shielded viewer still target themselves', () => {
        // Protection is against OTHER players; it never blocks your own play.
        const list = targets('toran-darell', [seat('p1', { protected: true }), seat('p2', { protected: true })]);
        expect(list.find(e => e.playerId === 'p1')!.eligible).toBe(true);
    });

    it('never offers self for a card whose effect forbids it', () => {
        for (const id of ['informant', 'han-pritcher', 'ebling-mis', 'mayor-indbur'] as const) {
            expect(targets(id, [seat('p1'), seat('p2')]).some(e => e.playerId === 'p1'), id).toBe(false);
        }
    });
});

describe('sheetTargetsFor — opponents', () => {
    it('lists every opponent, ineligible ones included with a reason', () => {
        const list = targets('informant', [seat('p1'), seat('p2', { protected: true }), seat('p3', { alive: false })]);

        expect(list.map(e => e.playerId)).toEqual(['p2', 'p3']);
        expect(list[0]).toMatchObject({ eligible: false, reason: 'protected' });
        expect(list[1]).toMatchObject({ eligible: false, reason: 'eliminated' });
    });

    it('leaves an ordinary opponent eligible with no reason', () => {
        const entry = targets('informant', [seat('p1'), seat('p2')])[0];
        expect(entry.eligible).toBe(true);
        expect(entry.reason).toBeUndefined();
    });

    it('returns nothing at all for a card that takes no target', () => {
        for (const id of ['shielded-mind', 'first-speaker', 'mule'] as const) {
            expect(targets(id, [seat('p1'), seat('p2')]), id).toEqual([]);
        }
    });
});

describe('sheetTargetsFor — agreement with the engine', () => {
    // The client must not invent a target rule. These pin the two halves of
    // `computeLegalTargets`: alive always, and self iff `canTargetSelf`.
    it('never offers an eliminated seat, self or otherwise', () => {
        const list = targets('toran-darell', [seat('p1', { alive: false }), seat('p2', { alive: false })]);
        expect(list.every(entry => !entry.eligible)).toBe(true);
    });

    it('reports a genuine fizzle when the Darell is the only living seat left', () => {
        // Self is alive, so this is NOT a fizzle — it is a legal self-target.
        const list = targets('toran-darell', [seat('p1'), seat('p2', { alive: false })]);
        expect(list.some(entry => entry.eligible)).toBe(true);
    });

    it('reports a fizzle for a Guard when every opponent is protected', () => {
        const list = targets('informant', [seat('p1'), seat('p2', { protected: true })]);
        expect(list.some(entry => entry.eligible)).toBe(false);
    });
});
