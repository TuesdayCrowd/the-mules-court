/**
 * Shared types for the headless game engine.
 *
 * Types only — no runtime code lives here.
 *
 * Two invariants govern this file:
 *  1. Every type reachable from MatchState is plain JSON. No functions, no class
 *     instances, no closures. Behaviour lives in the static effect registry.
 *  2. RedactedView is declared standalone, never as Omit<MatchState, ...>. It has
 *     no field capable of holding a hand, a deck, a set-aside card, the seed, or
 *     the RNG, so leaking hidden state is a compile error rather than a filtering
 *     bug a reviewer has to notice.
 */

export type PlayerId = string;

export type CardTypeId =
    | 'informant'
    | 'han-pritcher'
    | 'bail-channis'
    | 'ebling-mis'
    | 'magnifico'
    | 'shielded-mind'
    | 'bayta-darell'
    | 'toran-darell'
    | 'mayor-indbur'
    | 'first-speaker'
    | 'mule';

/** A single physical card, e.g. "informant#3". The format is public; only an instance's location is secret. */
export type CardInstanceId = `${CardTypeId}#${number}`;

export type EffectType =
    | 'GUARD'
    | 'PRIEST'
    | 'BARON'
    | 'HANDMAID'
    | 'PRINCE'
    | 'KING'
    | 'COUNTESS'
    | 'PRINCESS';

export type CardValue = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

// ---------------------------------------------------------------- static data

export interface CardDef {
    readonly id: CardTypeId;
    readonly displayName: string;
    readonly value: CardValue;
    readonly count: number;
    /** Directory under public/assets/ holding portrait_0..3.png */
    readonly assetSlug: string;
    /** The only link from card identity to card behaviour. */
    readonly effectType: EffectType;
}

export interface EffectDef {
    readonly effectType: EffectType;
    readonly requiresTarget: boolean;
    /** True for PRINCE alone. The exemption applies to the actor only, never to an opponent. */
    readonly canTargetSelf: boolean;
    /** True for GUARD alone. */
    readonly requiresGuess: boolean;
    /** True where no targeted effect resolves: HANDMAID, COUNTESS, PRINCESS. */
    readonly isPassive: boolean;
    /** True for PRINCESS alone. */
    readonly eliminatesOnDiscard: boolean;
    /** Non-empty for COUNTESS alone: ['KING', 'PRINCE']. */
    readonly forcedPlayTriggers: readonly EffectType[];
    readonly resolve: EffectResolver;
}

/** Resolvers mutate a working copy of the round produced by reduce(). */
export type EffectResolver = (context: ResolveContext) => void;

export interface ResolveContext {
    readonly round: RoundState;
    readonly actorId: PlayerId;
    readonly targetId?: PlayerId;
    readonly guess?: CardTypeId;
    readonly playedCardId: CardTypeId;
}

// ------------------------------------------------------------------- rng

/** mulberry32 internal state. Server-only; absent from RedactedView. */
export interface RngState {
    readonly s: number;
}

// ----------------------------------------------------- derived private knowledge

/**
 * A card one player has learned about another. Bound to the immutable
 * (viewerId, subjectId, cardInstanceId) triple, never to a hand position, so a
 * traded or discarded card silently stops resolving instead of being
 * misreported as knowledge about its replacement.
 */
export interface PeekRecord {
    readonly id: string;
    readonly kind: 'priest' | 'baron';
    readonly viewerId: PlayerId;
    readonly subjectId: PlayerId;
    readonly cardInstanceId: CardInstanceId;
    readonly cardTypeId: CardTypeId;
    readonly roundNumber: number;
    readonly createdAtTurn: number;
}

// --------------------------------------------------------------- public log

