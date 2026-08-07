import { describe, expect, it } from 'vitest';
import type { PlayerId, PublicLogEntry } from '../../game/engine';
import { isTableNotice } from './tableNotice';

const ME: PlayerId = 'p1';
const THEM: PlayerId = 'p2';
const OTHER: PlayerId = 'p3';

/** Every entry kind, so the boolean's narrowness to GUESS is exercised rather than assumed. */
const EVERY_KIND: PublicLogEntry[] = [
    { kind: 'PLAY', turn: 1, actorId: THEM, cardId: 'informant' },
    { kind: 'GUESS', turn: 1, actorId: THEM, targetId: OTHER, guessedValue: 4, hit: false },
    { kind: 'COMPARE', turn: 1, actorId: THEM, targetId: OTHER, result: 'tie' },
    { kind: 'PEEKED', turn: 1, actorId: THEM, targetId: OTHER },
    { kind: 'PROTECTED', turn: 1, actorId: THEM },
    { kind: 'TRADED', turn: 1, actorId: THEM, targetId: OTHER },
    { kind: 'REDREW', turn: 1, actorId: THEM, targetId: OTHER, drewFrom: 'deck' },
    { kind: 'FIZZLE', turn: 1, actorId: THEM, cardId: 'informant' },
    { kind: 'ELIMINATED', turn: 1, playerId: OTHER, cause: 'guard' },
    { kind: 'ROUND_END', turn: 1, reason: 'last-survivor', winners: [OTHER] }
];

describe('whether a log entry must be drawn to a bystander', () => {
    it('is true for a guess exchanged between two seats that are not the viewer', () => {
        expect(isTableNotice({ kind: 'GUESS', turn: 1, actorId: THEM, targetId: OTHER, guessedValue: 4, hit: false }, ME)).toBe(true);
    });

    it('is false when the viewer is the target — personalNotice already owns that line', () => {
        expect(isTableNotice({ kind: 'GUESS', turn: 1, actorId: THEM, targetId: ME, guessedValue: 4, hit: false }, ME)).toBe(false);
    });

    it('is false when the viewer is the actor — a player does not need their own guess narrated back at them', () => {
        expect(isTableNotice({ kind: 'GUESS', turn: 1, actorId: ME, targetId: OTHER, guessedValue: 4, hit: false }, ME)).toBe(false);
    });

    it('is true whether the guess hit or missed — the guessed value is public information either way', () => {
        const hit: PublicLogEntry = { kind: 'GUESS', turn: 1, actorId: THEM, targetId: OTHER, guessedValue: 4, hit: true };
        const miss: PublicLogEntry = { kind: 'GUESS', turn: 1, actorId: THEM, targetId: OTHER, guessedValue: 4, hit: false };
        expect(isTableNotice(hit, ME)).toBe(true);
        expect(isTableNotice(miss, ME)).toBe(true);
    });

    it('is false for every log kind other than GUESS, whoever it concerns', () => {
        for (const entry of EVERY_KIND) {
            if (entry.kind === 'GUESS') continue;
            expect(isTableNotice(entry, ME)).toBe(false);
        }
    });
});
