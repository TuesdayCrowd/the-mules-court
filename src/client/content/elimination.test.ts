import { describe, expect, it } from 'vitest';
import type { PublicLogEntry, RedactedView } from '../../game/engine';
import { makeView } from '../store/__fixtures__/view';
import { eliminationReason } from './elimination';

const nameOf = (id: string) => ({ p1: 'Ana', p2: 'Bayta', p3: 'Toran' })[id] ?? id;

/** A view from p1's seat, eliminated, with whatever log and reveals a case needs. */
function eliminated(options: {
    log: PublicLogEntry[];
    ownDiscard?: Array<{ cardId: string; value: number }>;
    revealed?: Array<{ subjectId: string; cardTypeId: string }>;
}): RedactedView {
    const base = makeView();
    return makeView({
        publicLog: options.log,
        revealed: (options.revealed ?? []) as never,
        players: [
            {
                ...base.players[0],
                id: 'p1',
                alive: false,
                discardPile: (options.ownDiscard ?? []) as never,
                discardValueTotal: 0
            },
            base.players[1]
        ]
    });
}

const COMPARE_LOST: PublicLogEntry[] = [
    { kind: 'PLAY', turn: 3, actorId: 'p2', cardId: 'ebling-mis' },
    { kind: 'COMPARE', turn: 3, actorId: 'p2', targetId: 'p1', result: 'target-eliminated' },
    { kind: 'ELIMINATED', turn: 3, playerId: 'p1', cause: 'baron' }
];

describe('when nothing has happened to the viewer', () => {
    it('says nothing while they are still in the round', () => {
        expect(eliminationReason(makeView(), nameOf)).toBeNull();
    });

    it('says nothing about somebody else going out', () => {
        const view = makeView({
            publicLog: [{ kind: 'ELIMINATED', turn: 2, playerId: 'p2', cause: 'guard' }]
        });
        expect(eliminationReason(view, nameOf)).toBeNull();
    });
});

/** The reported case: "it is not always clear why a person lost." */
describe('losing a comparison', () => {
    it('names both cards, so the comparison can be checked', () => {
        const reason = eliminationReason(
            eliminated({
                log: COMPARE_LOST,
                ownDiscard: [{ cardId: 'ebling-mis', value: 3 }],
                revealed: [{ subjectId: 'p2', cardTypeId: 'bayta-darell' }]
            }),
            nameOf
        )!;

        expect(reason.detail).toContain('Bayta');
        expect(reason.detail).toContain('3 · Ebling Mis');
        expect(reason.detail).toContain('5 · Bayta Darell');
    });

    it('is allowed to name the winner’s card, because the engine dealt this viewer that peek', () => {
        // `resolvers/baron.ts` records a peek for BOTH players before the tie
        // check — "they physically compared them" — so this is disclosure the
        // engine already made to this viewer, not a rule the client invented.
        const reason = eliminationReason(
            eliminated({
                log: COMPARE_LOST,
                ownDiscard: [{ cardId: 'ebling-mis', value: 3 }],
                revealed: [{ subjectId: 'p2', cardTypeId: 'bayta-darell' }]
            }),
            nameOf
        )!;

        expect(reason.detail).toContain('5 · Bayta Darell');
    });

    it('still explains itself when the peek has already expired', () => {
        // `view.revealed` drops a peek the moment the subject stops holding that
        // exact card. The sentence has to survive that, so it says what it knows.
        const reason = eliminationReason(
            eliminated({ log: COMPARE_LOST, ownDiscard: [{ cardId: 'ebling-mis', value: 3 }], revealed: [] }),
            nameOf
        )!;

        expect(reason.detail).toContain('Bayta');
        expect(reason.detail).toContain('3 · Ebling Mis');
        expect(reason.detail).not.toContain('undefined');
    });

    it('reads the same when the viewer was the one who played the comparison', () => {
        const reason = eliminationReason(
            eliminated({
                log: [
                    { kind: 'PLAY', turn: 3, actorId: 'p1', cardId: 'magnifico' },
                    { kind: 'COMPARE', turn: 3, actorId: 'p1', targetId: 'p2', result: 'actor-eliminated' },
                    { kind: 'ELIMINATED', turn: 3, playerId: 'p1', cause: 'baron' }
                ],
                ownDiscard: [{ cardId: 'informant', value: 1 }],
                revealed: [{ subjectId: 'p2', cardTypeId: 'mule' }]
            }),
            nameOf
        )!;

        expect(reason.detail).toContain('Bayta');
        expect(reason.detail).toContain('8 · The Mule');
    });
});