/** Safe by construction: never names a living player's held card. */
export type PublicLogEntry =
    | { readonly kind: 'PLAY'; readonly turn: number; readonly actorId: PlayerId; readonly cardId: CardTypeId }
    | {
          readonly kind: 'GUESS';
          readonly turn: number;
          readonly actorId: PlayerId;
          readonly targetId: PlayerId;
          readonly guessedCardId: CardTypeId;
          readonly hit: boolean;
      }
    | {
          readonly kind: 'COMPARE';
          readonly turn: number;
          readonly actorId: PlayerId;
          readonly targetId: PlayerId;
          readonly result: 'tie' | 'actor-eliminated' | 'target-eliminated';
      }
    | { readonly kind: 'PROTECTED'; readonly turn: number; readonly actorId: PlayerId }
    | { readonly kind: 'TRADED'; readonly turn: number; readonly actorId: PlayerId; readonly targetId: PlayerId }
    | {
          readonly kind: 'REDREW';
          readonly turn: number;
          readonly actorId: PlayerId;
          readonly targetId: PlayerId;
          readonly drewFrom: 'deck' | 'set-aside' | 'none';
      }
    | { readonly kind: 'FIZZLE'; readonly turn: number; readonly actorId: PlayerId; readonly cardId: CardTypeId }
    | {
          readonly kind: 'ELIMINATED';
          readonly turn: number;
          readonly playerId: PlayerId;
          readonly cause: 'guard' | 'baron' | 'mule-voluntary' | 'mule-forced';
      }
    | {
          readonly kind: 'ROUND_END';
          readonly turn: number;
          readonly reason: RoundEndReason;
          readonly winners: readonly PlayerId[];
      };

// ------------------------------------------------------------------ round

export interface DiscardEntry {
    readonly instanceId: CardInstanceId;
    readonly cardId: CardTypeId;
    readonly value: CardValue;
}

export interface RoundPlayerState {
    readonly id: PlayerId;
    /** 0, 1, or 2 cards. Zero only via the 4-player empty-deck Prince fallback. */
    readonly hand: readonly CardInstanceId[];
    /** Public, oldest first. */
    readonly discardPile: readonly DiscardEntry[];
    /** Running sum, maintained incrementally by the shared discard primitives. */
    readonly discardValueTotal: number;
    readonly alive: boolean;
    /** Cleared positionally at the start of this player's own next turn. */
    readonly protected: boolean;
}

export type RoundEndReason = 'last-survivor' | 'deck-out';

export interface RoundResult {
    readonly reason: RoundEndReason;
    /** More than one entry on a shared co-win. */
    readonly winnerIds: readonly PlayerId[];
    /** Populated on deck-out only. null marks the empty-hand edge case. */
    readonly revealedHands?: Readonly<Record<PlayerId, CardTypeId | null>>;
}

export interface RoundState {
    readonly roundNumber: number;
    /** Fixed turn rotation for this round, including players later eliminated. */
    readonly seatOrder: readonly PlayerId[];
    readonly currentPlayerIndex: number;
    /** Monotonic audit trail. Never used for protection-expiry arithmetic. */
    readonly turnNumber: number;
    /** Server-only. Last element is drawn next. */
    readonly deckOrder: readonly CardInstanceId[];
    /** Server-only. 2 cards at 2 players, 1 at 3 players, none at 4. */
    readonly setAsideFaceDown: readonly CardInstanceId[];
    /** Public. Two-player games only. */
    readonly setAsideFaceUp: CardInstanceId | null;
    readonly players: Readonly<Record<PlayerId, RoundPlayerState>>;
    /** Server-only, append-only. Never mutated or deleted mid-round. */
    readonly privateKnowledge: readonly PeekRecord[];
    readonly publicLog: readonly PublicLogEntry[];
    readonly phase: 'awaiting-play' | 'round-over';
    readonly roundResult: RoundResult | null;
}

// ------------------------------------------------------------------ match

export interface MatchPlayer {
    readonly id: PlayerId;
    readonly seat: number;
    readonly tokens: number;
    /** Most recent round this player led. 0 when they never have. Breaks co-win round-start ties. */
    readonly lastStartedRound: number;
}

export type MatchMode = 'normal' | 'sudden-death';

