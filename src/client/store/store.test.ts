import { describe, expect, it } from 'vitest';
import type { ClientMessage, ServerMessage } from '../../server/protocol';
import { makeStateUpdate, makeView } from './__fixtures__/view';
import type { SeatTokenStore, StoredSeat } from './seatTokenStore';
import type { StoreDeps } from './store';
import { createStore } from './store';
import type { ClientState } from './types';

// ------------------------------------------------------------------- fakes

const SEAT: StoredSeat = { seat: 0, playerId: 'p1', seatToken: 'tok-abc' };

/** A seat token store that records every call, so "exactly once" is assertable. */
function recordingTokens(initial: Record<string, StoredSeat> = {}) {
    const held = new Map(Object.entries(initial));
    const saves: string[] = [];
    const clears: string[] = [];

    const store: SeatTokenStore = {
        load: matchId => held.get(matchId) ?? null,
        save: (matchId, seat) => {
            saves.push(matchId);
            held.set(matchId, seat);
        },
        clear: matchId => {
            clears.push(matchId);
            held.delete(matchId);
        }
    };

    return { store, saves, clears, held };
}

interface Harness {
    readonly store: ReturnType<typeof createStore>;
    readonly sent: ClientMessage[];
    readonly tokens: ReturnType<typeof recordingTokens>;
    /** Every state object handed to subscribers, in order. */
    readonly seen: ClientState[];
}

function harness(overrides: Partial<StoreDeps> = {}, tokens = recordingTokens()): Harness {
    const sent: ClientMessage[] = [];
    let minted = 0;

    const store = createStore({
        matchId: 'K7QX2',
        tokens: tokens.store,
        send: msg => {
            sent.push(msg);
            return true;
        },
        now: () => 1_234_567,
        mintId: () => `id-${++minted}`,
        ...overrides
    });

    const seen: ClientState[] = [];
    store.subscribe(state => seen.push(state));

    return { store, sent, tokens, seen };
}

/** Get to the table with a pending play outstanding. */
function withPendingPlay(h: Harness): void {
    h.store.apply(makeStateUpdate());
    h.store.playCard({ cardInstanceId: 'informant#1', target: 'p2', guess: 5 });
}

// -------------------------------------------------------------------- tests

describe('createStore initial state', () => {
    it('starts at the menu when there is no match to join', () => {
        const h = harness({ matchId: null });
        expect(h.store.getState().screen).toBe('menu');
        expect(h.store.getState().matchId).toBeNull();
    });

    it('starts at joining for a match route', () => {
        expect(harness().store.getState().screen).toBe('joining');
    });

    it('adopts a stored seat at construction, so a resuming client is not asked to name itself again', () => {
        const tokens = recordingTokens({ K7QX2: SEAT });
        const h = harness({}, tokens);
        expect(h.store.getState().seat).toEqual({ seat: 0, playerId: 'p1' });
    });

    it('holds no seat when nothing is stored', () => {
        expect(harness().store.getState().seat).toBeNull();
    });

    it('begins connecting, with no table, lobby, notices, or fatal', () => {
        const state = harness().store.getState();
        expect(state.connection).toBe('connecting');
        expect(state.lobby).toBeNull();
        expect(state.table).toBeNull();
        expect(state.ended).toBeNull();
        expect(state.pendingPlay).toBeNull();
        expect(state.fatal).toBeNull();
        expect(state.notices).toEqual([]);
    });
});

describe('SEAT_CLAIMED', () => {
    it('persists the seat token and moves to the lobby', () => {
        const h = harness();

        h.store.apply({ type: 'SEAT_CLAIMED', matchId: 'K7QX2', seat: 1, playerId: 'p2', seatToken: 'tok-new' });

        expect(h.tokens.held.get('K7QX2')).toEqual({ seat: 1, playerId: 'p2', seatToken: 'tok-new' });
        expect(h.store.getState().seat).toEqual({ seat: 1, playerId: 'p2' });
        expect(h.store.getState().screen).toBe('lobby');
    });

    it('persists before it publishes, so a subscriber that reads storage sees the token', () => {
        // SEAT_CLAIMED is unicast and sent once. A subscriber reacting to the new
        // seat must not race the write that makes it survivable.
        const tokens = recordingTokens();
        const h = harness({}, tokens);
        let sawTokenAtNotify: StoredSeat | null = null;
        h.store.subscribe(() => {
            sawTokenAtNotify = tokens.store.load('K7QX2');
        });

        h.store.apply({ type: 'SEAT_CLAIMED', matchId: 'K7QX2', seat: 1, playerId: 'p2', seatToken: 'tok-new' });

        expect(sawTokenAtNotify).toEqual({ seat: 1, playerId: 'p2', seatToken: 'tok-new' });
    });
});

