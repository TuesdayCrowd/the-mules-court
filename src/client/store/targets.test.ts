import { describe, expect, it } from 'vitest';
import type { CardInstanceId, PlayerId, RedactedView } from '../../game/engine';
import { createMatch, view as engineView } from '../../game/engine';
import type { MatchState } from '../../game/engine';
import { makeView } from './__fixtures__/view';
import { cardTakesTarget, sheetTargetsFor } from './targets';

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

const nameOf = (id: string) => ({ p1: 'Ana', p2: 'Bayta', p3: 'Toran' })[id] ?? id;

/** A view from p1's seat, with the engine's answer supplied explicitly. */
function viewWith(
    players: ReturnType<typeof seat>[],
    card: CardInstanceId,
    legal: PlayerId[]
): RedactedView {
    return makeView({
        players,
        currentPlayerId: 'p1',
        own: { playerId: 'p1', hand: [card], legalPlays: [card], legalTargets: { [card]: legal } }
    });
}

describe('sheetTargetsFor — it reads the engine, it does not decide', () => {
    it('marks exactly the seats the engine listed as eligible', () => {
        const list = sheetTargetsFor(
            viewWith([seat('p1'), seat('p2'), seat('p3')], 'toran-darell#0', ['p1', 'p3']),
            'toran-darell#0',
            nameOf
        );

        expect(list.filter(entry => entry.eligible).map(entry => entry.playerId)).toEqual(['p1', 'p3']);
    });

    it('trusts the engine even when board state alone would suggest otherwise', () => {
        // p2 looks targetable — alive and unprotected — but the engine did not
        // list them. The client defers rather than second-guessing.
        const list = sheetTargetsFor(viewWith([seat('p1'), seat('p2')], 'informant#0', []), 'informant#0', nameOf);
        expect(list.find(entry => entry.playerId === 'p2')!.eligible).toBe(false);
    });

    it('treats an unknown card as offering nothing', () => {
        const list = sheetTargetsFor(viewWith([seat('p1'), seat('p2')], 'informant#0', ['p2']), 'mule#0', nameOf);
        expect(list.some(entry => entry.eligible)).toBe(false);
    });
});

describe('sheetTargetsFor — presentation', () => {
    it('lists the viewer only when the engine says they are targetable', () => {
        const withSelf = sheetTargetsFor(
            viewWith([seat('p1'), seat('p2')], 'toran-darell#0', ['p1', 'p2']),
            'toran-darell#0',
            nameOf
        );
        expect(withSelf.map(entry => entry.playerId)).toEqual(['p1', 'p2']);

        const withoutSelf = sheetTargetsFor(
            viewWith([seat('p1'), seat('p2')], 'informant#0', ['p2']),
            'informant#0',
            nameOf
        );
        expect(withoutSelf.map(entry => entry.playerId)).toEqual(['p2']);
    });

    it('marks the viewer so they can tell which button is them', () => {
        const list = sheetTargetsFor(
            viewWith([seat('p1'), seat('p2')], 'toran-darell#0', ['p1', 'p2']),
            'toran-darell#0',
            nameOf
        );
        expect(list.find(entry => entry.playerId === 'p1')!.nickname).toBe('Ana (you)');
    });

    it('keeps every opponent listed, so a disabled button can carry its reason', () => {
        const list = sheetTargetsFor(
            viewWith([seat('p1'), seat('p2', { protected: true }), seat('p3', { alive: false })], 'informant#0', []),
            'informant#0',
            nameOf
        );

        expect(list.map(entry => entry.playerId)).toEqual(['p2', 'p3']);
        expect(list[0]).toMatchObject({ eligible: false, reason: 'protected' });
        expect(list[1]).toMatchObject({ eligible: false, reason: 'eliminated' });
    });

    it('gives an eligible seat no reason to explain', () => {
        const list = sheetTargetsFor(viewWith([seat('p1'), seat('p2')], 'informant#0', ['p2']), 'informant#0', nameOf);
        expect(list[0].reason).toBeUndefined();
    });

    it('never labels a self-target "protected", since protection is against others', () => {
        const list = sheetTargetsFor(
            viewWith([seat('p1', { protected: true }), seat('p2')], 'toran-darell#0', ['p1', 'p2']),
            'toran-darell#0',
            nameOf
        );
        const self = list.find(entry => entry.playerId === 'p1')!;
        expect(self.eligible).toBe(true);
        expect(self.reason).toBeUndefined();
    });
});

describe('cardTakesTarget', () => {
    it('separates a fizzle from a card that needs no target', () => {
        expect(cardTakesTarget('informant')).toBe(true);
        expect(cardTakesTarget('toran-darell')).toBe(true);
        expect(cardTakesTarget('shielded-mind')).toBe(false);
        expect(cardTakesTarget('first-speaker')).toBe(false);
        expect(cardTakesTarget('mule')).toBe(false);
    });
});

describe('agreement with the real engine', () => {
    // The point of the whole change: what the sheet offers IS what the engine
    // would accept. This drives a real view rather than a hand-built one, so a
    // future targeting rule cannot land in the engine and be missed here.
    function realView(hand: CardInstanceId[], mutate: (state: MatchState) => MatchState = s => s): RedactedView {
        const base = createMatch(['p0', 'p1', 'p2'], 'targets-seed');
        const state = mutate({
            ...base,
            round: {
                ...base.round,
                seatOrder: ['p0', 'p1', 'p2'],
                currentPlayerIndex: 0,
                players: { ...base.round.players, p0: { ...base.round.players.p0, hand } }
            }
        });
        return engineView(state, 'p0');
    }

    it('offers the viewer a Darell aimed at themselves', () => {
        const view = realView(['toran-darell#0', 'informant#0']);
        const list = sheetTargetsFor(view, 'toran-darell#0', id => id);

        expect(list.find(entry => entry.playerId === 'p0')!.eligible).toBe(true);
    });

    it('does not offer the viewer an Informant aimed at themselves', () => {
        const view = realView(['toran-darell#0', 'informant#0']);
        expect(sheetTargetsFor(view, 'informant#0', id => id).some(entry => entry.playerId === 'p0')).toBe(false);
    });

    it('still offers a self-target when every opponent is protected — the reported bug', () => {
        const view = realView(['toran-darell#0', 'informant#0'], state => ({
            ...state,
            round: {
                ...state.round,
                players: {
                    ...state.round.players,
                    p1: { ...state.round.players.p1, protected: true },
                    p2: { ...state.round.players.p2, protected: true }
                }
            }
        }));

        const list = sheetTargetsFor(view, 'toran-darell#0', id => id);
        expect(list.some(entry => entry.eligible)).toBe(true); // not a fizzle
        expect(list.find(entry => entry.playerId === 'p0')!.eligible).toBe(true);
    });

    it('is a genuine fizzle for an Informant when every opponent is protected', () => {
        const view = realView(['informant#0', 'toran-darell#0'], state => ({
            ...state,
            round: {
                ...state.round,
                players: {
                    ...state.round.players,
                    p1: { ...state.round.players.p1, protected: true },
                    p2: { ...state.round.players.p2, protected: true }
                }
            }
        }));

        expect(sheetTargetsFor(view, 'informant#0', id => id).some(entry => entry.eligible)).toBe(false);
    });

    it('offers nothing to a player who does not hold the turn', () => {
        const base = createMatch(['p0', 'p1'], 'targets-seed');
        const off = engineView({ ...base, round: { ...base.round, currentPlayerIndex: 0 } }, 'p1');

        for (const card of off.own.hand) {
            expect(sheetTargetsFor(off, card, id => id).some(entry => entry.eligible)).toBe(false);
        }
    });
});
