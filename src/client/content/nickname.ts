/**
 * Nickname validation, client-side (UIX §3).
 *
 * The point is that `MALFORMED` never round-trips: an invalid nickname fails the
 * *whole* frame, so a name the server refuses costs the seat rather than merely
 * the name. Validating here means the player is told in the field, before
 * anything is sent.
 *
 * This is the client's single source for the rule. `store/socket.ts` uses it for
 * the RESUME_SEAT handshake, and `ui/joinScreen.ts` and `ui/menuScreen.ts` use it
 * for their fields, so there is one definition rather than three that agree
 * today.
 */

import { DEFAULT_CONFIG } from '../../server/config';

/**
 * The server's own limit, imported rather than retyped.
 *
 * A deliberate exception to "types only, never server runtime": `config.ts` has
 * zero imports and touches neither Bun nor `process`, so it is a plain literal
 * that bundles to a few bytes — and the alternative is a second number that can
 * drift into the client sending exactly what the server refuses.
 */
export const MAX_NICKNAME_LENGTH = DEFAULT_CONFIG.maxNicknameLength;

export type NicknameProblem = 'empty' | 'too-long' | 'control-char';

export type NicknameResult = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly problem: NicknameProblem };

/** True for any C0 control character or DEL, mirroring `protocol.ts`'s `hasControlChar`. */
function hasControlChar(value: string): boolean {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code <= 0x1f || code === 0x7f) return true;
    }
    return false;
}

/**
 * Trim, then the same three refusals `parseNickname` makes, in the same order.
 *
 * Length is measured *after* trimming, exactly as the server does, so trailing
 * whitespace never costs a name that would otherwise fit. `nickname.test.ts`
 * drives both this and `parseClientMessage` with the same candidates rather than
 * restating the rules, so agreement is proven instead of asserted.
 */
export function validateNickname(raw: string): NicknameResult {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return { ok: false, problem: 'empty' };
    if (trimmed.length > MAX_NICKNAME_LENGTH) return { ok: false, problem: 'too-long' };
    if (hasControlChar(trimmed)) return { ok: false, problem: 'control-char' };
    return { ok: true, value: trimmed };
}

const MESSAGES: Readonly<Record<NicknameProblem, string>> = {
    empty: 'Pick a name so the others know who you are.',
    // Interpolated, never written out: the number is the server's and it moves.
    'too-long': `Keep it to ${MAX_NICKNAME_LENGTH} characters or fewer.`,
    'control-char': 'Letters, numbers, and symbols only — no hidden characters.'
};

/** Guidance for the field, phrased as what to do rather than what went wrong. */
export function nicknameProblemMessage(problem: NicknameProblem): string {
    return MESSAGES[problem];
}