describe('claimSeat', () => {
    it('sends CLAIM_SEAT carrying the nickname', () => {
        const h = harness();

        const sent = h.store.claimSeat('Ana');

        expect(sent).toBe(true);
        expect(h.sent).toEqual([{ type: 'CLAIM_SEAT', matchId: 'K7QX2', nickname: 'Ana' }]);
    });

    it('persists the nickname the player claimed with, so a reconnect resumes under it', () => {
        const h = harness();
        h.store.claimSeat('Ana');

        h.store.apply({ type: 'SEAT_CLAIMED', matchId: 'K7QX2', seat: 1, playerId: 'p2', seatToken: 'tok-new' });

        expect(h.tokens.held.get('K7QX2')).toEqual({
            seat: 1,
            playerId: 'p2',
            seatToken: 'tok-new',
            nickname: 'Ana'
        });
    });

    it('refuses when this browser already holds a seat', () => {
        const h = harness({}, recordingTokens({ K7QX2: SEAT }));
        expect(h.store.claimSeat('Mallory')).toBe(false);
        expect(h.sent).toEqual([]);
    });

    it('refuses when there is no match to sit in', () => {
        const h = harness({ matchId: null });
        expect(h.store.claimSeat('Ana')).toBe(false);
        expect(h.sent).toEqual([]);
    });

    it('does not remember a nickname the socket refused to send', () => {
        const h = harness({ send: () => false });

        expect(h.store.claimSeat('Ana')).toBe(false);
        h.store.apply({ type: 'SEAT_CLAIMED', matchId: 'K7QX2', seat: 1, playerId: 'p2', seatToken: 'tok-new' });

        expect(h.tokens.held.get('K7QX2')?.nickname).toBeUndefined();
    });
});

describe('LOBBY_UPDATE', () => {
    // Typed rather than `as const`: the protocol declares `seats` mutable, and a
    // const assertion would make the literal readonly and unassignable.
    const occupied: Extract<ServerMessage, { type: 'LOBBY_UPDATE' }> = {
        type: 'LOBBY_UPDATE',
        matchId: 'K7QX2',
        hostSeat: 'p1',
        canStart: true,
        seats: [
            { seat: 0, playerId: 'p1', nickname: 'Ana', status: 'occupied' },
            { seat: 1, playerId: 'p2', nickname: 'Bayta', status: 'occupied' }
        ]
    };

    it('stores the lobby snapshot', () => {
        const h = harness();
        h.store.apply(occupied);
        expect(h.store.getState().lobby).toEqual({
            matchId: 'K7QX2',
            hostSeat: 'p1',
            canStart: true,
            seats: occupied.seats
        });
    });

    it('replaces the snapshot wholesale — a seat that empties is reflected, never merged', () => {
        const h = harness();
        h.store.apply(occupied);

        h.store.apply({
            type: 'LOBBY_UPDATE',
            matchId: 'K7QX2',
            hostSeat: 'p1',
            canStart: false,
            seats: [
                { seat: 0, playerId: 'p1', nickname: 'Ana', status: 'occupied' },
                { seat: 1, playerId: null, nickname: null, status: 'open' }
            ]
        });

        expect(h.store.getState().lobby?.seats[1]).toEqual({ seat: 1, playerId: null, nickname: null, status: 'open' });
        expect(h.store.getState().lobby?.canStart).toBe(false);
    });
});

