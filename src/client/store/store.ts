/**
 * The client store (UIX §2.1).
 *
 * One object holds the connection lifecycle and the latest snapshot the server
 * sent. It never derives a game rule: turn order, legality, timing, and
 * elimination arrive already decided, and interface rule 1 — render the view,
 * decide nothing — is enforced here by there being no rule code to enforce.
 *
 * State is replaced, never mutated. Subscribers therefore receive a new object
 * on every change and can diff the old one against it, which is what UIX §2.1
 * means by "animation derives from diffing".
 */

import type { CardInstanceId, GuessValue, PlayerId } from '../../game/engine';
import type { ClientMessage, ErrorCode, ServerMessage } from '../../server/protocol';
import type { SeatTokenStore } from './seatTokenStore';
import type { ClientState, ConnectionStatus, Notice, TableSnapshot } from './types';

/**
 * The codes that end a player's journey rather than interrupting it (UIX §5).
 *
 * They arrive as `ERROR`, not `FATAL`, and the socket stays open. `FATAL` is
 * only ever `BAD_TOKEN` or `SEAT_TAKEN` (`room.ts:344,364`); every other dead
 * end the design writes full-screen copy for comes through the ordinary error
 * channel, so routing on the frame type alone would leave a player holding a
 * stale invite link staring at the join screen behind a toast.
 */
const DEAD_END_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['ROOM_NOT_FOUND', 'ROOM_FULL', 'MATCH_OVER']);

export interface StoreDeps {
    /** The match this browser tab is in, fixed for the store's lifetime. `null` on the menu route. */
    readonly matchId: string | null;
    readonly tokens: SeatTokenStore;
    /** Returns false when the frame did not go out, so a refused play never goes pending. */
    readonly send: (msg: ClientMessage) => boolean;
    /** Wall clock, used only to stamp receipt so countdowns can age the server's clock. */
    readonly now: () => number;
    /** Unique per call. Feeds both `clientMsgId` and notice ids; the protocol caps ids at 64 characters. */
    readonly mintId: () => string;
}

export interface PlayIntent {
    readonly cardInstanceId: CardInstanceId;
    readonly target?: PlayerId;
    readonly guess?: GuessValue;
}

export interface Store {
    getState(): ClientState;
    subscribe(listener: (state: ClientState) => void): () => void;
    apply(msg: ServerMessage): void;
    /** True when a PLAY_CARD frame actually left. */
    playCard(intent: PlayIntent): boolean;
    cancelPending(): void;
    dismissNotice(id: string): void;
    setConnection(status: ConnectionStatus): void;
}

function initialState(deps: StoreDeps): ClientState {
    // A stored token IS a held seat. Reading it here is what lets the join screen
    // tell "resuming" from "arriving" without asking storage a second question.
    const stored = deps.matchId === null ? null : deps.tokens.load(deps.matchId);

    return {
        screen: deps.matchId === null ? 'menu' : 'joining',
        connection: 'connecting',
        matchId: deps.matchId,
        seat: stored === null ? null : { seat: stored.seat, playerId: stored.playerId },
        lobby: null,
        table: null,
        ended: null,
        pendingPlay: null,
        fatal: null,
        notices: []
    };
}

