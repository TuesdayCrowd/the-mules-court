import type {
    CardInstanceId,
    MatchPlayer,
    MatchState,
    PlayerId,
    RngState,
    RoundPlayerState,
    RoundState
} from './types';
import { buildDeck } from './cardCatalog';
import { seedRng, shuffle } from './rng';

/** Cards removed before play, and the tokens needed to win, by player count. */
const SETUP_TABLE = {
    2: { faceUp: 1, faceDown: 2, tokensToWin: 7 },
    3: { faceUp: 0, faceDown: 1, tokensToWin: 5 },
    4: { faceUp: 0, faceDown: 0, tokensToWin: 4 }
} as const;

export type SupportedPlayerCount = keyof typeof SETUP_TABLE;

function assertSupported(playerIds: readonly PlayerId[]): SupportedPlayerCount {
    const count = playerIds.length;
    if (count !== 2 && count !== 3 && count !== 4) {
        throw new Error(`The Mule's Court supports 2 to 4 players, not ${count}`);
    }
    if (new Set(playerIds).size !== count) {
        throw new Error('Player ids must be unique');
    }
    return count;
}

const freshPlayer = (id: PlayerId): RoundPlayerState => ({
    id,
    hand: [],
    discardPile: [],
    discardValueTotal: 0,
    alive: true,
    protected: false
});

/**
 * Deals a round to the given participants.
 *
 * Sudden death reuses this untouched, passing only the tied leaders, so a
 * two-player sudden-death round burns cards exactly like an ordinary two-player
 * game.
 *
 * The starter draws immediately, so the round opens mid-turn with that player
 * holding two cards and every other participant holding one.
 */
export function dealRound(
    participants: readonly PlayerId[],
    starterId: PlayerId,
    roundNumber: number,
    rng: RngState
): { round: RoundState; rng: RngState } {
    const count = assertSupported(participants);
    const { faceUp, faceDown } = SETUP_TABLE[count];

    const { shuffled, rng: afterShuffle } = shuffle(buildDeck(), rng);
    const deck = shuffled.slice();

    const setAsideFaceUp: CardInstanceId | null = faceUp > 0 ? deck.pop()! : null;
    const setAsideFaceDown: CardInstanceId[] = [];
    for (let i = 0; i < faceDown; i++) {
        setAsideFaceDown.push(deck.pop()!);
    }

    const players: Record<PlayerId, RoundPlayerState> = {};
    for (const id of participants) {
        players[id] = { ...freshPlayer(id), hand: [deck.pop()!] };
    }

    // Seat rotation begins with the starter so that "next player" is simply the
    // next index, and so co-win tiebreaks can read turn order directly.
    const startAt = participants.indexOf(starterId);
    const seatOrder = [...participants.slice(startAt), ...participants.slice(0, startAt)];

    // The opening draw.
    players[starterId] = { ...players[starterId], hand: [...players[starterId].hand, deck.pop()!] };

    return {
        round: {
            roundNumber,
            seatOrder,
            currentPlayerIndex: 0,
            turnNumber: 1,
            deckOrder: deck,
            setAsideFaceDown,
            setAsideFaceUp,
            players,
            privateKnowledge: [],
            publicLog: [],
            phase: 'awaiting-play',
            roundResult: null
        },
        rng: afterShuffle
    };
}

/**
 * Builds a fresh match.
 *
 * The first seat leads round one; from round two onward the previous winner
 * leads, and a co-win breaks toward whoever most recently led.
 */
export function createMatch(playerIds: readonly PlayerId[], seed: string): MatchState {
    const count = assertSupported(playerIds);
    const starterId = playerIds[0];

    const { round, rng } = dealRound(playerIds, starterId, 1, seedRng(seed));

    const players: MatchPlayer[] = playerIds.map((id, seat) => ({
        id,
        seat,
        tokens: 0,
        lastStartedRound: id === starterId ? 1 : 0
    }));

    return {
        schemaVersion: 1,
        matchId: seed,
        playerCount: count,
        tokensToWin: SETUP_TABLE[count].tokensToWin,
        players,
        seed,
        rng,
        mode: 'normal',
        suddenDeathPlayers: [],
        round,
        matchWinnerId: null,
        actionLog: []
    };
}