describe('MATCH_STARTED', () => {
    it('does not move to the table on its own — the per-seat view arrives separately', () => {
        const h = harness();
        h.store.apply({ type: 'MATCH_STARTED', matchId: 'K7QX2' });
        expect(h.store.getState().screen).not.toBe('table');
    });

    it('leaves the state object untouched, so no subscriber re-renders for a broadcast it cannot use', () => {
        const h = harness();
        const before = h.store.getState();

        h.store.apply({ type: 'MATCH_STARTED', matchId: 'K7QX2' });

        expect(h.store.getState()).toBe(before);
        expect(h.seen).toEqual([]);
    });
});

describe('STATE_UPDATE', () => {
    it('moves to the table and stamps receipt from the injected clock', () => {
        const h = harness();
        h.store.apply(makeStateUpdate());

        const table = h.store.getState().table;
        expect(h.store.getState().screen).toBe('table');
        expect(table?.serverTime).toBe(1_000_000);
        expect(table?.receivedAt).toBe(1_234_567);
    });

    it('carries the transport fields beside the view', () => {
        const h = harness();
        h.store.apply(
            makeStateUpdate({ phase: 'round_over', paused: true, missingSeats: ['p2'], revealDeadline: 1_005_000 })
        );

        const table = h.store.getState().table;
        expect(table?.phase).toBe('round_over');
        expect(table?.paused).toBe(true);
        expect(table?.missingSeats).toEqual(['p2']);
        expect(table?.revealDeadline).toBe(1_005_000);
    });

    it('replaces the snapshot rather than merging it', () => {
        const h = harness();
        h.store.apply(makeStateUpdate({ missingSeats: ['p2'] }));
        h.store.apply(makeStateUpdate());
        expect(h.store.getState().table?.missingSeats).toEqual([]);
    });

    it('clears a pending play — the server has spoken', () => {
        const h = harness();
        withPendingPlay(h);
        expect(h.store.getState().pendingPlay).not.toBeNull();

        h.store.apply(makeStateUpdate({ serverTime: 1_000_100 }));

        expect(h.store.getState().pendingPlay).toBeNull();
    });

    it('records the ending it carries, so a client that misses MATCH_ENDED still knows', () => {
        const h = harness();
        h.store.apply(
            makeStateUpdate({
                phase: 'ended',
                endReason: 'won',
                winnerSeat: 'p2',
                view: makeView({ matchWinnerId: 'p2' })
            })
        );

        expect(h.store.getState().ended).toEqual({ reason: 'won', winnerSeat: 'p2' });
    });
});

describe('ERROR', () => {
    it('clears the pending play when the refId matches, and says why', () => {
        const h = harness();
        withPendingPlay(h);
        const pending = h.store.getState().pendingPlay!;

        h.store.apply({ type: 'ERROR', code: 'TARGET_NOT_LEGAL', refId: pending.clientMsgId });

        expect(h.store.getState().pendingPlay).toBeNull();
        expect(h.store.getState().notices).toEqual([{ id: 'id-2', code: 'TARGET_NOT_LEGAL' }]);
    });

    it('leaves the pending play alone when the refId belongs to some other frame', () => {
        const h = harness();
        withPendingPlay(h);

        h.store.apply({ type: 'ERROR', code: 'RATE_LIMITED', refId: 'someone-elses-id' });

        expect(h.store.getState().pendingPlay).not.toBeNull();
    });

    it('leaves the pending play alone when the error carries no refId at all', () => {
        const h = harness();
        withPendingPlay(h);

        h.store.apply({ type: 'ERROR', code: 'RATE_LIMITED' });

        expect(h.store.getState().pendingPlay).not.toBeNull();
    });

    it.each(['ROOM_NOT_FOUND', 'ROOM_FULL', 'MATCH_OVER'] as const)(
        'routes %s to the fatal screen, because it arrives as ERROR and the socket stays open',
        code => {
            // FATAL carries only BAD_TOKEN and SEAT_TAKEN (room.ts:344,364). Every
            // other dead end UIX §5 designs full-screen copy for is an ERROR, and a
            // toast would leave the player on the join screen forever.
            const h = harness();
            h.store.apply({ type: 'ERROR', code });

            expect(h.store.getState().screen).toBe('fatal');
            expect(h.store.getState().fatal).toBe(code);
            expect(h.store.getState().notices).toEqual([]); // the screen carries the copy; a toast would double-report
        }
    );

    it('leaves a seated player at the table when MATCH_OVER answers a late play', () => {
        // Same code, different situation: someone who is already watching the
        // match-over overlay has somewhere to be, so this is a toast, not a wall.
        const h = harness();
        h.store.apply(makeStateUpdate({ phase: 'ended', endReason: 'won', winnerSeat: 'p2' }));

        h.store.apply({ type: 'ERROR', code: 'MATCH_OVER' });

        expect(h.store.getState().screen).toBe('table');
        expect(h.store.getState().fatal).toBeNull();
        expect(h.store.getState().notices).toHaveLength(1);
    });

    it('is never fatal, RATE_LIMITED included', () => {
        const h = harness();
        h.store.apply({ type: 'ERROR', code: 'RATE_LIMITED' });

        expect(h.store.getState().fatal).toBeNull();
        expect(h.store.getState().screen).not.toBe('fatal');
        expect(h.store.getState().notices).toHaveLength(1);
    });

    it('keeps every notice until it is dismissed', () => {
        const h = harness();
        h.store.apply({ type: 'ERROR', code: 'RATE_LIMITED' });
        h.store.apply({ type: 'ERROR', code: 'NOT_YOUR_TURN' });

        expect(h.store.getState().notices.map(n => n.code)).toEqual(['RATE_LIMITED', 'NOT_YOUR_TURN']);
    });
});