export function createStore(deps: StoreDeps): Store {
    let state = initialState(deps);
    let listeners: ReadonlyArray<(state: ClientState) => void> = [];
    /** States awaiting publication. Non-empty only while a reentrant commit is in flight. */
    const unpublished: ClientState[] = [];
    let publishing = false;

    /**
     * Swap in a new state and publish it. A no-op change publishes nothing.
     *
     * Publication is queued rather than recursive. A listener calling back into
     * the store — `cancelPending()` on seeing a stale play, say — is ordinary
     * caller code, and running its commit inside this loop would let later
     * listeners skip the state earlier ones already saw. Queueing keeps the
     * guarantee simple: every subscriber sees every state, in the same order.
     */
    function commit(next: ClientState): void {
        if (next === state) return;
        state = next;
        unpublished.push(next);

        if (publishing) return; // the loop below will reach it
        publishing = true;
        try {
            while (unpublished.length > 0) {
                const published = unpublished.shift() as ClientState;
                // `listeners` is replaced, never mutated, so this iterates a
                // stable snapshot: unsubscribing mid-broadcast is safe.
                for (const listener of listeners) listener(published);
            }
        } finally {
            publishing = false;
        }
    }

    function withNotice(base: ClientState, code: Notice['code']): ClientState {
        return { ...base, notices: [...base.notices, { id: deps.mintId(), code }] };
    }

    function tableFrom(msg: Extract<ServerMessage, { type: 'STATE_UPDATE' }>): TableSnapshot {
        return {
            view: msg.view,
            nicknames: msg.nicknames,
            phase: msg.phase,
            paused: msg.paused,
            missingSeats: msg.missingSeats,
            ...(msg.revealDeadline !== undefined ? { revealDeadline: msg.revealDeadline } : {}),
            serverTime: msg.serverTime,
            receivedAt: deps.now()
        };
    }

    /**
     * The one place a message becomes state. Returns the *same* object when a
     * message changes nothing, which is how `commit` knows not to wake anybody.
     */
    function next(msg: ServerMessage): ClientState {
        switch (msg.type) {
            case 'SEAT_CLAIMED': {
                // Persist before publishing, mirroring the server's own ordering
                // discipline (Design §9): a subscriber that reacts by reading
                // storage must not race the write that makes the seat survivable.
                deps.tokens.save(msg.matchId, { seat: msg.seat, playerId: msg.playerId, seatToken: msg.seatToken });
                return { ...state, screen: 'lobby', seat: { seat: msg.seat, playerId: msg.playerId } };
            }

            case 'LOBBY_UPDATE':
                return {
                    ...state,
                    screen: 'lobby',
                    lobby: { matchId: msg.matchId, hostSeat: msg.hostSeat, canStart: msg.canStart, seats: msg.seats }
                };

            // Deliberately inert. MATCH_STARTED is a broadcast; the per-seat view
            // arrives separately, and moving to the table before it lands would
            // show an empty one.
            case 'MATCH_STARTED':
                return state;

            case 'STATE_UPDATE':
                return {
                    ...state,
                    screen: 'table',
                    table: tableFrom(msg),
                    pendingPlay: null, // the server has spoken; nothing is in flight
                    ended:
                        msg.endReason !== undefined
                            ? {
                                  reason: msg.endReason,
                                  ...(msg.winnerSeat !== undefined ? { winnerSeat: msg.winnerSeat } : {})
                              }
                            : state.ended
                };

            case 'MATCH_ENDED':
                return {
                    ...state,
                    ended: {
                        reason: msg.reason,
                        ...(msg.winnerSeat !== undefined ? { winnerSeat: msg.winnerSeat } : {})
                    }
                };

            case 'ERROR': {
                // A dead end only counts as one for a player with nowhere to
                // fall back to. The same MATCH_OVER answering a late play from
                // someone already watching the match-over overlay is a toast.
                if (DEAD_END_CODES.has(msg.code) && state.table === null) {
                    return { ...state, screen: 'fatal', fatal: msg.code };
                }

                const answersPending =
                    msg.refId !== undefined && state.pendingPlay !== null && msg.refId === state.pendingPlay.clientMsgId;
                return withNotice(answersPending ? { ...state, pendingPlay: null } : state, msg.code);
            }

            case 'FATAL':
                // UIX §5: a bad token is a retry, not a wall. Drop it and rejoin
                // as a stranger — the server makes "wrong link" and "expired room"
                // indistinguishable on purpose, so the retry picks the message.
                if (msg.code === 'BAD_TOKEN') {
                    if (state.matchId !== null) deps.tokens.clear(state.matchId);
                    return { ...state, screen: 'joining', seat: null };
                }
                // Every other code keeps the token: SEAT_TAKEN's "Take over here"
                // is a reconnect, and it has nothing to reconnect with otherwise.
                return { ...state, screen: 'fatal', fatal: msg.code };

            case 'PONG':
                return state;
        }
    }

    return {
        getState: () => state,

        subscribe(listener) {
            listeners = [...listeners, listener];
            return () => {
                listeners = listeners.filter(entry => entry !== listener);
            };
        },

        apply(msg) {
            // FATAL is terminal: the server sends it and closes the socket, so
            // anything arriving afterwards is stale by definition.
            if (state.fatal !== null) return;
            commit(next(msg));
        },

        playCard(intent) {
            if (state.matchId === null) return false;
            if (state.pendingPlay !== null) return false; // one card at a time; input is locked while it flies

            const clientMsgId = deps.mintId();
            const sent = deps.send({
                type: 'PLAY_CARD',
                matchId: state.matchId,
                cardInstanceId: intent.cardInstanceId,
                ...(intent.target !== undefined ? { target: intent.target } : {}),
                ...(intent.guess !== undefined ? { guess: intent.guess } : {}),
                clientMsgId
            });

            // A card that never left cannot shimmer waiting for a reply that will
            // never come. No optimism, in both directions (UIX §7.3).
            if (!sent) return false;

            commit({ ...state, pendingPlay: { clientMsgId, cardInstanceId: intent.cardInstanceId } });
            return true;
        },

        cancelPending() {
            if (state.pendingPlay === null) return;
            commit({ ...state, pendingPlay: null });
        },

        dismissNotice(id) {
            const remaining = state.notices.filter(notice => notice.id !== id);
            if (remaining.length === state.notices.length) return;
            commit({ ...state, notices: remaining });
        },

        setConnection(status) {
            if (state.connection === status) return;
            commit({ ...state, connection: status });
        }
    };
}
