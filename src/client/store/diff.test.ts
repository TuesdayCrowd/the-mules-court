import { describe, expect, it } from 'vitest';
import type { PublicLogEntry, RoundResult } from '../../game/engine';
import { makeView } from './__fixtures__/view';
import { diffSnapshots } from './diff';

const PLAY: PublicLogEntry = { kind: 'PLAY', turn: 1, actorId: 'p1', cardId: 'mayor-indbur' };
const TRADED: PublicLogEntry = { kind: 'TRADED', turn: 1, actorId: 'p1', targetId: 'p2' };
const PROTECTED: PublicLogEntry = { kind: 'PROTECTED', turn: 2, actorId: 'p2' };
const ROUND_END: PublicLogEntry = { kind: 'ROUND_END', turn: 3, reason: 'last-survivor', winners: ['p1'] };

const RESULT: RoundResult = { reason: 'last-survivor', winnerIds: ['p1'] };

describe('diffSnapshots with no previous snapshot', () => {
    it('yields nothing at all — a reconnecting client rebuilds from server truth, it does not replay', () => {
        // UIX §2.1: reconnect, rotation, and window drag are one code path that
        // rebuilds. Replaying a round the player was absent for would bury them
        // in toasts for events they can already see the results of.
        const view = makeView({
            publicLog: [PLAY, TRADED, ROUND_END],
            revealed: [{ subjectId: 'p2', cardTypeId: 'mule' }],
            roundResult: RESULT
        });

        expect(diffSnapshots(null, view)).toEqual([]);
    });
});

describe('diffSnapshots on the public log', () => {
    it('yields appended entries in order', () => {
        const prev = makeView({ publicLog: [PLAY] });
        const next = makeView({ publicLog: [PLAY, TRADED, PROTECTED] });

        expect(diffSnapshots(prev, next)).toEqual([
            { kind: 'log', entry: TRADED },
            { kind: 'log', entry: PROTECTED }
        ]);
    });

    it('yields nothing when the log is unchanged', () => {
        const log = [PLAY, TRADED];
        expect(diffSnapshots(makeView({ publicLog: log }), makeView({ publicLog: log }))).toEqual([]);
    });

    it('yields the whole new log when a new round resets it, never a negative slice', () => {
        const prev = makeView({ publicLog: [PLAY, TRADED, ROUND_END] });
        const next = makeView({ publicLog: [{ kind: 'PLAY', turn: 1, actorId: 'p2', cardId: 'informant' }] });

        expect(diffSnapshots(prev, next)).toEqual([
            { kind: 'log', entry: { kind: 'PLAY', turn: 1, actorId: 'p2', cardId: 'informant' } }
        ]);
    });

    it('yields nothing when a new round resets the log to empty', () => {
        expect(diffSnapshots(makeView({ publicLog: [PLAY, ROUND_END] }), makeView({ publicLog: [] }))).toEqual([]);
    });

    it('treats a same-length log that does not continue the old one as a reset', () => {
        // Length alone would slice nothing here and silently swallow a whole
        // round's opening. The boundary entry is what proves continuity.
        const prev = makeView({ publicLog: [PLAY, TRADED, ROUND_END] });
        const fresh: PublicLogEntry[] = [
            { kind: 'PLAY', turn: 1, actorId: 'p2', cardId: 'informant' },
            { kind: 'GUESS', turn: 1, actorId: 'p2', targetId: 'p1', guessedValue: 5, hit: false },
            { kind: 'PLAY', turn: 2, actorId: 'p1', cardId: 'magnifico' }
        ];

        expect(diffSnapshots(prev, makeView({ publicLog: fresh }))).toEqual(fresh.map(entry => ({ kind: 'log', entry })));
    });

    it('yields the whole log when growth follows a reset the client never saw empty', () => {
        const prev = makeView({ publicLog: [PLAY, TRADED] });
        const fresh: PublicLogEntry[] = [
            { kind: 'PLAY', turn: 1, actorId: 'p2', cardId: 'informant' },
            { kind: 'PROTECTED', turn: 2, actorId: 'p1' },
            { kind: 'PLAY', turn: 3, actorId: 'p2', cardId: 'magnifico' }
        ];

        expect(diffSnapshots(prev, makeView({ publicLog: fresh }))).toHaveLength(3);
    });

    it('continues normally when the log grows from empty', () => {
        expect(diffSnapshots(makeView({ publicLog: [] }), makeView({ publicLog: [PLAY] }))).toEqual([
            { kind: 'log', entry: PLAY }
        ]);
    });
});

