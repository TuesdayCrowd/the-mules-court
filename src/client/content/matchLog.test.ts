import { describe, expect, it } from 'vitest';
import type { CompletedRound, PublicLogEntry, RedactedView } from '../../game/engine';
import { makeView } from '../store/__fixtures__/view';
import { EMPTY_MATCH_LOG, matchLogIsEmpty, matchLogSections } from './matchLog';

const nameOf = (id: string) => ({ p1: 'Ana', p2: 'Bayta', p3: 'Toran' })[id] ?? id;

const PLAY: PublicLogEntry = { kind: 'PLAY', turn: 1, actorId: 'p1', cardId: 'informant' };
const TRADE: PublicLogEntry = { kind: 'TRADED', turn: 2, actorId: 'p2', targetId: 'p1' };

function finished(overrides: Partial<CompletedRound> = {}): CompletedRound {
    return {
        roundNumber: 1,
        reason: 'last-survivor',
        winnerIds: ['p1'],
        publicLog: [PLAY],
        ...overrides
    };
}

function viewWith(history: CompletedRound[], live: PublicLogEntry[] = []): RedactedView {
    return makeView({ roundHistory: history, publicLog: live });
}

describe('an empty match', () => {
    it('has no sections at all', () => {
        expect(matchLogSections(viewWith([]), nameOf)).toEqual([]);
    });

    it('says so, rather than showing an empty round heading', () => {
        expect(matchLogIsEmpty(viewWith([]))).toBe(true);
        expect(EMPTY_MATCH_LOG.length).toBeGreaterThan(0);
    });

    it('is not empty once the round in progress has a single line', () => {
        expect(matchLogIsEmpty(viewWith([], [PLAY]))).toBe(false);
    });
});

describe('the round in progress', () => {
    it('appears last, so a new line lands where the eye already is', () => {
        const sections = matchLogSections(viewWith([finished()], [TRADE]), nameOf);

        expect(sections).toHaveLength(2);
        expect(sections[1].current).toBe(true);
        expect(sections[1].lines).toEqual(['Bayta traded hands with Ana.']);
    });

    it('is numbered from the rounds already behind it', () => {
        const sections = matchLogSections(
            viewWith([finished({ roundNumber: 1 }), finished({ roundNumber: 2 })], [PLAY]),
            nameOf
        );

        expect(sections[2].roundNumber).toBe(3);
        expect(sections[2].heading).toContain('Round 3');
        expect(sections[2].heading).toContain('in progress');
    });

    it('is omitted while nothing has happened in it yet', () => {
        // A heading with nothing under it is indistinguishable from a round that
        // genuinely produced no events.
        const sections = matchLogSections(viewWith([finished()], []), nameOf);
        expect(sections).toHaveLength(1);
        expect(sections[0].current).toBe(false);
    });
});

describe('a round already finished', () => {
    it('keeps its narration, which the engine would otherwise have discarded', () => {
        const sections = matchLogSections(viewWith([finished({ publicLog: [PLAY, TRADE] })]), nameOf);

        expect(sections[0].lines).toEqual([
            'Ana played Informant.',
            'Bayta traded hands with Ana.'
        ]);
    });

    it('names who took it in the heading', () => {
        const sections = matchLogSections(viewWith([finished({ winnerIds: ['p2'] })]), nameOf);
        expect(sections[0].heading).toBe('Round 1 — Bayta took it');
    });

    it('names both winners on a shared round', () => {
        const sections = matchLogSections(viewWith([finished({ winnerIds: ['p1', 'p3'] })]), nameOf);
        expect(sections[0].heading).toBe('Round 1 — Ana and Toran took it');
    });

    it('carries its winners as ids too, so a devotion token can point at a round', () => {
        const sections = matchLogSections(viewWith([finished({ winnerIds: ['p3'] })]), nameOf);
        expect(sections[0].winnerIds).toEqual(['p3']);
    });

    it('falls back to a bare heading if a round somehow recorded no winner', () => {
        const sections = matchLogSections(viewWith([finished({ winnerIds: [] })]), nameOf);
        expect(sections[0].heading).toBe('Round 1');
    });
});

describe('several rounds', () => {
    it('reads oldest first', () => {
        const sections = matchLogSections(
            viewWith([
                finished({ roundNumber: 1, winnerIds: ['p1'] }),
                finished({ roundNumber: 2, winnerIds: ['p2'] }),
                finished({ roundNumber: 3, winnerIds: ['p1'] })
            ]),
            nameOf
        );

        expect(sections.map(section => section.roundNumber)).toEqual([1, 2, 3]);
    });

    it('keeps each round’s lines under its own heading rather than one flat stream', () => {
        // Flattened, "Ana takes the round" would sit directly above an unrelated
        // opening play with nothing to mark the boundary.
        const sections = matchLogSections(
            viewWith([finished({ roundNumber: 1, publicLog: [PLAY] }), finished({ roundNumber: 2, publicLog: [TRADE] })]),
            nameOf
        );

        expect(sections[0].lines).toHaveLength(1);
        expect(sections[1].lines).toHaveLength(1);
        expect(sections[0].lines[0]).not.toBe(sections[1].lines[0]);
    });
});
