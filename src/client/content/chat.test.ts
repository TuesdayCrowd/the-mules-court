import { describe, expect, it } from 'vitest';
import { parseClientMessage } from '../../server/protocol';
import {
    MAX_CHAT_LENGTH,
    chatLauncherLabel,
    chatNoteMessage,
    chatProblemMessage,
    chatSenderLabel,
    validateChatText
} from './chat';

/** The same candidate through both halves, so agreement is proven rather than asserted. */
function serverAccepts(text: string): boolean {
    return parseClientMessage(
        JSON.stringify({ type: 'SEND_CHAT', matchId: 'K7QX2', text }),
        { maxNickname: 24, maxChat: MAX_CHAT_LENGTH }
    ).ok;
}

describe('validateChatText', () => {
    const CANDIDATES: readonly string[] = [
        'hello',
        '  padded  ',
        '',
        '    ',
        'a'.repeat(MAX_CHAT_LENGTH),
        'a'.repeat(MAX_CHAT_LENGTH + 1),
        'one\ntwo',
        'del',
        'em — dash',
        'emoji \u{1F600}',
        '!@#$%^&*()_+-=[]{}|;:\'",.<>/?`~'
    ];

    it.each(CANDIDATES)('agrees with the server about %j', candidate => {
        expect(validateChatText(candidate).ok).toBe(serverAccepts(candidate));
    });

    it('returns the trimmed value', () => {
        const result = validateChatText('  hi  ');
        expect(result.ok && result.value).toBe('hi');
    });

    // Captured once per call rather than inlined twice: `ChatResult` is a
    // discriminated union, so `.problem` only type-checks once `.ok === false`
    // has narrowed the *same* binding — a second call is a fresh union to
    // `tsc`, which `bunx vitest` never catches because it does not type-check.
    it('names why it refused', () => {
        const empty = validateChatText('');
        expect(empty.ok === false && empty.problem).toBe('empty');

        const tooLong = validateChatText('a'.repeat(MAX_CHAT_LENGTH + 1));
        expect(tooLong.ok === false && tooLong.problem).toBe('too-long');

        const unsupported = validateChatText('hi \u{1F600}');
        expect(unsupported.ok === false && unsupported.problem).toBe('unsupported-char');
    });
});

describe('copy', () => {
    it('interpolates the limit rather than writing it out', () => {
        expect(chatProblemMessage('too-long')).toContain(String(MAX_CHAT_LENGTH));
    });

    it('has a sentence for every note code', () => {
        expect(chatNoteMessage('RESTARTED')).not.toBe('');
        expect(chatNoteMessage('TRIMMED')).not.toBe('');
    });

    it('falls back to a seat label when a speaker has no nickname', () => {
        expect(chatSenderLabel({ kind: 'said', seq: 1, sentAt: 0, from: 'p1', nickname: null, text: 'hi' })).toBe('Seat 1');
        expect(chatSenderLabel({ kind: 'said', seq: 1, sentAt: 0, from: 'p3', nickname: 'Ana', text: 'hi' })).toBe('Ana');
    });

    it('counts unread in the launcher name, and says none when there are none', () => {
        expect(chatLauncherLabel(0)).toBe('Chat');
        expect(chatLauncherLabel(1)).toBe('Chat, 1 unread message');
        expect(chatLauncherLabel(4)).toBe('Chat, 4 unread messages');
    });
});
