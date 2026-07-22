import type { CardInstanceId, PlayerId, RoundDraft, RoundPlayerState, RoundState } from '../types';

/**
 * Fixture builders for engine tests.
 *
 * These construct a RoundState directly rather than dealing through createMatch,
 * so a test can put an exact card in an exact hand and assert one rule.
 */

export function makePlayer(id: PlayerId, overrides: Partial<RoundPlayerState> = {}): RoundPlayerState {
    return {
        id,
        hand: [],
        discardPile: [],
        discardValueTotal: 0,
        alive: true,
        protected: false,
        ...overrides
    };
}

export interface MakeRoundOptions {
    readonly players?: Readonly<Record<PlayerId, RoundPlayerState>>;
    readonly seatOrder?: readonly PlayerId[];
    readonly currentPlayerIndex?: number;
    readonly deckOrder?: readonly CardInstanceId[];
    readonly setAsideFaceDown?: readonly CardInstanceId[];
    readonly setAsideFaceUp?: CardInstanceId | null;
    readonly roundNumber?: number;
    readonly turnNumber?: number;
}

export function makeRound(options: MakeRoundOptions = {}): RoundState {
    const players = options.players ?? {
        p0: makePlayer('p0'),
        p1: makePlayer('p1')
    };
    return {
        roundNumber: options.roundNumber ?? 1,
        seatOrder: options.seatOrder ?? Object.keys(players),
        currentPlayerIndex: options.currentPlayerIndex ?? 0,
        turnNumber: options.turnNumber ?? 1,
        deckOrder: options.deckOrder ?? [],
        setAsideFaceDown: options.setAsideFaceDown ?? [],
        setAsideFaceUp: options.setAsideFaceUp ?? null,
        players,
        privateKnowledge: [],
        publicLog: [],
        phase: 'awaiting-play',
        roundResult: null
    };
}

/** A mutable draft of a fixture round, as reduce() would hand to a resolver. */
export function makeDraft(options: MakeRoundOptions = {}): RoundDraft {
    return structuredClone(makeRound(options)) as RoundDraft;
}

/** Builds a players record from a list of partial specs keyed by id. */
export function makePlayers(
    specs: Readonly<Record<PlayerId, Partial<RoundPlayerState>>>
): Readonly<Record<PlayerId, RoundPlayerState>> {
    const players: Record<PlayerId, RoundPlayerState> = {};
    for (const [id, overrides] of Object.entries(specs)) {
        players[id] = makePlayer(id, overrides);
    }
    return players;
}
