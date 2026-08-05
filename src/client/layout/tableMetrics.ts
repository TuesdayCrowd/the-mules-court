/**
 * The table's fixed measurements, as data rather than as scene internals.
 *
 * These lived at the bottom of `Court.ts` — a hundred and thirty lines of
 * fractions, floors and one colour map with no Phaser in any of them, sitting
 * inside the one file that cannot be loaded without a WebGL context. Nothing
 * about a legible floor for a value badge is a fact about a renderer, so they
 * are here, beside the layout functions that already own the rest of the
 * table's geometry.
 *
 * The move is behaviour-preserving on purpose. Two genuine discrepancies turned
 * up while making it and are recorded below rather than quietly corrected —
 * both change pixels, and both are decisions for whoever owns the visual design.
 */

import type { SeatPlan } from './renderPlan';
import { TOKENS } from '../tokens/tokens';

/**
 * The aspect of the portrait art: every file under a character slug is 512×720
 * (`portraits.ts`, and verified against the files themselves).
 *
 * **Named for what it is, which `CARD_ASPECT` was not.** Under the old name it
 * also sized the seat chip's card-back marker, and the card back is
 * `card_back_2.png` at 768×1024 — aspect 0.75, not 0.711 — so that marker is
 * drawn about five per cent narrower than its own art. The name is what hid it:
 * "card aspect" reads as correct beside a card back. Left as it was, because
 * fixing it moves pixels; see `IMPLEMENTATION_PLAN.md`.
 *
 * `tableLayout.ts` has its own `CARD_ASPECT` of 0.75 for the deck, the removed
 * card and the hand. That one is right for the deck, which draws the back, and
 * carries the same question for the hand, which draws a portrait.
 */
export const PORTRAIT_ASPECT = 512 / 720;

/** The card-back marker on a seat chip, and the face-up reveal on an eliminated one. */
export const CARD_BACK_H = 26;
export const REVEALED_H = 30;

/**
 * How many times the deck's warning breathes per state update.
 *
 * Finite by requirement: an endless tween keeps `isAnimating()` true, and the
 * render loop cannot stop while anything is animating. Strong gets more because
 * an empty deck means the showdown is the next play.
 */
export const DECK_PULSE_REPEATS_SUBTLE = 1;
export const DECK_PULSE_REPEATS_STRONG = 3;

/**
 * How long a finger must rest on a card before it reads as "tell me about this"
 * rather than "play this". Long enough not to fire on a deliberate tap, short
 * enough that a player who is waiting does not give up first.
 */
export const LONG_PRESS_MS = 450;

/** A press that travels this far was a scroll or a mis-aim, not a press. */
export const MOVE_CANCEL_PX = 10;

/** The value badge, as a fraction of the card's short edge, with a legible floor. */
export const BADGE_FRACTION = 0.28;
export const MIN_BADGE = 22;

/** Breathing room a card's text keeps from its own edges, both sides together. */
export const LABEL_PAD = 6;

/**
 * Floors and fractions for the table text that carries no card behind it.
 *
 * The turn banner and the seat chips were the only on-table text drawn against
 * bare nebula — every other label has a plate, a scrim or a filled rect under
 * it. They now do too, and the sizes below scale with the rect they sit in
 * rather than being pinned to a phone's pixel count.
 */
export const MIN_BANNER_PX = 20;
export const BANNER_PLATE_PAD = 14;

/** The name strip along the card's bottom edge. */
export const NAME_FRACTION = 0.16;
export const MIN_NAME_H = 16;

/**
 * How far each face-down removal peeks out past the one in front of it.
 *
 * A fraction of the panel so it scales with the table, with a floor so the
 * edges stay visible as separate cards rather than merging into one thick line.
 */
export const SLIVER_STEP_FRACTION = 0.14;
export const MIN_SLIVER_STEP = 5;

/**
 * Vertical inset per card of depth, so the hidden cards recede behind the
 * face-up one instead of sharing its exact height. Multiplied by depth: without
 * a per-card difference, two backs of the same texture read as one card.
 */
export const SLIVER_INSET = 3;

/** A floor, so a short panel cannot invert the receding inset into a negative. */
export const MIN_SLIVER_HEIGHT = 12;

/** Long enough to ride out a toolbar collapse, short enough to feel immediate. */
export const RESIZE_DEBOUNCE_MS = 100;

/** UIX §6.3, straight from the palette — the plan chose the state, this maps it. */
export const SEAT_COLOURS: Record<SeatPlan['state'], number> = {
    current: TOKENS.colorSeatCurrent,
    protected: TOKENS.colorSeatProtected,
    eliminated: TOKENS.colorSeatEliminated,
    disconnected: TOKENS.colorSeatDisconnected,
    idle: TOKENS.colorSeatOther
};

/**
 * The largest share of the viewport a right-edge panel may be pushed down by.
 *
 * A panel inset to the seat band is trading its own height for the table's
 * legibility, and past some point that trade stops being worth it — a panel
 * whose controls start below the fold is a worse failure than a covered seat,
 * because at least a covered seat can be read by closing the panel.
 *
 * Half is deliberately generous: no shipped topology comes near it (a wide
 * desktop puts the seat band around 29% down), so the clamp is a guard against
 * an aspect ratio nobody has tried, not a limit the normal case negotiates with.
 */
export const MAX_PANEL_INSET_FRACTION = 0.5;

/**
 * How far down a right-edge panel may start so it clears the seats.
 *
 * Shared by the action sheet and the reference dock. Both cover the rightmost
 * seat when pinned to the full height of a wide viewport, and a player who has
 * to close a panel to read a seat has had the flow of the game interrupted by
 * the interface. One function so the two can never disagree about the rule, and
 * so the clamp has one place to be argued and one place to be tested.
 *
 * Clamped at both ends: never negative, never past `MAX_PANEL_INSET_FRACTION`.
 */
export function panelSafeTop(opponentsBottom: number, viewportH: number): number {
    return Math.max(0, Math.min(opponentsBottom, viewportH * MAX_PANEL_INSET_FRACTION));
}
