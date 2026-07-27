import { describe, expect, it } from 'vitest';
import type { PresentationEvent } from '../store/diff';
import { announcementFor } from './announce';

const nameOf = (id: string) => ({ p1: 'Ana', p2: 'Bayta' })[id] ?? id;

/** Every kind `diffSnapshots` can produce. */
const EVERY_KIND: PresentationEvent[] = [
    { kind: 'log', entry: { kind: 'PLAY', turn: 1, actorId: 'p1', cardId: 'mayor-indbur' } },
    { kind: 'peek-gained', subjectId: 'p2', cardTypeId: 'mule' },
    { kind: 'peek-lost', subjectId: 'p2' },
    { kind: 'round-over', result: { reason: 'deck-out', winnerIds: ['p1'] } }
];

describe('announcementFor', () => {
    it('speaks a public log entry', () => {
        expect(announcementFor(EVERY_KIND[0], nameOf)).toBe('Ana played Mayor Indbur.');
    });

    it('speaks a peek, naming the card', () => {
        expect(announcementFor(EVERY_KIND[1], nameOf)).toContain('Bayta holds The Mule');
    });

    it('speaks a peek going stale', () => {
        expect(announcementFor(EVERY_KIND[2], nameOf)).toContain('Bayta');
    });

    it('stays deliberately silent for round-over, which the overlay already renders', () => {
        expect(announcementFor(EVERY_KIND[3], nameOf)).toBeNull();
    });

    it('handles every kind the diff can emit', () => {
        // The point of the module. A beat computed and then dropped is what made
        // the private peek do nothing visible at all; `never` in the default
        // case turns the next omission into a compile error rather than silence.
        for (const event of EVERY_KIND) {
            expect(() => announcementFor(event, nameOf), event.kind).not.toThrow();
        }
        expect(new Set(EVERY_KIND.map(e => e.kind)).size).toBe(4);
    });

    it('resolves seats through the supplied names, never raw ids', () => {
        expect(announcementFor(EVERY_KIND[1], nameOf)).not.toContain('p2');
    });

    it('falls back to the id when a seat has no nickname yet', () => {
        expect(announcementFor(EVERY_KIND[1], id => id)).toContain('p2');
    });
});
