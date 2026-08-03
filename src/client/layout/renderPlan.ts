/**
 * What the table should look like, as data (interface rule 6).
 *
 * `STATE_UPDATE` and resize share one path, and that path runs through here.
 * The `Court` scene stays thin because every *decision* is made in this file —
 * which is pure, so Vitest holds the design's visual rules without a WebGL
 * context, exactly as `tableLayout.ts` holds its spatial ones.
 *
 * **It decides nothing about the rules.** Which cards are playable is
 * `view.own.legalPlays`, computed by the engine; this only asks whether an id is
 * in that list. Turn order, protection and elimination arrive already decided.
 */

import { cardTypeOf } from '../../game/engine';
import type { CardInstanceId, CardTypeId, PlayerId, RedactedView } from '../../game/engine';
import { forcedPlayCaption } from '../content/playability';
import { SEAT_STATUS_COPY } from '../content/seatStatus';
import { TOKENS } from '../tokens/tokens';
import type { LayoutSpec, Rect } from './types';

export type SeatState = 'current' | 'protected' | 'eliminated' | 'disconnected' | 'idle';

export interface SeatPlan {
    readonly playerId: PlayerId;
    readonly rect: Rect;
    readonly nickname: string;
    readonly state: SeatState;
    /** Shown beneath the seat when its state needs words. Never colour alone (UIX §6.3). */
    readonly caption: string | null;
    readonly tokens: number;
    /**
     * The pile in play order, each entry keeping its face as well as its value.
     *
     * `RedactedView` has always carried `{cardId, value}` here and this plan
     * mapped it down to the number, so a seat chip could only ever draw bare
     * numerals — "1 1 3" — while the viewer's own row drew a portrait for every
     * card they had played. The identity was not missing; it was being discarded
     * one layer above the renderer, which is the same sentence
     * `OwnStatusPlan.discards` below was fixed by.
     *
     * Nothing is disclosed by carrying it. A discarded card is face up on the
     * table by definition, so interface rule 4 — which governs what may be said
     * about a hand — is not in play here at all.
     *
     * Interface rule 7 is, exactly as before: every entry, oldest first, never a
     * truncation. Faces are wider than numerals, so `fitPips` settles on a
     * smaller pip and, on a small enough screen, `computeLayout` grows the chip;
     * what it never does is drop the last discard.
     */
    readonly discards: readonly { readonly cardId: CardTypeId; readonly value: number }[];
    readonly discardTotal: number;
    /**
     * The card revealed atop this seat's discard pile.
     *
     * Populated for an eliminated seat alone (UIX §6.3) — that reveal is core
     * deduction data and the seat hides nothing. A living player's hand is never
     * here; interface rule 4 allows only `revealed[]` and the showdown.
     */
    readonly revealedCard: CardTypeId | null;
    /**
     * Whether to draw the card-back marker (UIX §6.2).
     *
     * Derived from `alive`, because the redacted view deliberately carries no
     * hand size for another seat — and it must not, since that is deduction
     * data the engine redacts on purpose. `eliminate()` empties the hand, so
     * alive and holding coincide everywhere except the four-player empty-deck
     * Prince fallback, where a living player can legitimately hold nothing.
     */
    readonly holdsCard: boolean;
    /** This viewer's own peek on that seat, if the engine still considers it valid. */
    readonly knownCard: CardTypeId | null;
}

/**
 * The viewer's own standing (UIX §6.1's "own tokens + discards" row).
 *
 * The viewer is filtered out of `seats`, so this is the only place their own
 * token count and discard pile reach the table at all.
 */
export interface OwnStatusPlan {
    readonly rect: Rect;
    /**
     * Whose row this is.
     *
     * The viewer is filtered out of `seats`, so nothing else on the plan carries
     * their id — and the row now has a tap target of its own, which needs to
     * name the seat it belongs to exactly as a chip's does.
     */
    readonly playerId: PlayerId;
    readonly tokens: number;
    /**
     * The pile in play order, each entry keeping its face as well as its value.
     *
     * `RedactedView` has always carried `{cardId, value}` here and this plan
     * mapped it down to the number, so the row could only ever draw numerals
     * while a seat chip drew a portrait for its revealed card. The identity was
     * not missing; it was being discarded one layer above the renderer.
     *
     * Interface rule 7 applies here exactly as it does to a seat chip: every
     * entry, never a truncation.
     */
    readonly discards: readonly { readonly cardId: CardTypeId; readonly value: number }[];
    readonly discardTotal: number;
}

export interface HandCardPlan {
    readonly cardInstanceId: CardInstanceId;
    readonly cardId: CardTypeId;
    readonly rect: Rect;
    readonly playable: boolean;
    readonly dimmed: boolean;
    /** Why a card is dimmed, when the reason is a rule worth stating. */
    readonly caption: string | null;
}

export interface DeckPlan {
    readonly rect: Rect;
    readonly count: number;
    readonly colour: number;
    /** Faster as the deck empties; zero when it is not pulsing at all. */
    readonly pulse: 'none' | 'subtle' | 'strong';
}

