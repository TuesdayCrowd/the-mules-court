/**
 * Samples one concrete world consistent with what a seat can see (Design §4).
 *
 * A policy holds a `RedactedView`, and the engine's only evaluator, `reduce()`,
 * needs a `MatchState`. This bridges them: deal the unlocated cards into the
 * hands, the deck, and the set-aside pile at random, subject to everything the
 * seat already knows, and hand back a match that could really be the one being
 * played.
 *
 * The correctness property is a single line, and `determinize.test.ts` makes it
 * the headline gate:
 *
 *     view(determinize(v, rng), v.own.playerId)   deep-equals   v
 *
 * A sampled world the viewer could distinguish from reality is one where the bot
 * is either cheating or reasoning about a game that cannot exist. Two details
 * exist only to keep that equality true, and both are easy to get wrong:
 *
 * **Seat rotation is recovered, not invented.** `computeLegalTargets` filters
 * `round.seatOrder`, so `legalTargets` comes back *in seat order* — meaning the
 * rotation is observable through the view even though `seatOrder` is not a field
 * of it. The rotation begins at whoever led the round, and a round's first
 * public log entry is that player's opening play. With an empty log the round
 * has not been played into yet, so the leader is simply whoever holds the turn.
 *
 * **Peeks are rebuilt as records.** `view()` derives `revealed` live from
 * `privateKnowledge`, keeping only records whose subject still holds that exact
 * instance. A world that placed the peeked card correctly but skipped the record
 * would report an empty `revealed` and fail the roundtrip.
 */

import type {
    CardInstanceId,
    CardTypeId,
    DiscardEntry,
    MatchPlayer,
    MatchState,
    PeekRecord,
    PlayerId,
    RedactedView,
    RoundPlayerState,
    RoundState
} from '../engine';
import { CARD_CATALOG, cardTypeOf, makeCardInstanceId } from '../engine';
import { takeCensus } from './census';
import type { Rng } from './rng';

/**
 * Placeholder for a field the view does not carry and search does not read.
 *
 * The seed reproduces the real shuffle, so a determinized world must not carry
 * one — an empty string is the honest value for "this world was invented".
 */
const NO_SEED = '';

