/**
 * The reveal countdown (UIX §9.1, interface rule 5).
 *
 * **The server owns every clock.** `revealDeadline` and `serverTime` both come
 * from the same `STATE_UPDATE`, so the difference between them is the window as
 * the server measured it. The local clock does one job — ageing that reading by
 * however long the snapshot has been sitting here — and never decides when the
 * window ends. A client whose wall clock is an hour out still counts down five
 * seconds, because only the *elapsed* local time is used, never its absolute
 * value.
 */

export interface CountdownSource {
    /** Epoch ms, present only while the round is over. */
    readonly revealDeadline?: number;
    readonly serverTime: number;
    /** Local receipt time, in the same units as the `now` passed alongside it. */
    readonly receivedAt: number;
}

/** Whole seconds left, or `null` when there is no window running. */
export function secondsRemaining(source: CountdownSource, now: number): number | null {
    if (source.revealDeadline === undefined) return null;

    const elapsed = now - source.receivedAt;
    const remaining = source.revealDeadline - (source.serverTime + elapsed);

    // Rounded up so the display reads 1 for the last fractional second rather
    // than showing 0 while the window is still open.
    return Math.max(0, Math.ceil(remaining / 1000));
}