export interface BannerPlan {
    readonly rect: Rect;
    readonly text: string;
    readonly colour: number;
}

export interface RenderPlan {
    /**
     * Devotion tokens needed to win this match — seven at two players, five at
     * three, four at four.
     *
     * Carried on the plan rather than looked up at draw time because it is a
     * fact about the match, and every count this client renders was showing a
     * bare tally against a target stated nowhere. `view.tokensToWin` was on
     * every frame and read only by the match-over overlay, which is too late to
     * be of use to anybody.
     */
    readonly tokensToWin: number;
    readonly seats: readonly SeatPlan[];
    readonly own: OwnStatusPlan;
    readonly hand: readonly HandCardPlan[];
    readonly deck: DeckPlan;
    readonly banner: BannerPlan;
    /**
     * The face-up removal, plus how many went face down beside it.
     *
     * The count is drawn as card backs rather than stated, because what it
     * communicates is "three cards left this round, and you only get to see
     * one" — a shape a player reads without being told (UIX §6.1).
     */
    readonly removedCard: {
        readonly rect: Rect;
        readonly cardId: CardTypeId;
        readonly faceDownCount: number;
    } | null;
}

export interface RenderInput {
    readonly view: RedactedView;
    readonly nicknames: Readonly<Record<PlayerId, string>>;
    readonly phase: 'active' | 'round_over' | 'ended';
    readonly paused: boolean;
    readonly missingSeats: readonly PlayerId[];
}

/** UIX §6.4: orange at three or fewer, dark red at empty. */
const DECK_LOW_THRESHOLD = 3;

/** UIX §6.2: medallions run to four, then collapse to a numeral. */
export const MEDALLIONS_BEFORE_COLLAPSE = 4;

export interface MedallionPlan {
    /** How many medallion images to draw. Never more than the collapse threshold. */
    readonly medallions: number;
    /** `×7` when collapsed, null when every token has its own medallion. */
    readonly countLabel: string | null;
}

/**
 * How to show a devotion token count (UIX §6.2).
 *
 * "Tokens collapse; discards don't" — a count of identical items loses nothing
 * as a numeral, which is exactly what buys discard values the right to never
 * collapse.
 *
 * Pure and tested because the scene got this wrong in a way no glance would
 * catch: it built four medallions, then discarded the array when it decided to
 * collapse. The images were already on Phaser's display list by then, so they
 * outlived every redraw — piling up at each old position on resize, and
 * covering the very numeral that replaced them. Deciding here, before anything
 * is constructed, is what makes that shape impossible.
 */
export function medallionPlan(tokens: number): MedallionPlan {
    if (tokens <= 0) return { medallions: 0, countLabel: null };
    if (tokens > MEDALLIONS_BEFORE_COLLAPSE) return { medallions: 1, countLabel: `×${tokens}` };
    return { medallions: tokens, countLabel: null };
}

function deckPlan(view: RedactedView, rect: Rect): DeckPlan {
    if (view.deckCount === 0) return { rect, count: 0, colour: TOKENS.colorDeckEmpty, pulse: 'strong' };
    if (view.deckCount <= DECK_LOW_THRESHOLD) {
        return { rect, count: view.deckCount, colour: TOKENS.colorDeckLow, pulse: 'subtle' };
    }
    return { rect, count: view.deckCount, colour: TOKENS.colorDeckFull, pulse: 'none' };
}

function seatState(
    seat: RedactedView['players'][number],
    view: RedactedView,
    missing: readonly PlayerId[]
): SeatState {
    // Order is the priority order the design implies: being out outranks being
    // away, which outranks holding a turn you cannot take.
    if (!seat.alive) return 'eliminated';
    if (missing.includes(seat.id)) return 'disconnected';
    if (seat.id === view.currentPlayerId) return 'current';
    return seat.protected ? 'protected' : 'idle';
}

/**
 * The state, in the fewest words that still say it.
 *
 * A chip is `contentW / opponentCount` wide — about 110px on a three-opponent
 * phone — and "Protected — cannot be targeted" sets to roughly 165px at the size
 * this band affords. It ran off the right edge of the chip on every narrow
 * layout, on top of being drawn through the discard pips.
 *
 * The sentence is not lost: `seatDossier.ts` keeps its own full-length wording,
 * one tap away, where there is room for it. What a chip needs is the word.
 */
const SEAT_CAPTIONS: Readonly<Record<SeatState, string | null>> = {
    current: null, // the banner already names them
    // From `content/seatStatus.ts`, not restated here: the action sheet labels
    // the same two states about the same seat at the same moment, and a second
    // copy of the words is how the two come to disagree. `current`, `idle` and
    // `disconnected` stay local — no other surface has them.
    protected: SEAT_STATUS_COPY.protected,
    eliminated: SEAT_STATUS_COPY.eliminated,
    disconnected: 'Reconnecting…',
    idle: null
};

