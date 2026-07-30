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

export interface RotationSetup {
    readonly seats: readonly PlayerId[];
    /** The policy under test. Plays every seat in turn. */
    readonly candidate: Policy;
    /** Fills every other seat, every time. */
    readonly field: Policy;
    readonly seeds: readonly string[];
}

export interface RotationReport {
    readonly matches: number;
    readonly wins: number;
    readonly rate: number;
    readonly low: number;
    readonly high: number;
}

/**
 * One candidate against a field, playing every seat on every seed.
 *
 * This is the measurement a training run optimises, and rotating is what makes
 * it trustworthy. Turn order is a genuine edge in this game, so scoring a
 * candidate in a fixed seat measures the seat as much as the policy — and a
 * search would happily spend its budget exploiting that. Playing all of them
 * cancels it exactly, and makes `1 / seats.length` the honest baseline.
 *
 * Seeds are shared across candidates by the caller, which is the other half:
 * two policies compared on the same seed list played the same deals, so the
 * difference between them is not the shuffle.
 */
export function rotatingWinRate(setup: RotationSetup): RotationReport {
    let wins = 0;

    for (const seed of setup.seeds) {
        for (const seat of setup.seats) {
            const policies = Object.fromEntries(
                setup.seats.map(id => [id, id === seat ? setup.candidate : setup.field])
            );
            // The seed varies with the seat, so the four rotations of one seed
            // are four different deals rather than the same deal played from
            // four chairs — which would correlate them and understate variance.
            const outcome = playMatch({ seats: setup.seats, policies, seed: `${seed}:${seat}` });
            if (outcome.winnerId === seat) wins += 1;
        }
    }

    const matches = setup.seeds.length * setup.seats.length;
    const { low, high } = wilsonInterval(wins, matches);

    return { matches, wins, rate: matches === 0 ? 0 : wins / matches, low, high };
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