describe('a correct guess', () => {
    it('names the value guessed and the card it caught', () => {
        const reason = eliminationReason(
            eliminated({
                log: [
                    { kind: 'PLAY', turn: 2, actorId: 'p2', cardId: 'informant' },
                    { kind: 'GUESS', turn: 2, actorId: 'p2', targetId: 'p1', guessedValue: 3, hit: true },
                    { kind: 'ELIMINATED', turn: 2, playerId: 'p1', cause: 'guard' }
                ],
                ownDiscard: [{ cardId: 'ebling-mis', value: 3 }]
            }),
            nameOf
        )!;

        expect(reason.detail).toContain('Bayta');
        expect(reason.detail).toContain('3');
        expect(reason.detail).toContain('Ebling Mis');
    });
});

describe('The Mule', () => {
    it('is plain about a Mule the viewer played themselves', () => {
        const reason = eliminationReason(
            eliminated({
                log: [
                    { kind: 'PLAY', turn: 4, actorId: 'p1', cardId: 'mule' },
                    { kind: 'ELIMINATED', turn: 4, playerId: 'p1', cause: 'mule-voluntary' }
                ],
                ownDiscard: [{ cardId: 'mule', value: 8 }]
            }),
            nameOf
        )!;

        expect(reason.detail).toContain('The Mule');
        expect(reason.detail).not.toContain('Bayta');
    });

    it('names who forced it when the viewer did not choose', () => {
        const reason = eliminationReason(
            eliminated({
                log: [
                    { kind: 'PLAY', turn: 4, actorId: 'p2', cardId: 'bayta-darell' },
                    { kind: 'ELIMINATED', turn: 4, playerId: 'p1', cause: 'mule-forced' }
                ],
                ownDiscard: [{ cardId: 'mule', value: 8 }]
            }),
            nameOf
        )!;

        expect(reason.detail).toContain('Bayta');
        expect(reason.detail).toContain('The Mule');
    });
});

describe('every case', () => {
    const CAUSES = ['guard', 'baron', 'mule-voluntary', 'mule-forced'] as const;

    it('opens by telling the viewer plainly that they are out', () => {
        for (const cause of CAUSES) {
            const reason = eliminationReason(
                eliminated({
                    log: [
                        { kind: 'PLAY', turn: 1, actorId: 'p2', cardId: 'informant' },
                        { kind: 'ELIMINATED', turn: 1, playerId: 'p1', cause }
                    ],
                    ownDiscard: [{ cardId: 'ebling-mis', value: 3 }]
                }),
                nameOf
            )!;

            expect(reason, cause).not.toBeNull();
            expect(reason.headline.toLowerCase(), cause).toContain('out of the round');
            expect(reason.detail.length, cause).toBeGreaterThan(0);
        }
    });

    it('never prints an undefined where a card should be', () => {
        // A player can be eliminated holding nothing at all — the four-player
        // empty-deck Prince fallback leaves an empty hand, so there is no card
        // on top of their pile to name.
        for (const cause of CAUSES) {
            const reason = eliminationReason(
                eliminated({
                    log: [
                        { kind: 'PLAY', turn: 1, actorId: 'p2', cardId: 'informant' },
                        { kind: 'ELIMINATED', turn: 1, playerId: 'p1', cause }
                    ],
                    ownDiscard: []
                }),
                nameOf
            )!;

            expect(reason.detail, cause).not.toContain('undefined');
            expect(reason.detail, cause).not.toContain('null');
        }
    });

    it('describes the most recent elimination when the viewer went out twice across rounds', () => {
        // The log is per round, so two entries for one player means the client
        // is looking at a stale concatenation — take the latest regardless.
        const reason = eliminationReason(
            eliminated({
                log: [
                    { kind: 'ELIMINATED', turn: 1, playerId: 'p1', cause: 'guard' },
                    { kind: 'PLAY', turn: 4, actorId: 'p1', cardId: 'mule' },
                    { kind: 'ELIMINATED', turn: 4, playerId: 'p1', cause: 'mule-voluntary' }
                ],
                ownDiscard: [{ cardId: 'mule', value: 8 }]
            }),
            nameOf
        )!;

        expect(reason.detail).toContain('The Mule');
    });
});