describe('FATAL', () => {
    it('drops the stored token exactly once on BAD_TOKEN and retries as a fresh join', () => {
        const tokens = recordingTokens({ K7QX2: SEAT });
        const h = harness({}, tokens);

        h.store.apply({ type: 'FATAL', code: 'BAD_TOKEN' });

        expect(tokens.clears).toEqual(['K7QX2']);
        expect(h.store.getState().screen).toBe('joining');
        expect(h.store.getState().fatal).toBeNull(); // UIX §5: a bad token is a retry, not a wall
        expect(h.store.getState().seat).toBeNull();
    });

    it('goes fatal on SEAT_TAKEN and keeps the token, which "Take over here" needs', () => {
        const tokens = recordingTokens({ K7QX2: SEAT });
        const h = harness({}, tokens);

        h.store.apply({ type: 'FATAL', code: 'SEAT_TAKEN' });

        expect(h.store.getState().screen).toBe('fatal');
        expect(h.store.getState().fatal).toBe('SEAT_TAKEN');
        expect(tokens.clears).toEqual([]);
        expect(h.store.getState().seat).toEqual({ seat: 0, playerId: 'p1' });
    });

    it('goes fatal for any other code, defensively', () => {
        // The server only ever sends FATAL with BAD_TOKEN or SEAT_TAKEN
        // (room.ts:344,364), so these are unreachable today. They are asserted
        // anyway: a FATAL the client does not recognise must still stop the
        // player rather than be silently dropped, and the ERROR tests above are
        // what cover the codes actually in use.
        for (const code of ['ROOM_NOT_FOUND', 'ROOM_FULL', 'INTERNAL'] as const) {
            const h = harness();
            h.store.apply({ type: 'FATAL', code });
            expect(h.store.getState().fatal, code).toBe(code);
            expect(h.store.getState().screen, code).toBe('fatal');
        }
    });

    it('ignores everything that follows, because the server has closed the socket', () => {
        const h = harness();
        h.store.apply({ type: 'FATAL', code: 'ROOM_FULL' });

        h.store.apply(makeStateUpdate());

        expect(h.store.getState().screen).toBe('fatal');
        expect(h.store.getState().table).toBeNull();
    });
});

describe('MATCH_ENDED', () => {
    it('records the reason and winner without leaving the table', () => {
        const h = harness();
        h.store.apply(makeStateUpdate());

        h.store.apply({ type: 'MATCH_ENDED', matchId: 'K7QX2', reason: 'won', winnerSeat: 'p1' });

        expect(h.store.getState().ended).toEqual({ reason: 'won', winnerSeat: 'p1' });
        expect(h.store.getState().screen).toBe('table');
    });

    it('accepts a later STATE_UPDATE — the server pushes state around the ending, not only before it', () => {
        const h = harness();
        h.store.apply({ type: 'MATCH_ENDED', matchId: 'K7QX2', reason: 'abandoned' });

        h.store.apply(makeStateUpdate({ phase: 'ended' }));

        expect(h.store.getState().table?.phase).toBe('ended');
        expect(h.store.getState().ended).toEqual({ reason: 'abandoned' });
    });
});

