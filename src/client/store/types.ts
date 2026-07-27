/**
 * The client's own state vocabulary (UIX §2.1).
 *
 * Deliberately separate from the wire types in `../../server/protocol`: those
 * describe what crosses the socket, these describe what the client is currently
 * showing. Keeping them apart is what lets the connection lifecycle change
 * without touching the protocol.
 */

import type { CardInstanceId, PlayerId, RedactedView } from '../../game/engine';
import type { ErrorCode, SeatStatus } from '../../server/protocol';

/**
 * Which surface the player is looking at.
 *
 * `joining` covers both a fresh nickname prompt and the moment after a bad token
 * is dropped — UIX §5 makes a `BAD_TOKEN` retry indistinguishable from a first
 * visit on purpose, so it is one screen, not two.
 */
export type Screen = 'menu' | 'joining' | 'lobby' | 'table' | 'fatal';

/**
 * What the connection dot shows (UIX §5).
 *
 * `reconnecting` is the amber state: the socket is gone but the client is still
 * trying. `closed` is terminal and only the caller can cause it.
 */
export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/**
 * One toast (UIX §5). A code, never a sentence: words live in `src/client/content`,
 * and a store that held copy would have to be edited to change a wording.
 */
export interface Notice {
    readonly id: string;
    readonly code: ErrorCode;
}

/** The latest `LOBBY_UPDATE`, minus its `type` tag. */
export interface LobbySnapshot {
    readonly matchId: string;
    readonly hostSeat: PlayerId;
    readonly canStart: boolean;
    readonly seats: ReadonlyArray<{
        readonly seat: number;
        readonly playerId: PlayerId | null;
        readonly nickname: string | null;
        readonly status: SeatStatus;
    }>;
}

/**
 * The latest `STATE_UPDATE`: the engine's view plus the transport fields that
 * travel beside it (UIX §2.1). Held whole and replaced whole — merging two
 * snapshots would invent a table state the server never sent.
 */
export interface TableSnapshot {
    readonly view: RedactedView;
    readonly nicknames: Readonly<Record<PlayerId, string>>;
    readonly phase: 'active' | 'round_over' | 'ended';
    readonly paused: boolean;
    readonly missingSeats: readonly PlayerId[];
    readonly revealDeadline?: number;
    readonly serverTime: number;
    /**
     * Local receipt time, used only to age the server clock for countdowns.
     * Never a source of truth: interface rule 5 gives every clock to the server.
     */
    readonly receivedAt: number;
}

export interface ClientState {
    readonly screen: Screen;
    readonly connection: ConnectionStatus;
    readonly matchId: string | null;
    readonly seat: { readonly seat: number; readonly playerId: PlayerId } | null;
    readonly lobby: LobbySnapshot | null;
    readonly table: TableSnapshot | null;
    readonly ended: { readonly reason: 'won' | 'abandoned'; readonly winnerSeat?: PlayerId } | null;
    /** In-flight PLAY_CARD; cleared by the next STATE_UPDATE or a matching ERROR. */
    readonly pendingPlay: { readonly clientMsgId: string; readonly cardInstanceId: CardInstanceId } | null;
    readonly fatal: ErrorCode | null;
    readonly notices: readonly Notice[];
}