export function determinize(seat: RedactedView, rng: Rng): MatchState {
    if (seat.mode !== 'normal') {
        throw new Error(
            'determinize does not support sudden death: the round is dealt to the tied ' +
                'leaders only, so a view cannot distinguish a non-participant from a ' +
                'player eliminated this round'
        );
    }
    if (seat.roundResult !== null || seat.matchWinnerId !== null) {
        throw new Error('determinize expects a round still accepting plays');
    }

    const census = takeCensus(seat);
    const roundNumber = seat.roundHistory.length + 1;

    // ---------------------------------------------------------------- instances
    const pool = new Map<CardTypeId, CardInstanceId[]>();
    for (const card of Object.values(CARD_CATALOG)) {
        pool.set(
            card.id,
            Array.from({ length: card.count }, (_, ordinal) => makeCardInstanceId(card.id, ordinal))
        );
    }

    const claim = (instanceId: CardInstanceId): CardInstanceId => {
        const copies = pool.get(cardTypeOf(instanceId));
        const at = copies?.indexOf(instanceId) ?? -1;
        if (copies === undefined || at === -1) {
            throw new Error(`${instanceId} was placed twice`);
        }
        copies.splice(at, 1);
        return instanceId;
    };

    /** Any unused copy of a type. Copies of one type are interchangeable. */
    const anyCopy = (type: CardTypeId): CardInstanceId => {
        const copies = pool.get(type);
        if (copies === undefined || copies.length === 0) {
            throw new Error(`No unused copy of ${type} remains`);
        }
        return copies.pop()!;
    };

    // Observed placements first, so the loose pool is exactly what is left over.
    const ownHand = seat.own.hand.map(claim);

    const discardPiles: Record<PlayerId, DiscardEntry[]> = {};
    for (const player of seat.players) {
        discardPiles[player.id] = player.discardPile.map(entry => ({
            instanceId: anyCopy(entry.cardId),
            cardId: entry.cardId,
            value: entry.value
        }));
    }

    const setAsideFaceUp = seat.setAsideFaceUp === null ? null : anyCopy(seat.setAsideFaceUp);

    const hands: Record<PlayerId, CardInstanceId[]> = { [seat.own.playerId]: ownHand };

    // One placement per card the seat knows about, keyed so the peek records
    // below can find it. The census has already collapsed repeat peeks at one
    // card down to the single card they describe.
    const placed = new Map<string, CardInstanceId>();
    for (const [subjectId, held] of Object.entries(census.knownHands)) {
        hands[subjectId] = held.map(type => {
            const instanceId = anyCopy(type);
            placed.set(`${subjectId}|${type}`, instanceId);
            return instanceId;
        });
    }

    // ------------------------------------------------------------- the unknowns
    const loose = shuffled([...pool.values()].flat(), rng);

    const hiddenSlots = seat.players.reduce(
        (total, player) =>
            player.id === seat.own.playerId
                ? total
                : total + census.handSizes[player.id] - (hands[player.id]?.length ?? 0),
        0
    );
    const expected = hiddenSlots + seat.deckCount + seat.removedFaceDownCount;
    if (loose.length !== expected) {
        throw new Error(
            `Census does not reconcile: ${loose.length} unlocated cards for ${expected} places`
        );
    }

    for (const player of seat.players) {
        if (player.id === seat.own.playerId) continue;
        const hand = (hands[player.id] ??= []);
        while (hand.length < census.handSizes[player.id]) hand.push(loose.pop()!);
    }

    const setAsideFaceDown = loose.splice(0, seat.removedFaceDownCount);
    const deckOrder = loose;

    // ------------------------------------------------------------------- rotation
    const leaderId = openingActor(seat) ?? seat.currentPlayerId;
    const bySeat = [...seat.players].sort((a, b) => a.seat - b.seat).map(player => player.id);
    const from = bySeat.indexOf(leaderId);
    const seatOrder = [...bySeat.slice(from), ...bySeat.slice(0, from)];

    // ---------------------------------------------------------------- assembly
    const players: Record<PlayerId, RoundPlayerState> = {};
    for (const player of seat.players) {
        players[player.id] = {
            id: player.id,
            hand: hands[player.id] ?? [],
            discardPile: discardPiles[player.id],
            discardValueTotal: player.discardValueTotal,
            alive: player.alive,
            protected: player.protected
        };
    }

    // One record per entry in `revealed`, not one per card — the two differ, and
    // the roundtrip is what proves it. `view()` maps records to entries one for
    // one, so peeking the same card twice (a Priest and then a Baron compare, or
    // simply two Priests) yields two identical entries backed by one physical
    // card. Emitting a record per card would come back one entry short.
    const privateKnowledge: PeekRecord[] = seat.revealed.map((record, index) => {
        const instanceId = placed.get(`${record.subjectId}|${record.cardTypeId}`);
        if (instanceId === undefined) {
            throw new Error(
                `Peek at ${record.subjectId}'s ${record.cardTypeId} contradicts that seat's hand`
            );
        }
        return {
            id: `determinized-${index}`,
            // Not observable through the view: `revealed` carries no provenance,
            // so a Baron compare and a Priest look are the same fact here.
            kind: 'priest',
            viewerId: seat.own.playerId,
            subjectId: record.subjectId,
            cardInstanceId: instanceId,
            cardTypeId: record.cardTypeId,
            roundNumber,
            createdAtTurn: seat.turnNumber
        };
    });

    const round: RoundState = {
        roundNumber,
        seatOrder,
        currentPlayerIndex: seatOrder.indexOf(seat.currentPlayerId),
        turnNumber: seat.turnNumber,
        deckOrder,
        setAsideFaceDown,
        setAsideFaceUp,
        players,
        privateKnowledge,
        publicLog: [...seat.publicLog],
        phase: 'awaiting-play',
        roundResult: null
    };

    const matchPlayers: MatchPlayer[] = [...seat.players]
        .sort((a, b) => a.seat - b.seat)
        .map(player => ({
            id: player.id,
            seat: player.seat,
            tokens: player.tokens,
            // Only ever consulted to break a co-win tie for who leads next. The
            // view does not carry it; the current leader is the one fact about it
            // that is recoverable, and it is the one that matters.
            lastStartedRound: player.id === leaderId ? roundNumber : 0
        }));

    return {
        schemaVersion: 1,
        matchId: seat.matchId,
        playerCount: seat.playerCount as 2 | 3 | 4,
        tokensToWin: seat.tokensToWin as 7 | 5 | 4,
        players: matchPlayers,
        seed: NO_SEED,
        // Search may deal a following round, so this must be usable — but it must
        // not be the match's real state, which the seed would reproduce.
        rng: { s: Math.floor(rng.next() * 0xffffffff) >>> 0 },
        mode: 'normal',
        suddenDeathPlayers: [],
        round,
        roundHistory: [...seat.roundHistory],
        matchWinnerId: null,
        actionLog: []
    };
}

/** Who opened this round, from the first log entry that names an actor. */
function openingActor(seat: RedactedView): PlayerId | null {
    for (const entry of seat.publicLog) {
        if ('actorId' in entry) return entry.actorId;
    }
    return null;
}

/** Fisher-Yates over a copy, drawing from the policy's stream. */
function shuffled<T>(items: readonly T[], rng: Rng): T[] {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(rng.next() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}
