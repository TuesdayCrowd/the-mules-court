/**
 * Chat validation and every string a player reads in the transcript.
 *
 * Shaped after `content/nickname.ts` for the same reason it exists: the server
 * refuses a bad message by failing the whole frame, so a client that did not
 * check first would spend a `MALFORMED` to learn what it could have known in
 * the field. This is the client's single source for the rule — the surface and
 * the store both come here.
 */

import { DEFAULT_CONFIG } from '../../server/config';
import type { ChatEntry, ChatNoteCode } from '../../server/protocol';

/**
 * The server's own limit, imported rather than retyped.
 *
 * The second deliberate exception to "types only, never server runtime", and
 * argued exactly as `nickname.ts`'s is: `config.ts` has zero imports and
 * touches neither Bun nor `process`, so it is a plain literal that bundles to a
 * few bytes — and the alternative is a second number that drifts into the
 * client sending precisely what the server refuses.
 */
export const MAX_CHAT_LENGTH = DEFAULT_CONFIG.maxChatLength;

export type ChatProblem = 'empty' | 'too-long' | 'unsupported-char';

export type ChatResult = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly problem: ChatProblem };

/** Printable ASCII, mirroring `protocol.ts`'s `parseChatText` bound for bound. */
const PRINTABLE_MIN = 0x20;
const PRINTABLE_MAX = 0x7e;

function isPrintableAscii(value: string): boolean {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code < PRINTABLE_MIN || code > PRINTABLE_MAX) return false;
    }
    return true;
}

/** Trim, then the same three refusals the server makes, in the same order. */
export function validateChatText(raw: string): ChatResult {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return { ok: false, problem: 'empty' };
    if (trimmed.length > MAX_CHAT_LENGTH) return { ok: false, problem: 'too-long' };
    if (!isPrintableAscii(trimmed)) return { ok: false, problem: 'unsupported-char' };
    return { ok: true, value: trimmed };
}

const PROBLEMS: Readonly<Record<ChatProblem, string>> = {
    empty: 'Type something first.',
    // Interpolated, never written out: the number is the server's and it moves.
    'too-long': `Keep it to ${MAX_CHAT_LENGTH} characters or fewer.`,
    'unsupported-char': 'Plain letters, numbers and symbols only — no emoji or accents.'
};

/** Guidance for the composer, phrased as what to do rather than what went wrong. */
export function chatProblemMessage(problem: ChatProblem): string {
    return PROBLEMS[problem];
}

const NOTES: Readonly<Record<ChatNoteCode, string>> = {
    // States the restart, not the loss: a rebuilt room cannot know whether
    // there was anything to lose, and claiming otherwise would be a guess.
    RESTARTED: 'The court restarted. Anything said before this point is gone.',
    TRIMMED: 'Older messages were dropped to keep this conversation a manageable size.'
};

export function chatNoteMessage(code: ChatNoteCode): string {
    return NOTES[code];
}

/**
 * Who said it.
 *
 * The nickname travels on the entry, so this never consults the live seat
 * table — the whole point being that the live table may since have handed that
 * seat to somebody else. `null` still has to render as something, because the
 * host seat is minted with no name at all.
 */
export function chatSenderLabel(entry: ChatEntry & { readonly kind: 'said' }): string {
    if (entry.nickname !== null) return entry.nickname;
    return `Seat ${Number(entry.from.slice(1))}`;
}

export const CHAT_PANEL_TITLE = 'Table talk';
export const CHAT_PLACEHOLDER = 'Say something';
export const CHAT_EMPTY_STATE = 'Nothing said yet.';
export const CHAT_SEND_LABEL = 'Send';
/** The frame never left. Distinct from a `ChatProblem`: the text itself was fine. */
export const CHAT_SEND_FAILED = 'Not connected — that did not go out.';

/**
 * The launcher's accessible name, carrying the count in words.
 *
 * The badge is a number in a circle, which a screen reader announces as a bare
 * digit beside a button called "Chat" — two facts a sighted player reads as one.
 * Saying it in the name is what makes them one fact for everybody.
 */
export function chatLauncherLabel(unread: number): string {
    if (unread === 0) return 'Chat';
    return `Chat, ${unread} unread message${unread === 1 ? '' : 's'}`;
}
