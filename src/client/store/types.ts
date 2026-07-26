/**
 * The client's own state vocabulary (UIX §2.1).
 *
 * Deliberately separate from the wire types in `../../server/protocol`: those
 * describe what crosses the socket, these describe what the client is currently
 * showing. Keeping them apart is what lets the connection lifecycle change
 * without touching the protocol.
 */

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
