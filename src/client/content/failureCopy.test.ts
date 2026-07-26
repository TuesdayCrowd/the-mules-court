import { describe, expect, it } from 'vitest';
import type { ErrorCode } from '../../server/protocol';
import { FAILURE_COPY, failureCopy } from './failureCopy';

/**
 * Every code in the union, listed by hand because a type has no runtime form.
 * The count test below is what keeps this list from drifting out of date, and
 * the `satisfies` annotation on the map is what makes a NEW code a compile error.
 */
const ALL_CODES: ErrorCode[] = [
    'MALFORMED',
    'ROOM_NOT_FOUND',
    'SEAT_TAKEN',
    'ROOM_FULL',
    'ALREADY_SEATED',
    'BAD_TOKEN',
    'NOT_YOUR_SEAT',
    'NOT_HOST',
    'CANNOT_START',
    'PAUSED',
    'MATCH_OVER',
    'RATE_LIMITED',
    'INTERNAL',
    'ROUND_NOT_IN_PROGRESS',
    'NOT_YOUR_TURN',
    'CARD_NOT_IN_HAND',
    'FORCED_PLAY_VIOLATION',
    'TARGET_REQUIRED',
    'TARGET_NOT_ALLOWED',
    'TARGET_NOT_LEGAL',
    'GUESS_REQUIRED',
    'GUESS_NOT_ALLOWED',
    'GUESS_CANNOT_BE_INFORMANT'
];

describe('failure copy', () => {
    it('has designed copy for every protocol error code', () => {
        for (const code of ALL_CODES) {
            const copy = failureCopy(code);
            expect(copy.message.length, code).toBeGreaterThan(0);
            expect(copy.message, code).not.toMatch(/error|failed/i); // designed copy, not a status dump
        }
    });

    it('covers exactly the codes listed here and no more', () => {
        // Guards the hand-written list above: a code added to the map but not to
        // ALL_CODES escapes every other assertion in this file.
        expect(Object.keys(FAILURE_COPY).sort()).toEqual([...ALL_CODES].sort());
    });

    it('gives every code a way out, so no screen is a dead end', () => {
        for (const code of ALL_CODES) {
            expect(failureCopy(code).action.label.length, code).toBeGreaterThan(0);
        }
    });

    it('never claims to know which of a wrong link or an expired room occurred', () => {
        expect(failureCopy('ROOM_NOT_FOUND').message).toBe('That court has dissolved — the link may be old or mistyped.');
    });

    it('offers a takeover action for SEAT_TAKEN and a menu return for the rest', () => {
        expect(failureCopy('SEAT_TAKEN').action).toEqual({ kind: 'takeover', label: 'Take over here' });
        expect(failureCopy('ROOM_FULL').action).toEqual({ kind: 'menu', label: 'Back to menu' });
    });

    it('offers takeover for SEAT_TAKEN alone — it is the only code with a seat to take back', () => {
        const takeovers = ALL_CODES.filter(code => failureCopy(code).action.kind === 'takeover');
        expect(takeovers).toEqual(['SEAT_TAKEN']);
    });

    it('writes full sentences rather than shouting the code back', () => {
        for (const code of ALL_CODES) {
            const message = failureCopy(code).message;
            expect(message, code).not.toContain(code); // never the raw identifier
            expect(message.trim(), code).toMatch(/[.!?]$/);
        }
    });

    it('names a rule and never a card another player is holding', () => {
        // The engine forwards rule names precisely so this copy cannot leak a
        // hand. The Mule is the one card named, and only as the player's own.
        for (const code of ALL_CODES) {
            expect(failureCopy(code).message, code).not.toMatch(/Ebling|Magnifico|Bayta|Toran|Indbur|Pritcher|Channis/);
        }
    });

    it('derives the guess range from the engine rather than restating it', () => {
        expect(failureCopy('GUESS_CANNOT_BE_INFORMANT').message).toContain('2 to 8');
    });
});
