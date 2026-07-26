/**
 * Builders for the two shapes every store test needs.
 *
 * A `RedactedView` has seventeen fields and a hand-written literal per test buries
 * the one field the test is actually about. These give a valid default and let a
 * test override only what it means to assert on.
 */

import type { PlayerId, RedactedView } from '../../../game/engine';
import type { ServerMessage } from '../../../server/protocol';

type StateUpdate = Extract<ServerMessage, { type: 'STATE_UPDATE' }>;

function seatOf(id: PlayerId, seat: number) {
    return {
        id,
        seat,
        tokens: 0,
        alive: true,
        protected: false,
        discardPile: [] as ReadonlyArray<never>,
        discardValueTotal: 0
    };
}

/** A mid-round two-player view, seen from p1. */
export function makeView(overrides: Partial<RedactedView> = {}): RedactedView {
    return {
        matchId: 'K7QX2',
        playerCount: 2,
        tokensToWin: 7,
        mode: 'normal',
        players: [seatOf('p1', 0), seatOf('p2', 1)],
        deckCount: 10,
        setAsideFaceUp: null,
        currentPlayerId: 'p1',
        turnNumber: 1,
        publicLog: [],
        own: { playerId: 'p1', hand: ['informant#1'], legalPlays: ['informant#1'] },
        revealed: [],
        roundResult: null,
        matchWinnerId: null,
        ...overrides
    };
}

/** A STATE_UPDATE wrapping `makeView()`, with the transport fields at their quiet defaults. */
export function makeStateUpdate(overrides: Partial<StateUpdate> = {}): StateUpdate {
    return {
        type: 'STATE_UPDATE',
        view: makeView(),
        nicknames: { p1: 'Ana', p2: 'Bayta' },
        phase: 'active',
        paused: false,
        missingSeats: [],
        serverTime: 1_000_000,
        ...overrides
    };
}
