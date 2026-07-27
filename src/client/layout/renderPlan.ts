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
import { cardCopyFor } from '../content/cardCopy';
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
    /** Every discarded value, oldest first. Interface rule 7: never truncated. */
    readonly discardValues: readonly number[];
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
    readonly tokens: number;
    /** Interface rule 7 applies here exactly as it does to a seat chip. */
    readonly discardValues: readonly number[];
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

const SEAT_CAPTIONS: Readonly<Record<SeatState, string | null>> = {
    current: null, // the banner already names them
    protected: 'Protected — cannot be targeted',
    eliminated: 'Out of the round',
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
    return `must play ${cardCopyFor(cardTypeOf(view.own.legalPlays[0])).displayName}`;
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
            discardValues: seat.discardPile.map(entry => entry.value),
            discardTotal: seat.discardValueTotal,
            revealedCard: revealedCardFor(seat, input.phase, showdown),
            holdsCard: seat.alive,
            knownCard: peeks.get(seat.id) ?? null
        };
    });

    const self = view.players.find(player => player.id === view.own.playerId);
    const own: OwnStatusPlan = {
        rect: spec.ownStatus,
        tokens: self?.tokens ?? 0,
        discardValues: self?.discardPile.map(entry => entry.value) ?? [],
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
