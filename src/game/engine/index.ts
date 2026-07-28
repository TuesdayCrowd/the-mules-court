/**
 * The Mule's Court — game engine public API.
 *
 * A headless, server-authoritative, deterministic reducer. No Phaser, no I/O, no
 * ambient randomness: this module runs unchanged in a browser or a plain Node
 * process, which is what lets the authoritative copy live on a server.
 *
 * Typical server loop:
 *
 *     let match = createMatch(playerIds, secretSeed, matchId);
 *     const result = reduce(match, incomingAction);   // validates first
 *     if (result.ok) {
 *         match = result.state;                        // persist SERVER-SIDE only
 *         send(broadcastViews(match, playerIds));      // the only client-facing data
 *     }
 *
 * `reduce` returns the full MatchState, which contains the deck order, the
 * set-aside cards, the RNG and the seed. Never forward it to a client. Every
 * client-facing value must come from `view` or `broadcastViews`.
 */

export { createMatch, dealRound } from './setup';
export { reduce, startNextRound } from './reduce';
export { validateAction } from './validation';
export { view, broadcastViews } from './view';
export { computeLegalPlays, computeLegalTargets } from './legality';
// INFORMANT_VALUE and the value bounds are static rules data, not per-match
// state. The client's quick reference and guess grid both derive from them, and
// the barrel is the only door the client is allowed through.
export { CARD_CATALOG, cardTypeOf, makeCardInstanceId, INFORMANT_VALUE, MIN_CARD_VALUE, MAX_CARD_VALUE } from './cardCatalog';
export { EFFECT_DEFS } from './effectRegistry';

import type { MatchState, PlayerId } from './types';

export function isMatchOver(match: MatchState): boolean {
    return match.matchWinnerId !== null;
}

export function getMatchWinner(match: MatchState): PlayerId | null {
    return match.matchWinnerId;
}

export type {
    MatchState,
    MatchPlayer,
    MatchMode,
    RoundState,
    RoundPlayerState,
    CompletedRound,
    RoundResult,
    RoundEndReason,
    RedactedView,
    PlayerId,
    CardTypeId,
    CardInstanceId,
    CardValue,
    GuessValue,
    EffectType,
    PlayCardAction,
    GameAction,
    ValidationError,
    ValidationResult,
    ReduceResult,
    PeekRecord,
    PublicLogEntry,
    DiscardEntry,
    CardDef,
    EffectDef
} from './types';
