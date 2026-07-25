import { describe, expect, it } from 'vitest';
import type { PublicLogEntry } from '../../game/engine';
import { narrate } from './narration';

const nameOf = (id: string) => ({ p1: 'Ana', p2: 'Bayta', p3: 'Toran', p4: 'Mis' })[id] ?? id;

describe('narrate', () => {
    it('narrates a plain play', () => {
        const e: PublicLogEntry = { kind: 'PLAY', turn: 1, actorId: 'p1', cardId: 'mayor-indbur' };
        expect(narrate(e, nameOf)).toBe('Ana played Mayor Indbur.');
    });

    it('narrates a missed guess by value, never by character', () => {
        const e: PublicLogEntry = { kind: 'GUESS', turn: 2, actorId: 'p1', targetId: 'p2', guessedValue: 5, hit: false };
        const line = narrate(e, nameOf);
        expect(line).toBe('Ana guessed 5 against Bayta — missed.');
        expect(line).not.toContain('Darell'); // a miss must never name a card
    });

    it('narrates a hit guess', () => {
        const e: PublicLogEntry = { kind: 'GUESS', turn: 2, actorId: 'p1', targetId: 'p2', guessedValue: 5, hit: true };
        expect(narrate(e, nameOf)).toBe('Ana guessed 5 against Bayta — hit.');
    });

    it.each([
        ['tie', 'Ana and Bayta compared hands — a tie.'],
        ['actor-eliminated', 'Ana and Bayta compared hands — Ana is out.'],
        ['target-eliminated', 'Ana and Bayta compared hands — Bayta is out.']
    ] as const)('narrates a %s comparison', (result, expected) => {
        expect(narrate({ kind: 'COMPARE', turn: 3, actorId: 'p1', targetId: 'p2', result }, nameOf)).toBe(expected);
    });

    it('narrates protection, trades, fizzles, and round end', () => {
        expect(narrate({ kind: 'PROTECTED', turn: 4, actorId: 'p1' }, nameOf)).toBe('Ana is protected until their next turn.');
        expect(narrate({ kind: 'TRADED', turn: 5, actorId: 'p1', targetId: 'p2' }, nameOf)).toBe('Ana traded hands with Bayta.');
        expect(narrate({ kind: 'FIZZLE', turn: 7, actorId: 'p1', cardId: 'informant' }, nameOf)).toBe(
            'Ana played Informant with no legal target — no effect.'
        );
        expect(narrate({ kind: 'ROUND_END', turn: 9, reason: 'deck-out', winners: ['p1'] }, nameOf)).toBe(
            'Deck ran out — highest card wins. Ana takes the round.'
        );
    });

    it.each([
        ['deck', 'Bayta discarded their hand and drew from the deck.'],
        ['set-aside', 'Bayta discarded their hand and drew the set-aside card.'],
        ['none', 'Bayta discarded their hand — no card left to draw.']
    ] as const)('narrates a redraw from %s', (drewFrom, expected) => {
        expect(narrate({ kind: 'REDREW', turn: 6, actorId: 'p1', targetId: 'p2', drewFrom }, nameOf)).toBe(expected);
    });

    // Every elimination cause gets its own line. The engine always emits
    // ELIMINATED immediately after the GUESS or COMPARE that caused it, so this
    // line has to add something rather than repeat the one before it.
    it.each([
        ['guard', 'Bayta is out of the round — the guess was right.'],
        ['baron', 'Bayta is out of the round — the lower card.'],
        ['mule-voluntary', 'Bayta discarded The Mule — out of the round.'],
        ['mule-forced', 'Bayta was forced to discard The Mule — out of the round.']
    ] as const)('narrates an elimination by %s', (cause, expected) => {
        expect(narrate({ kind: 'ELIMINATED', turn: 8, playerId: 'p2', cause }, nameOf)).toBe(expected);
    });

    it('names the rule that ended the round for a last survivor', () => {
        expect(narrate({ kind: 'ROUND_END', turn: 9, reason: 'last-survivor', winners: ['p1'] }, nameOf)).toBe(
            'Everyone else is out. Ana takes the round.'
        );
    });

    it('names every co-winner on a shared round win', () => {
        expect(narrate({ kind: 'ROUND_END', turn: 9, reason: 'deck-out', winners: ['p1', 'p3'] }, nameOf)).toBe(
            'Deck ran out — highest card wins. Ana and Toran take the round.'
        );
    });

    it('names three co-winners without dropping one', () => {
        expect(narrate({ kind: 'ROUND_END', turn: 9, reason: 'deck-out', winners: ['p1', 'p2', 'p3'] }, nameOf)).toBe(
            'Deck ran out — highest card wins. Ana, Bayta and Toran take the round.'
        );
    });

    it('resolves every player through nameOf and never leaks a raw seat id', () => {
        const entries: PublicLogEntry[] = [
            { kind: 'PLAY', turn: 1, actorId: 'p1', cardId: 'mule' },
            { kind: 'GUESS', turn: 1, actorId: 'p1', targetId: 'p4', guessedValue: 3, hit: false },
            { kind: 'COMPARE', turn: 1, actorId: 'p1', targetId: 'p4', result: 'tie' },
            { kind: 'PROTECTED', turn: 1, actorId: 'p4' },
            { kind: 'TRADED', turn: 1, actorId: 'p1', targetId: 'p4' },
            { kind: 'REDREW', turn: 1, actorId: 'p1', targetId: 'p4', drewFrom: 'deck' },
            { kind: 'FIZZLE', turn: 1, actorId: 'p4', cardId: 'informant' },
            { kind: 'ELIMINATED', turn: 1, playerId: 'p4', cause: 'guard' },
            { kind: 'ROUND_END', turn: 1, reason: 'deck-out', winners: ['p4'] }
        ];
        for (const entry of entries) {
            const line = narrate(entry, nameOf);
            expect(line, entry.kind).not.toMatch(/\bp[1-4]\b/);
            expect(line.endsWith('.'), `${entry.kind} ends in a full stop`).toBe(true);
        }
    });
});
