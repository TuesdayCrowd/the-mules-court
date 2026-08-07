import { describe, expect, it } from 'vitest';
import type { PresentationEvent } from '../store/diff';
import { announcementFor, announcementForViewer } from './announce';

const nameOf = (id: string) => ({ p1: 'Ana', p2: 'Bayta', p3: 'Toran' })[id] ?? id;

/** Every kind `diffSnapshots` can produce. */
const EVERY_KIND: PresentationEvent[] = [
    { kind: 'log', entry: { kind: 'PLAY', turn: 1, actorId: 'p1', cardId: 'mayor-indbur' } },
    { kind: 'peek-gained', subjectId: 'p2', cardTypeId: 'mule' },
    { kind: 'peek-lost', subjectId: 'p2' },
    { kind: 'card-drawn', seatId: 'p1', cardTypeId: 'mule' },
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

    it('stays deliberately silent for a drawn card, which happens every single turn', () => {
        expect(announcementFor(EVERY_KIND[3], nameOf)).toBeNull();
    });

    it('stays deliberately silent for round-over, which the overlay already renders', () => {
        expect(announcementFor(EVERY_KIND[4], nameOf)).toBeNull();
    });

    it('handles every kind the diff can emit', () => {
        // The point of the module. A beat computed and then dropped is what made
        // the private peek do nothing visible at all; `never` in the default
        // case turns the next omission into a compile error rather than silence.
        for (const event of EVERY_KIND) {
            expect(() => announcementFor(event, nameOf), event.kind).not.toThrow();
        }
        expect(new Set(EVERY_KIND.map(e => e.kind)).size).toBe(5);
    });

    it('resolves seats through the supplied names, never raw ids', () => {
        expect(announcementFor(EVERY_KIND[1], nameOf)).not.toContain('p2');
    });

    it('falls back to the id when a seat has no nickname yet', () => {
        expect(announcementFor(EVERY_KIND[1], id => id)).toContain('p2');
    });
});

/**
 * The channel, which used to be a ternary in `main.ts` and so was tested by
 * nobody. Every assertion below is one a person previously had to make by
 * sitting at a real table and watching whether a toast appeared.
 */
describe('announcementForViewer', () => {
    const guess = (actorId: string, targetId: string, hit = false): PresentationEvent => ({
        kind: 'log',
        entry: { kind: 'GUESS', turn: 1, actorId, targetId, guessedValue: 3, hit }
    });

    // p3 is the viewer throughout: a fourth seat watching p1 guess at p2.
    const VIEWER = 'p3';

    it('paints a guess between two other seats, which is the whole point', () => {
        expect(announcementForViewer(guess('p1', 'p2'), VIEWER, nameOf)).toEqual({
            line: 'Ana guessed 3 against Bayta — missed.',
            kind: 'table'
        });
    });

    it('paints a hit between two other seats too — a named value is public either way', () => {
        expect(announcementForViewer(guess('p1', 'p2', true), VIEWER, nameOf)?.kind).toBe('table');
    });

    it('speaks the same words it paints, so the two channels cannot tell two stories', () => {
        const event = guess('p1', 'p2');
        expect(announcementForViewer(event, VIEWER, nameOf)?.line).toBe(announcementFor(event, nameOf));
    });

    it('tells the target in the second person instead, and only once', () => {
        // `personal` outranking `table` is the guarantee that one event never
        // produces two toasts in two grammatical persons.
        const seen = announcementForViewer(guess('p1', 'p2'), 'p2', nameOf);
        expect(seen).toEqual({ line: 'Ana guessed you held a 3. They were wrong.', kind: 'personal' });
    });

    it('does not paint a player their own guess back at them', () => {
        expect(announcementForViewer(guess('p1', 'p2'), 'p1', nameOf)?.kind).toBe('narration');
    });

    it('leaves every other third-person line clipped', () => {
        // The narration channel stays deliberately unpainted; promoting a guess
        // is one carve-out, not the start of drawing the running commentary.
        expect(announcementForViewer(EVERY_KIND[0], VIEWER, nameOf)).toEqual({
            line: 'Ana played Mayor Indbur.',
            kind: 'narration'
        });
    });

    it('stays silent where announcementFor is silent, rather than painting an empty line', () => {
        expect(announcementForViewer(EVERY_KIND[3], VIEWER, nameOf)).toBeNull();
        expect(announcementForViewer(EVERY_KIND[4], VIEWER, nameOf)).toBeNull();
    });

    it('never treats a non-log event as a guess', () => {
        // The `kind === 'log'` guard: a peek names a card and would be a
        // catastrophe to promote out of the private channel by accident.
        for (const event of EVERY_KIND.filter(e => e.kind !== 'log')) {
            expect(announcementForViewer(event, VIEWER, nameOf)?.kind ?? 'narration', event.kind).not.toBe('table');
        }
    });
});