describe('playCard', () => {
    it('mints a clientMsgId, goes pending, and emits exactly one PLAY_CARD', () => {
        const h = harness();
        h.store.apply(makeStateUpdate());

        const accepted = h.store.playCard({ cardInstanceId: 'informant#1', target: 'p2', guess: 5 });

        expect(accepted).toBe(true);
        expect(h.sent).toEqual([
            {
                type: 'PLAY_CARD',
                matchId: 'K7QX2',
                cardInstanceId: 'informant#1',
                target: 'p2',
                guess: 5,
                clientMsgId: 'id-1'
            }
        ]);
        expect(h.store.getState().pendingPlay).toEqual({ clientMsgId: 'id-1', cardInstanceId: 'informant#1' });
    });

    it('omits target and guess for a card that takes neither', () => {
        const h = harness();
        h.store.apply(makeStateUpdate());

        h.store.playCard({ cardInstanceId: 'shielded-mind#1' });

        expect(h.sent).toEqual([
            { type: 'PLAY_CARD', matchId: 'K7QX2', cardInstanceId: 'shielded-mind#1', clientMsgId: 'id-1' }
        ]);
    });

    it('emits nothing on a second call while one play is still pending', () => {
        const h = harness();
        withPendingPlay(h);

        const accepted = h.store.playCard({ cardInstanceId: 'mule#1' });

        expect(accepted).toBe(false);
        expect(h.sent).toHaveLength(1);
        expect(h.store.getState().pendingPlay?.cardInstanceId).toBe('informant#1');
    });

    it('does not go pending when the socket refuses the frame', () => {
        // No optimism, in both directions: a card that never left cannot shimmer
        // waiting for a reply that will never come.
        const h = harness({ send: () => false });
        h.store.apply(makeStateUpdate());

        const accepted = h.store.playCard({ cardInstanceId: 'informant#1', target: 'p2', guess: 5 });

        expect(accepted).toBe(false);
        expect(h.store.getState().pendingPlay).toBeNull();
    });

    it('refuses to play with no match to play in', () => {
        const h = harness({ matchId: null });
        expect(h.store.playCard({ cardInstanceId: 'informant#1' })).toBe(false);
        expect(h.sent).toEqual([]);
    });

    it('releases the card when the caller cancels', () => {
        const h = harness();
        withPendingPlay(h);

        h.store.cancelPending();

        expect(h.store.getState().pendingPlay).toBeNull();
    });
});

describe('notices and connection', () => {
    it('dismisses exactly one notice and leaves the others', () => {
        const h = harness();
        h.store.apply({ type: 'ERROR', code: 'RATE_LIMITED' });
        h.store.apply({ type: 'ERROR', code: 'NOT_YOUR_TURN' });

        h.store.dismissNotice('id-1');

        expect(h.store.getState().notices.map(n => n.code)).toEqual(['NOT_YOUR_TURN']);
    });

    it('records the connection status the socket reports', () => {
        const h = harness();
        h.store.setConnection('reconnecting');
        expect(h.store.getState().connection).toBe('reconnecting');
    });
});

