/**
 * The move a seat makes when its agent does not (Design §6).
 *
 * This exists so one stalled agent cannot freeze a table three other people
 * are sitting at. A dull move beats a hung match, and the human is told it
 * happened — so the bar here is "legal, deterministic, not actively silly",
 * not "good".
 *
 * It takes a structural subset of `RedactedView` rather than the whole thing.
 * A full view would still satisfy the parameter, so callers pass one directly;
 * narrowing the type is about what this module *cannot* reach. A fallback
 * policy with no access to `deckCount`, `publicLog`, or `roundHistory` cannot
 * grow a dependency on them, and the three fields it does take are the three
 * a player would actually look at.
 *
 * It never decides legality. `own.legalPlays` and `own.legalTargets` are the
 * engine's answers, already accounting for the First Speaker's forcing rule
 * and for protection, and `view.ts` records what happens to a client that
 * restates targeting itself: a Darell could never be aimed at its own player.
 */

import type { CardInstanceId, CardValue, GuessValue, PlayerId, RedactedView } from '../game/engine';
import { CARD_CATALOG, cardTypeOf, INFORMANT_VALUE } from '../game/engine';

/** The three slices of a `RedactedView` a fallback may read. A full view satisfies it. */
export interface FallbackInput {
    readonly own: RedactedView['own'];
    readonly players: RedactedView['players'];
    readonly revealed: RedactedView['revealed'];
}

/** Shaped like `PLAY_CARD`'s payload, minus the routing the transport adds. */
export interface FallbackPlay {
    readonly cardInstanceId: CardInstanceId;
    readonly target?: PlayerId;
    readonly guess?: GuessValue;
}

/** How many physical copies of each value the deck holds, summed once at load. */
const COPIES_BY_VALUE: ReadonlyMap<CardValue, number> = (() => {
    const copies = new Map<CardValue, number>();
    for (const card of Object.values(CARD_CATALOG)) {
        copies.set(card.value, (copies.get(card.value) ?? 0) + card.count);
    }
    return copies;
})();

/** The values an Informant may name — every value but its own. */
const GUESSABLE_VALUES: readonly GuessValue[] = [...COPIES_BY_VALUE.keys()]
    .filter((value): value is GuessValue => value !== INFORMANT_VALUE)
    .sort((a, b) => a - b);

function valueOf(instanceId: CardInstanceId): CardValue {
    return CARD_CATALOG[cardTypeOf(instanceId)].value;
}

/**
 * Every copy of every value this seat can already account for, and therefore
 * cannot be in the target's hand: face-up discards, the other card in its own
 * hand, and any peek it still holds.
 *
 * `revealed` is re-derived live by `view()` on every call and drops the moment
 * its subject stops holding that exact instance, so a stale peek cannot reach
 * this function to be counted.
 */
function countAccountedFor(view: FallbackInput, playing: CardInstanceId): Map<CardValue, number> {
    const seen = new Map<CardValue, number>();
    const add = (value: CardValue) => seen.set(value, (seen.get(value) ?? 0) + 1);

    for (const player of view.players) {
        for (const entry of player.discardPile) add(entry.value);
    }
    for (const instanceId of view.own.hand) {
        if (instanceId !== playing) add(valueOf(instanceId));
    }
    for (const peek of view.revealed) {
        add(CARD_CATALOG[peek.cardTypeId].value);
    }

    return seen;
}

/**
 * What to name, given that we are aiming an Informant at `target`.
 *
 * A live peek at that exact player is the only certainty available, so it wins
 * outright — unless it names an Informant, which is the one card the rules
 * forbid guessing. Otherwise: the value with the most copies still unseen,
 * ties broken low so the choice is reproducible.
 */
function pickGuess(view: FallbackInput, playing: CardInstanceId, target: PlayerId): GuessValue {
    const peek = view.revealed.find(record => record.subjectId === target);
    if (peek !== undefined) {
        const peeked = CARD_CATALOG[peek.cardTypeId].value;
        if (peeked !== INFORMANT_VALUE) return peeked as GuessValue;
    }

    const accountedFor = countAccountedFor(view, playing);
    const remaining = (value: GuessValue) => (COPIES_BY_VALUE.get(value) ?? 0) - (accountedFor.get(value) ?? 0);

    const live = GUESSABLE_VALUES.filter(value => remaining(value) > 0);
    // Every guessable value being spent is not reachable in a legal round — but
    // returning a value beats throwing inside the thing that exists to stop a
    // seat from hanging the table.
    const candidates = live.length > 0 ? live : GUESSABLE_VALUES;

    return candidates.reduce((best, value) => (remaining(value) > remaining(best) ? value : best));
}

/**
 * Picks the lowest-value legal card, aims it at the first legal target, and
 * names a value if it is an Informant. Null when the seat has no legal play,
 * which the caller must treat as "do nothing" rather than as an error.
 */
export function chooseFallbackPlay(view: FallbackInput): FallbackPlay | null {
    const { legalPlays, legalTargets } = view.own;
    if (legalPlays.length === 0) return null;

    // Strictly less-than, so a tie keeps the earlier card and the choice is a
    // function of the engine's own ordering rather than of sort stability.
    let cardInstanceId = legalPlays[0]!;
    for (const candidate of legalPlays) {
        if (valueOf(candidate) < valueOf(cardInstanceId)) cardInstanceId = candidate;
    }

    const target = (legalTargets[cardInstanceId] ?? [])[0];
    if (target === undefined) return { cardInstanceId };

    const isInformant = valueOf(cardInstanceId) === INFORMANT_VALUE;
    return {
        cardInstanceId,
        target,
        ...(isInformant ? { guess: pickGuess(view, cardInstanceId, target) } : {})
    };
}