export interface MatchState {
    readonly schemaVersion: 1;
    readonly matchId: string;
    readonly playerCount: 2 | 3 | 4;
    readonly tokensToWin: 7 | 5 | 4;
    readonly players: readonly MatchPlayer[];
    /** Original seed, retained for replay from genesis. */
    readonly seed: string;
    /** Server-only. Threads continuously across rounds; never re-seeded. */
    readonly rng: RngState;
    readonly mode: MatchMode;
    /** Tied leaders playing sudden death. Empty in normal mode. */
    readonly suddenDeathPlayers: readonly PlayerId[];
    readonly round: RoundState;
    readonly matchWinnerId: PlayerId | null;
    /** Canonical replay source alongside seed. */
    readonly actionLog: readonly PlayCardAction[];
}

// ----------------------------------------------------------------- actions

/**
 * The entire client-facing action surface. Love Letter has no chained
 * sub-decisions, so every input an ability needs is known when the card is
 * chosen and a turn resolves in one call.
 */
export interface PlayCardAction {
    readonly type: 'PLAY_CARD';
    readonly playerId: PlayerId;
    /** The exact physical card, which removes duplicate-copy ambiguity. */
    readonly cardInstanceId: CardInstanceId;
    /** Present only when the legal-target set is non-empty. Omitted, never null. */
    readonly target?: PlayerId;
    /** Informant only, and never 'informant'. */
    readonly guess?: CardTypeId;
}

/** A closed union of one variant today. A future action joins it as a new member. */
export type GameAction = PlayCardAction;

export type ValidationError =
    | { readonly code: 'ROUND_NOT_IN_PROGRESS' }
    | { readonly code: 'NOT_YOUR_TURN' }
    | { readonly code: 'CARD_NOT_IN_HAND' }
    | { readonly code: 'FORCED_PLAY_VIOLATION'; readonly requiredCardId: CardTypeId }
    | { readonly code: 'TARGET_REQUIRED' }
    | { readonly code: 'TARGET_NOT_ALLOWED' }
    | {
          readonly code: 'TARGET_NOT_LEGAL';
          readonly reason: 'PROTECTED' | 'ELIMINATED' | 'SELF_NOT_ALLOWED' | 'UNKNOWN_PLAYER';
      }
    | { readonly code: 'GUESS_REQUIRED' }
    | { readonly code: 'GUESS_NOT_ALLOWED' }
    | { readonly code: 'GUESS_CANNOT_BE_INFORMANT' };

export type ValidationResult = { readonly ok: true } | { readonly ok: false; readonly error: ValidationError };

export type ReduceResult =
    | { readonly ok: true; readonly state: MatchState }
    | { readonly ok: false; readonly error: ValidationError };

// ------------------------------------------------------------ redacted view

/**
 * The only shape that may reach a client.
 *
 * Deliberately standalone. No field here can hold deckOrder, setAsideFaceDown,
 * rng, seed, actionLog, privateKnowledge, or another player's hand.
 */
export interface RedactedView {
    readonly matchId: string;
    readonly playerCount: number;
    readonly tokensToWin: number;
    readonly mode: MatchMode;
    readonly players: ReadonlyArray<{
        readonly id: PlayerId;
        readonly seat: number;
        readonly tokens: number;
        readonly alive: boolean;
        readonly protected: boolean;
        readonly discardPile: ReadonlyArray<{ readonly cardId: CardTypeId; readonly value: CardValue }>;
        readonly discardValueTotal: number;
    }>;
    /** An integer, never an array. A padded array would leak deck positions. */
    readonly deckCount: number;
    readonly setAsideFaceUp: CardTypeId | null;
    readonly currentPlayerId: PlayerId;
    readonly turnNumber: number;
    readonly publicLog: readonly PublicLogEntry[];
    readonly own: {
        readonly playerId: PlayerId;
        readonly hand: readonly CardInstanceId[];
        /** Populated only while this viewer holds the turn. */
        readonly legalPlays: readonly CardInstanceId[];
    };
    /** This viewer's still-valid peeks, recomputed live on every call. */
    readonly revealed: ReadonlyArray<{ readonly subjectId: PlayerId; readonly cardTypeId: CardTypeId }>;
    readonly roundResult: RoundResult | null;
    readonly matchWinnerId: PlayerId | null;
}
