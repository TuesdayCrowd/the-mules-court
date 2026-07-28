/**
 * The match log, in rounds.
 *
 * One source consumed by two surfaces — the seat dossier's second tab and the
 * dock's log tab — so the two can never disagree about what happened. Building
 * the same list twice is how they would.
 *
 * **Rounds, not one flat stream.** The engine restarts `publicLog` each round,
 * and `roundHistory` keeps the ones already finished; a flat concatenation would
 * put "Ana takes the round" directly above an unrelated opening play with
 * nothing to say a round had ended between them. It also gives a devotion token
 * something to point at: a token was won in a round, and that round is a section
 * here.
 *
 * Oldest first, current last — the dossier's existing rule, so a new line always
 * appears where the eye already is.
 */

import type { PlayerId, RedactedView } from '../../game/engine';
import type { NameOf } from './narration';
import { narrate } from './narration';

export interface MatchLogSection {
    readonly roundNumber: number;
    /** "Round 2 — Ana took it", or "Round 3 · in progress". */
    readonly heading: string;
    readonly lines: readonly string[];
    /** True for the round being played, which is the last section when present. */
    readonly current: boolean;
    /** Empty while a round is still running. Lets a caller match a token to a round. */
    readonly winnerIds: readonly PlayerId[];
}

function joinNames(ids: readonly PlayerId[], nameOf: NameOf): string {
    const names = ids.map(nameOf);
    if (names.length <= 1) return names[0] ?? '';
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function finishedHeading(roundNumber: number, winnerIds: readonly PlayerId[], nameOf: NameOf): string {
    if (winnerIds.length === 0) return `Round ${roundNumber}`;
    // "took it" for one, "took it" for a shared win too — the names carry the
    // plural, and "Ana and Toran took it" reads correctly either way.
    return `Round ${roundNumber} — ${joinNames(winnerIds, nameOf)} took it`;
}

/**
 * Every round the viewer may read, oldest first.
 *
 * The current round is included only once something has happened in it: an
 * empty section headed "in progress" is a heading with nothing under it, and the
 * caller has no way to tell it apart from a round that genuinely had no events.
 */
export function matchLogSections(view: RedactedView, nameOf: NameOf): MatchLogSection[] {
    const sections: MatchLogSection[] = view.roundHistory.map(round => ({
        roundNumber: round.roundNumber,
        heading: finishedHeading(round.roundNumber, round.winnerIds, nameOf),
        lines: round.publicLog.map(entry => narrate(entry, nameOf)),
        current: false,
        winnerIds: round.winnerIds
    }));

    if (view.publicLog.length > 0) {
        sections.push({
            // `turnNumber` is per-round and `roundHistory` is every round before
            // this one, so the count is the round number without the engine
            // having to send it twice.
            roundNumber: view.roundHistory.length + 1,
            heading: `Round ${view.roundHistory.length + 1} · in progress`,
            lines: view.publicLog.map(entry => narrate(entry, nameOf)),
            current: true,
            winnerIds: []
        });
    }

    return sections;
}

/** True when there is nothing at all to read, in this round or any before it. */
export function matchLogIsEmpty(view: RedactedView): boolean {
    return view.publicLog.length === 0 && view.roundHistory.length === 0;
}

export const EMPTY_MATCH_LOG = 'Nothing has happened yet.';
