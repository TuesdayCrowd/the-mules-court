import { describe, expect, it } from 'vitest';
import type { PlayerId, PublicLogEntry } from '../../game/engine';
import { PERSONAL_NOTICE_MS, personalNotice } from './personalNotice';

const ME: PlayerId = 'p1';
const THEM: PlayerId = 'p2';
const nameOf = (id: PlayerId) => (id === 'p1' ? 'you-seat' : 'Han Pritcher');

/** Every entry kind, so the exhaustiveness of the switch is exercised rather than assumed. */
const EVERY_KIND: PublicLogEntry[] = [
    { kind: 'PLAY', turn: 1, actorId: THEM, cardId: 'informant' },
    { kind: 'GUESS', turn: 1, actorId: THEM, targetId: ME, guessedValue: 4, hit: false },
    { kind: 'COMPARE', turn: 1, actorId: THEM, targetId: ME, result: 'tie' },
    { kind: 'PEEKED', turn: 1, actorId: THEM, targetId: ME },
    { kind: 'PROTECTED', turn: 1, actorId: THEM },
    { kind: 'TRADED', turn: 1, actorId: THEM, targetId: ME },
    { kind: 'REDREW', turn: 1, actorId: THEM, targetId: ME, drewFrom: 'deck' },
    { kind: 'FIZZLE', turn: 1, actorId: THEM, cardId: 'informant' }
];

describe('what a card did to you', () => {
    it('answers every entry kind without throwing', () => {
        for (const entry of EVERY_KIND) {
            expect(() => personalNotice(entry, ME, nameOf)).not.toThrow();
        }
    });

    it('never says your own nickname back at you', () => {
        for (const entry of EVERY_KIND) {
            expect(personalNotice(entry, ME, nameOf) ?? '').not.toContain('you-seat');
        }
    });

    it('speaks in the second person whenever it speaks at all', () => {
        const spoken = EVERY_KIND.map(entry => personalNotice(entry, ME, nameOf)).filter(
            (line): line is string => line !== null
        );
        expect(spoken.length).toBeGreaterThan(0);
        for (const line of spoken) expect(line).toMatch(/\byou\b|\byour\b/i);
    });

    /** The reported case: targeted by a value-5 and left guessing. */
    it('names who made you discard, and what you got back', () => {
        const redrew = (drewFrom: 'deck' | 'set-aside' | 'none'): string | null =>
            personalNotice({ kind: 'REDREW', turn: 1, actorId: THEM, targetId: ME, drewFrom }, ME, nameOf);

        expect(redrew('deck')).toBe('Han Pritcher made you discard your hand. You drew a new card.');
        expect(redrew('set-aside')).toBe('Han Pritcher made you discard your hand. You drew the set-aside card.');
        expect(redrew('none')).toBe('Han Pritcher made you discard your hand. The deck was empty.');
    });

    it('tells you when your hand was read, and when it was traded away', () => {
        expect(personalNotice({ kind: 'PEEKED', turn: 1, actorId: THEM, targetId: ME }, ME, nameOf)).toBe(
            'Han Pritcher looked at your hand.'
        );
        expect(personalNotice({ kind: 'TRADED', turn: 1, actorId: THEM, targetId: ME }, ME, nameOf)).toBe(
            'Han Pritcher traded hands with you.'
        );
    });

    it('tells you about a guess that missed, without naming what you hold', () => {
        const line = personalNotice(
            { kind: 'GUESS', turn: 1, actorId: THEM, targetId: ME, guessedValue: 4, hit: false },
            ME,
            nameOf
        );
        expect(line).toBe('Han Pritcher guessed you held a 4. They were wrong.');
    });

    it('says nothing about events aimed at somebody else', () => {
        const other: PlayerId = 'p3';
        for (const entry of EVERY_KIND) {
            expect(personalNotice(entry, other, nameOf)).toBeNull();
        }
    });

    it('says nothing about a card you played on yourself', () => {
        expect(
            personalNotice({ kind: 'REDREW', turn: 1, actorId: ME, targetId: ME, drewFrom: 'deck' }, ME, nameOf)
        ).toBeNull();
    });

    /**
     * The division of labour with `eliminationNotice.ts`: going out has a
     * dedicated, dismissible surface, and a three-second toast racing it would
     * be two answers to one question — the worse one being the one that goes away.
     */
    describe('leaves elimination to the surface built for it', () => {
        it('stays quiet on a guess that hit', () => {
            expect(
                personalNotice(
                    { kind: 'GUESS', turn: 1, actorId: THEM, targetId: ME, guessedValue: 4, hit: true },
                    ME,
                    nameOf
                )
            ).toBeNull();
        });

        it('stays quiet on a comparison that put you out', () => {
            expect(
                personalNotice(
                    { kind: 'COMPARE', turn: 1, actorId: THEM, targetId: ME, result: 'target-eliminated' },
                    ME,
                    nameOf
                )
            ).toBeNull();
        });

        it('still speaks for a comparison you survived', () => {
            expect(
                personalNotice({ kind: 'COMPARE', turn: 1, actorId: THEM, targetId: ME, result: 'tie' }, ME, nameOf)
            ).toBe('Han Pritcher compared hands with you. A tie — you both stay in.');
            expect(
                personalNotice(
                    { kind: 'COMPARE', turn: 1, actorId: THEM, targetId: ME, result: 'actor-eliminated' },
                    ME,
                    nameOf
                )
            ).toBe('Han Pritcher compared hands with you and is out.');
        });
    });

    it('stays up for the three seconds that were asked for, and less time than commentary', () => {
        expect(PERSONAL_NOTICE_MS).toBe(3000);
    });
});
