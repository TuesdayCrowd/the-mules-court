/**
 * What a seat can account for, and what is still loose (Design §4).
 *
 * The census is the exact half of belief: pure counting, no inference. Sixteen
 * physical cards exist; subtract the ones this seat can see — its own hand,
 * every face-up discard, the two-player face-up burn, and anything a live peek
 * pins to a named opponent — and what remains is the pool whose location is
 * genuinely unknown.
 *
 * Exactness is available here in a way it usually is not in a hidden-information
 * game, and the reason is `SETUP_TABLE`: at four players **nothing is set aside**
 * (`removedFaceDownCount` is 0), so every card is in a hand, in the deck, or on
 * the table. There is no permanently hidden card blurring the count. At two and
 * three players some mass really is unknowable, which is why `unseen` describes
 * "not located" rather than "in the deck" — the distinction matters there and
 * this module keeps it honest at every table size.
 *
 * Counts are by card TYPE, not by instance, because that is all the view
 * exposes: `discardPile` entries carry `{cardId, value}` and `revealed` carries
 * a `cardTypeId`. Only the viewer's own hand names instances.
 */

import type { CardTypeId, PlayerId, RedactedView } from '../engine';
import { CARD_CATALOG, cardTypeOf } from '../engine';

export interface Census {
    /**
     * Every card whose holder this seat cannot name, one entry per physical
     * copy — so three unaccounted Informants appear three times. A multiset as
     * an array, because every consumer either samples from it or counts it.
     */
    readonly unseen: readonly CardTypeId[];
    /** Cards a live peek pins to a named opponent. Certainty, not inference. */
    readonly knownHands: Readonly<Record<PlayerId, readonly CardTypeId[]>>;
    /** How many cards each seat holds right now, including the viewer's own. */
    readonly handSizes: Readonly<Record<PlayerId, number>>;
}

export function takeCensus(seat: RedactedView): Census {
    const handSizes: Record<PlayerId, number> = {};
    for (const player of seat.players) {
        // Whoever holds the turn has drawn and holds two; everyone else living
        // holds one. A living seat with zero cards exists only inside the
        // four-player empty-deck Prince fallback, and `checkRoundEnd` ends the
        // round on the same action — so it is never a state anyone decides from.
        handSizes[player.id] = player.alive ? (player.id === seat.currentPlayerId ? 2 : 1) : 0;
    }
    // The viewer's own hand is observed rather than inferred, so it wins.
    handSizes[seat.own.playerId] = seat.own.hand.length;

    const knownHands: Record<PlayerId, CardTypeId[]> = {};
    const counted = new Set<string>();
    for (const record of seat.revealed) {
        // A peek at oneself would double-count against `own.hand`.
        if (record.subjectId === seat.own.playerId) continue;

        // Peeking the same card twice yields two identical records. Collapsing
        // them costs the ability to tell that from a hand holding two copies of
        // one type — which needs a two-card opponent, and therefore a viewer who
        // does not hold the turn. Policies decide on their own turn.
        const key = `${record.subjectId}|${record.cardTypeId}`;
        if (counted.has(key)) continue;
        counted.add(key);

        const held = (knownHands[record.subjectId] ??= []);
        if (held.length < (handSizes[record.subjectId] ?? 0)) held.push(record.cardTypeId);
    }

    const remaining = new Map<CardTypeId, number>();
    for (const card of Object.values(CARD_CATALOG)) remaining.set(card.id, card.count);

    const account = (type: CardTypeId): void => {
        remaining.set(type, (remaining.get(type) ?? 0) - 1);
    };

    for (const instanceId of seat.own.hand) account(cardTypeOf(instanceId));
    for (const player of seat.players) {
        for (const entry of player.discardPile) account(entry.cardId);
    }
    if (seat.setAsideFaceUp !== null) account(seat.setAsideFaceUp);
    for (const held of Object.values(knownHands)) {
        for (const type of held) account(type);
    }

    const unseen: CardTypeId[] = [];
    for (const [type, count] of remaining) {
        for (let i = 0; i < count; i++) unseen.push(type);
    }

    return { unseen, knownHands, handSizes };
}
