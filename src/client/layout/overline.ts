/**
 * Whether a card's overline caption fits the card, and at what scale.
 *
 * Only the two-player burn panel carries one ("Removed from play", UIX §6.1),
 * and that panel is the smallest card on the table — smaller still once the
 * face-down fan takes its slivers out of the width. At 986×494 the face-up
 * card is 29px wide and the caption wants about 60, so it drew a caption twice
 * the width of the thing it captioned, spilling to both sides and picking up
 * the value badge across its middle.
 *
 * The card's *name* has always clamped itself to the card. This is the same
 * decision for the caption above it, with one addition: a caption scaled far
 * enough to fit a 29px card is a smear rather than a word, and a smear over
 * the table is worse than no caption. Below the legible floor it is dropped,
 * and the accessibility twin keeps announcing the card either way.
 */

/**
 * Smallest rendered size worth drawing, in px.
 *
 * The card name already floors at `round(MIN_NAME_H * 0.52)` = 8px, so 7 sits
 * just under what this design has always been willing to show, and well above
 * the ~3px the unclamped caption was effectively asking for.
 */
export const MIN_OVERLINE_PX = 7;

/**
 * Scale to draw the caption at, or `null` to omit it.
 *
 * `availableW` is the room the caption may occupy — the caller subtracts its
 * own padding first. `textWidth` is the caption measured at `fontSize`, which
 * only the renderer can know, so it is passed in rather than guessed here.
 */
export function fitOverline(availableW: number, textWidth: number, fontSize: number): number | null {
    if (availableW <= 0 || fontSize <= 0) return null;

    // A caption with no measurable width has nothing to overflow.
    if (textWidth <= 0) return 1;

    const scale = Math.min(1, availableW / textWidth);

    return fontSize * scale < MIN_OVERLINE_PX ? null : scale;
}
