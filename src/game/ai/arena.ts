/**
 * Scores policies against each other over a fixed seed list (Design §6).
 *
 * The interval is the point. A tuning loop that reads "54% over 200 matches" as
 * progress is reading noise, and this game's variance is high enough that the
 * mistake is easy: a four-player round can be decided by a single blind
 * Informant guess. Every rate here therefore arrives with the range it is
 * actually consistent with, so "better" means the intervals separated.
 *
 * Seeds are supplied rather than generated. Two policies compared on the same
 * seed list played the same deals, which removes the largest single source of
 * variance between runs and makes a comparison reproducible months later.
 */

import type { PlayerId } from '../engine';
import type { Policy } from './policy';
import { playMatch } from './selfPlay';

export interface ArenaSetup {
    readonly seats: readonly PlayerId[];
    readonly policies: Readonly<Record<PlayerId, Policy>>;
    readonly seeds: readonly string[];
}

export interface SeatReport {
    readonly seat: PlayerId;
    readonly policyId: string;
    readonly wins: number;
    readonly rate: number;
    /** 95% Wilson score bounds on `rate`. */
    readonly low: number;
    readonly high: number;
}

export interface ArenaReport {
    readonly matches: number;
    readonly seats: readonly SeatReport[];
}

/** The 95% two-sided normal quantile. */
const Z = 1.959963984540054;

/**
 * The Wilson score interval, not the textbook normal approximation.
 *
 * Wald (`p ± z·sqrt(p(1-p)/n)`) collapses to zero width at p = 0 and p = 1,
 * which is precisely where a policy comparison lands early — "the new policy
 * won 0 of 20" would report an interval of exactly zero and read as certainty.
 * Wilson stays honest there, and needs no special case.
 */
export function wilsonInterval(wins: number, trials: number): { low: number; high: number } {
    if (trials <= 0) return { low: 0, high: 1 };

    const p = wins / trials;
    const z2 = Z * Z;
    const denominator = 1 + z2 / trials;
    const centre = (p + z2 / (2 * trials)) / denominator;
    const margin =
        (Z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denominator;

    return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

export function runArena(setup: ArenaSetup): ArenaReport {
    const wins: Record<PlayerId, number> = Object.fromEntries(setup.seats.map(id => [id, 0]));

    for (const seed of setup.seeds) {
        const outcome = playMatch({ seats: setup.seats, policies: setup.policies, seed });
        if (outcome.winnerId !== null) wins[outcome.winnerId] += 1;
    }

    const matches = setup.seeds.length;

    return {
        matches,
        seats: setup.seats.map(seat => {
            const won = wins[seat];
            const { low, high } = wilsonInterval(won, matches);
            return {
                seat,
                policyId: setup.policies[seat].id,
                wins: won,
                rate: matches === 0 ? 0 : won / matches,
                low,
                high
            };
        })
    };
}