function bannerFor(input: RenderInput, rect: Rect, nameOf: (id: PlayerId) => string): BannerPlan {
    if (input.paused) return { rect, text: 'Paused', colour: TOKENS.colorStatePaused };
    if (input.phase === 'ended') return { rect, text: 'Match over', colour: TOKENS.colorStateMatchOver };
    if (input.phase === 'round_over') return { rect, text: 'Round over', colour: TOKENS.colorStateRoundOver };

    const yours = input.view.currentPlayerId === input.view.own.playerId;
    return yours
        ? { rect, text: 'Your turn', colour: TOKENS.colorStateYourTurn }
        : { rect, text: `Waiting for ${nameOf(input.view.currentPlayerId)}`, colour: TOKENS.colorStateWaiting };
}

/**
 * The caption on a dimmed card.
 *
 * The client computes no rule here. When exactly one card is legal and another
 * is held, the engine's forced-play rule is what made the other illegal, and
 * naming the legal card is the only useful thing to say about it.
 */
function dimCaption(view: RedactedView): string | null {
    if (view.own.legalPlays.length !== 1 || view.own.hand.length < 2) return null;
    // Shared with the action sheet, which explains the same rule beside a
    // disabled Play button. Two surfaces phrasing one rule two ways is the drift
    // this import exists to prevent.
    return forcedPlayCaption(cardTypeOf(view.own.legalPlays[0]));
}

/**
 * The card shown face-up on a seat, from the two sources interface rule 4 allows.
 *
 * These are genuinely different disclosures and neither substitutes for the
 * other. An eliminated seat's card is already **on their pile** — `eliminate()`
 * pushes the whole hand there — so the top entry is the reveal, and it is
 * available the moment the elimination lands. `revealedHands` is the deck-out
 * showdown, where survivors are still *holding* their card and no pile carries
 * it. Reading only the latter, as this once did, left every real elimination
 * revealing nothing at all, because `revealedHands` is populated on deck-out
 * alone (`engine/types.ts`) and a deck-out eliminates nobody.
 */
function revealedCardFor(
    seat: RedactedView['players'][number],
    phase: RenderInput['phase'],
    showdown: Readonly<Record<PlayerId, CardTypeId | null>> | undefined
): CardTypeId | null {
    if (!seat.alive) {
        const pile = seat.discardPile;
        return pile.length === 0 ? null : pile[pile.length - 1].cardId;
    }
    return phase === 'round_over' ? (showdown?.[seat.id] ?? null) : null;
}

export function buildRenderPlan(input: RenderInput, spec: LayoutSpec): RenderPlan {
    const { view } = input;
    const nameOf = (id: PlayerId): string => input.nicknames[id] ?? id;

    const opponents = view.players.filter(player => player.id !== view.own.playerId);
    const peeks = new Map(view.revealed.map(peek => [peek.subjectId, peek.cardTypeId]));
    const showdown = view.roundResult?.revealedHands;

    const seats: SeatPlan[] = opponents.slice(0, spec.opponents.length).map((seat, index) => {
        const state = seatState(seat, view, input.missingSeats);
        return {
            playerId: seat.id,
            rect: spec.opponents[index],
            nickname: nameOf(seat.id),
            state,
            caption: SEAT_CAPTIONS[state],
            tokens: seat.tokens,
            // Passed through whole, for the reason the own row is (below): the
            // view already carries the face beside the value, and mapping it
            // away here is what left a seat chip unable to show one.
            discards: seat.discardPile.map(entry => ({ cardId: entry.cardId, value: entry.value })),
            discardTotal: seat.discardValueTotal,
            revealedCard: revealedCardFor(seat, input.phase, showdown),
            holdsCard: seat.alive,
            knownCard: peeks.get(seat.id) ?? null
        };
    });

    const self = view.players.find(player => player.id === view.own.playerId);
    const own: OwnStatusPlan = {
        rect: spec.ownStatus,
        playerId: view.own.playerId,
        tokens: self?.tokens ?? 0,
        // Passed through whole. The view already carries the face beside the
        // value; mapping it away here is what left the row unable to show one.
        discards: self?.discardPile.map(entry => ({ cardId: entry.cardId, value: entry.value })) ?? [],
        discardTotal: self?.discardValueTotal ?? 0
    };

    const caption = dimCaption(view);
    const hand: HandCardPlan[] = view.own.hand.slice(0, spec.hand.length).map((instanceId, index) => {
        const playable = view.own.legalPlays.includes(instanceId);
        return {
            cardInstanceId: instanceId,
            cardId: cardTypeOf(instanceId),
            rect: spec.hand[index],
            playable,
            // Off-turn `legalPlays` is empty, so nothing reads as playable and
            // nothing is dimmed either — dimming implies a choice being denied.
            dimmed: !playable && view.own.legalPlays.length > 0,
            caption: !playable && view.own.legalPlays.length > 0 ? caption : null
        };
    });

    return {
        tokensToWin: view.tokensToWin,
        seats,
        own,
        hand,
        deck: deckPlan(view, spec.deck),
        banner: bannerFor(input, spec.banner, nameOf),
        removedCard:
            spec.removedCard !== null && view.setAsideFaceUp !== null
                ? {
                      rect: spec.removedCard,
                      cardId: view.setAsideFaceUp,
                      faceDownCount: view.removedFaceDownCount
                  }
                : null
    };
}
