/**
 * The two font stacks, as canvas needs them written.
 *
 * **The quotes around "Exo 2" are load-bearing.** Phaser builds a CSS `font`
 * shorthand out of `fontSize` and `fontFamily` and assigns it to
 * `ctx.font`. A family name containing a space is only valid there when it is
 * quoted, and the canvas spec says an *invalid* assignment to `ctx.font` is
 * silently ignored — the context keeps whatever it had, which is the default
 * `10px sans-serif`.
 *
 * So `'34px Exo 2, sans-serif'` does not render Exo 2 at 34px, and it does not
 * fall back to sans-serif at 34px either. It renders **sans-serif at 10px**,
 * whatever size was asked for. Measured directly in a browser:
 *
 *     ctx.font = '34px Exo 2, sans-serif'    -> reads back '10px sans-serif'
 *     ctx.font = '34px "Exo 2", sans-serif'  -> reads back '34px "Exo 2", sans-serif'
 *
 * Every display-face label on the table was drawing at 10px because of this —
 * the deck count computed at 59px, the turn banner at 34px, the card value
 * badge — which is why "Your turn" was reported as too small to read while the
 * card names beside it, set in Inter, were fine. Inter has no space in its
 * name, so its unquoted stack happened to be valid.
 *
 * `fonts.test.ts` holds both stacks to being parseable, so the quotes cannot be
 * tidied away again.
 */

/** Display face: card values, the deck count, the turn banner. */
export const FONT_DISPLAY = '"Exo 2", sans-serif';

/** UI face: everything a player reads as prose. */
export const FONT_UI = 'Inter, sans-serif';
