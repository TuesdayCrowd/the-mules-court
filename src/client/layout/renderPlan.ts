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
    /** This viewer's own peek on that seat, if the engine still considers it valid. */
    readonly knownCard: CardTypeId | null;
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
    readonly hand: readonly HandCardPlan[];
    readonly deck: DeckPlan;
    readonly banner: BannerPlan;
    readonly removedCard: { readonly rect: Rect; readonly cardId: CardTypeId } | null;
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
            // Eliminated seats reveal what they held; the showdown reveals
            // everyone's. Both are the engine's disclosures, not the client's.
            revealedCard: !seat.alive || input.phase === 'round_over' ? (showdown?.[seat.id] ?? null) : null,
            knownCard: peeks.get(seat.id) ?? null
        };
    });

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
        hand,
        deck: deckPlan(view, spec.deck),
        banner: bannerFor(input, spec.banner, nameOf),
        removedCard:
            spec.removedCard !== null && view.setAsideFaceUp !== null
                ? { rect: spec.removedCard, cardId: view.setAsideFaceUp }
                : null
    };
}
