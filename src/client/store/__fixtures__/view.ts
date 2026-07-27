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

/**
 * Overrides for `makeView`, with `own` merged field by field.
 *
 * `own` grows — it gained `legalTargets` when targeting moved onto the wire —
 * and a test that only cares about `hand` should not have to restate the rest
 * of it to keep compiling.
 */
export type ViewOverrides = Partial<Omit<RedactedView, 'own'>> & {
    readonly own?: Partial<RedactedView['own']>;
};

/** A mid-round two-player view, seen from p1. */
export function makeView(overrides: ViewOverrides = {}): RedactedView {
    const { own, ...rest } = overrides;
    return {
        matchId: 'K7QX2',
        playerCount: 2,
        tokensToWin: 7,
        mode: 'normal',
        players: [seatOf('p1', 0), seatOf('p2', 1)],
        deckCount: 10,
        setAsideFaceUp: null,
        removedFaceDownCount: 0,
        currentPlayerId: 'p1',
        turnNumber: 1,
        publicLog: [],
        revealed: [],
        roundResult: null,
        matchWinnerId: null,
        ...rest,
        // Merged rather than replaced, and `legalTargets` defaults to empty so a
        // test that says nothing about targeting gets the inert answer instead
        // of a stale one that contradicts the `legalPlays` it did set.
        own: {
            playerId: 'p1',
            hand: ['informant#1'],
            legalPlays: ['informant#1'],
            legalTargets: {},
            ...own
        }
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