describe('diffSnapshots on peeks', () => {
    it('yields peek-gained for a newly revealed card', () => {
        const prev = makeView({ revealed: [] });
        const next = makeView({ revealed: [{ subjectId: 'p2', cardTypeId: 'mule' }] });

        expect(diffSnapshots(prev, next)).toEqual([{ kind: 'peek-gained', subjectId: 'p2', cardTypeId: 'mule' }]);
    });

    it('yields peek-lost when a peek expires server-side', () => {
        const prev = makeView({ revealed: [{ subjectId: 'p2', cardTypeId: 'mule' }] });
        const next = makeView({ revealed: [] });

        expect(diffSnapshots(prev, next)).toEqual([{ kind: 'peek-lost', subjectId: 'p2' }]);
    });

    it('yields nothing for a peek that persists', () => {
        const revealed = [{ subjectId: 'p2', cardTypeId: 'mule' }] as const;
        expect(diffSnapshots(makeView({ revealed }), makeView({ revealed }))).toEqual([]);
    });

    it('keys on the card as well as the subject, so a changed hand loses then gains', () => {
        const prev = makeView({ revealed: [{ subjectId: 'p2', cardTypeId: 'mule' }] });
        const next = makeView({ revealed: [{ subjectId: 'p2', cardTypeId: 'informant' }] });

        expect(diffSnapshots(prev, next)).toEqual([
            { kind: 'peek-lost', subjectId: 'p2' },
            { kind: 'peek-gained', subjectId: 'p2', cardTypeId: 'informant' }
        ]);
    });

    it('handles several subjects at once', () => {
        const prev = makeView({ revealed: [{ subjectId: 'p2', cardTypeId: 'mule' }] });
        const next = makeView({
            revealed: [
                { subjectId: 'p3', cardTypeId: 'bayta-darell' },
                { subjectId: 'p4', cardTypeId: 'informant' }
            ]
        });

        expect(diffSnapshots(prev, next)).toEqual([
            { kind: 'peek-lost', subjectId: 'p2' },
            { kind: 'peek-gained', subjectId: 'p3', cardTypeId: 'bayta-darell' },
            { kind: 'peek-gained', subjectId: 'p4', cardTypeId: 'informant' }
        ]);
    });
});

describe('diffSnapshots on the round result', () => {
    it('yields round-over when a result appears where there was none', () => {
        const prev = makeView({ roundResult: null });
        const next = makeView({ roundResult: RESULT });

        expect(diffSnapshots(prev, next)).toEqual([{ kind: 'round-over', result: RESULT }]);
    });

    it('yields nothing while the same result sits there across updates', () => {
        // round_over holds for a reveal window and every heartbeat re-sends it.
        expect(diffSnapshots(makeView({ roundResult: RESULT }), makeView({ roundResult: RESULT }))).toEqual([]);
    });

    it('yields nothing when a new round clears the result', () => {
        expect(diffSnapshots(makeView({ roundResult: RESULT }), makeView({ roundResult: null }))).toEqual([]);
    });
});

describe('diffSnapshots ordering', () => {
    it('runs log entries, then peeks lost, then peeks gained, then the round result', () => {
        const prev = makeView({
            publicLog: [PLAY],
            revealed: [{ subjectId: 'p2', cardTypeId: 'mule' }],
            roundResult: null
        });
        const next = makeView({
            publicLog: [PLAY, TRADED, ROUND_END],
            revealed: [{ subjectId: 'p3', cardTypeId: 'informant' }],
            roundResult: RESULT
        });

        expect(diffSnapshots(prev, next).map(event => event.kind)).toEqual([
            'log',
            'log',
            'peek-lost',
            'peek-gained',
            'round-over'
        ]);
    });
});
