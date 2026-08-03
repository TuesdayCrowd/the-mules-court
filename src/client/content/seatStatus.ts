/**
 * What a seat's state is called, wherever a player reads it.
 *
 * Two surfaces state these facts about the same seat at the same moment — the
 * table's seat chip and the action sheet's target list — and they must not
 * disagree. They did: the chip said "Out of the round" while the sheet printed
 * the raw enum value, `eliminated`, straight onto the screen. One fact, two
 * words, one of them not English anybody chose.
 *
 * Only the two states another player can be *targeted around*. `current`,
 * `idle` and `disconnected` are the table's own vocabulary and stay in
 * `layout/renderPlan.ts`, which is the only surface that has them.
 */
export type TargetableSeatStatus = 'protected' | 'eliminated';

/**
 * "Out of the round", not "Eliminated": elimination is temporary in this game.
 * A seat out of this round is dealt back in for the next one, and the round is
 * the thing the player is being told about.
 */
export const SEAT_STATUS_COPY: Readonly<Record<TargetableSeatStatus, string>> = {
    protected: 'Protected',
    eliminated: 'Out of the round'
};

export function seatStatusCopy(status: TargetableSeatStatus): string {
    return SEAT_STATUS_COPY[status];
}