describe('the whole arc', () => {
    it('walks host to lobby to match to round over to match over on one scripted sequence', () => {
        // Stage 3's stated success criterion. The per-message tests above each
        // prove one transition; this proves they compose, which is the property
        // an actual match depends on and no single-message test can show.
        const h = harness();

        expect(h.store.getState().screen).toBe('joining');

        h.store.setConnection('open');
        h.store.apply({ type: 'SEAT_CLAIMED', matchId: 'K7QX2', seat: 0, playerId: 'p1', seatToken: 'tok-abc' });
        expect(h.store.getState().screen).toBe('lobby');

        h.store.apply({
            type: 'LOBBY_UPDATE',
            matchId: 'K7QX2',
            hostSeat: 'p1',
            canStart: true,
            seats: [
                { seat: 0, playerId: 'p1', nickname: 'Ana', status: 'occupied' },
                { seat: 1, playerId: 'p2', nickname: 'Bayta', status: 'occupied' }
            ]
        });
        expect(h.store.getState().lobby?.canStart).toBe(true);

        h.store.apply({ type: 'MATCH_STARTED', matchId: 'K7QX2' });
        expect(h.store.getState().screen).toBe('lobby'); // still — the view has not arrived

        h.store.apply(makeStateUpdate());
        expect(h.store.getState().screen).toBe('table');

        h.store.playCard({ cardInstanceId: 'informant#1', target: 'p2', guess: 5 });
        expect(h.store.getState().pendingPlay).not.toBeNull();

        h.store.apply(
            makeStateUpdate({
                phase: 'round_over',
                revealDeadline: 1_005_000,
                view: makeView({ roundResult: { reason: 'last-survivor', winnerIds: ['p1'] } })
            })
        );
        expect(h.store.getState().pendingPlay).toBeNull(); // the server resolved it
        expect(h.store.getState().table?.phase).toBe('round_over');

        h.store.apply(makeStateUpdate({ phase: 'ended', endReason: 'won', winnerSeat: 'p1' }));
        h.store.apply({ type: 'MATCH_ENDED', matchId: 'K7QX2', reason: 'won', winnerSeat: 'p1' });

        expect(h.store.getState().ended).toEqual({ reason: 'won', winnerSeat: 'p1' });
        expect(h.store.getState().screen).toBe('table'); // UIX §9.2 overlays the table, never replaces it
        expect(h.store.getState().fatal).toBeNull();
        expect(h.store.getState().notices).toEqual([]);
    });
});

describe('subscribe', () => {
    it('notifies once per state-changing apply', () => {
        const h = harness();
        h.store.apply(makeStateUpdate());
        expect(h.seen).toHaveLength(1);
    });

    it('hands over a fresh object every time, so a subscriber can diff old against new', () => {
        const h = harness();
        h.store.apply(makeStateUpdate());
        h.store.apply(makeStateUpdate({ serverTime: 1_000_100 }));

        expect(h.seen).toHaveLength(2);
        expect(h.seen[0]).not.toBe(h.seen[1]);
        expect(h.seen[0].table?.serverTime).toBe(1_000_000); // the first object was never mutated
    });

    it('stops notifying once unsubscribed', () => {
        const h = harness();
        const seen: ClientState[] = [];
        const unsubscribe = h.store.subscribe(state => seen.push(state));

        h.store.apply(makeStateUpdate());
        unsubscribe();
        h.store.apply(makeStateUpdate({ serverTime: 1_000_100 }));

        expect(seen).toHaveLength(1);
    });

    it('shows every subscriber every state, in order, even when one calls back into the store', () => {
        // A listener that reacts by calling an intent is ordinary Stage 6 code.
        // Without a queue the reentrant commit runs inside the outer loop, and
        // later listeners skip the state the earlier ones already saw.
        const h = harness();
        h.store.apply(makeStateUpdate());
        h.store.playCard({ cardInstanceId: 'informant#1' });

        const first: Array<string | null> = [];
        const second: Array<string | null> = [];
        h.store.subscribe(state => {
            first.push(state.pendingPlay?.clientMsgId ?? null);
            if (state.pendingPlay !== null) h.store.cancelPending();
        });
        h.store.subscribe(state => second.push(state.pendingPlay?.clientMsgId ?? null));

        h.store.apply({ type: 'ERROR', code: 'RATE_LIMITED' }); // a notice; pendingPlay survives

        expect(first).toEqual(['id-1', null]);
        expect(second).toEqual(['id-1', null]); // the same two states, not one of them twice
    });

    it('notifies every subscriber', () => {
        const h = harness();
        let second = 0;
        h.store.subscribe(() => second++);

        h.store.apply(makeStateUpdate());

        expect(h.seen).toHaveLength(1);
        expect(second).toBe(1);
    });
});
