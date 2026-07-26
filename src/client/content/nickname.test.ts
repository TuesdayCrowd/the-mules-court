import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../server/config';
import { parseClientMessage } from '../../server/protocol';
import { MAX_NICKNAME_LENGTH, nicknameProblemMessage, validateNickname } from './nickname';

describe('MAX_NICKNAME_LENGTH', () => {
    it('is the server’s limit, not a second opinion about it', () => {
        expect(MAX_NICKNAME_LENGTH).toBe(DEFAULT_CONFIG.maxNicknameLength);
    });
});

describe('validateNickname', () => {
    it('accepts an ordinary name and returns it trimmed', () => {
        expect(validateNickname('  Ana  ')).toEqual({ ok: true, value: 'Ana' });
    });

    it('rejects an empty string', () => {
        expect(validateNickname('')).toEqual({ ok: false, problem: 'empty' });
    });

    it('rejects a name that is only whitespace', () => {
        expect(validateNickname('   \t  ')).toEqual({ ok: false, problem: 'empty' });
    });

    it('accepts exactly the maximum length', () => {
        const name = 'C'.repeat(MAX_NICKNAME_LENGTH);
        expect(validateNickname(name)).toEqual({ ok: true, value: name });
    });

    it('rejects one character past the maximum', () => {
        expect(validateNickname('C'.repeat(MAX_NICKNAME_LENGTH + 1))).toEqual({ ok: false, problem: 'too-long' });
    });

    it('measures length after trimming, so padding never costs a legal name', () => {
        const name = 'C'.repeat(MAX_NICKNAME_LENGTH);
        expect(validateNickname(`   ${name}   `)).toEqual({ ok: true, value: name });
    });

    // Written as escapes, never as literal bytes: a raw control character in
    // source is invisible in review and survives neither copy nor formatter.
    it('rejects a C0 control character', () => {
        expect(validateNickname('Ana\u0007na')).toEqual({ ok: false, problem: 'control-char' });
    });

    it('rejects DEL', () => {
        expect(validateNickname('Ana\u007Fna')).toEqual({ ok: false, problem: 'control-char' });
    });

    it('rejects an embedded newline, which a paste can easily carry in', () => {
        expect(validateNickname('Ana\nBayta')).toEqual({ ok: false, problem: 'control-char' });
    });

    it('accepts an emoji name — the server accepts any non-control character', () => {
        expect(validateNickname('\u{1F984} Mule')).toEqual({ ok: true, value: '\u{1F984} Mule' });
    });

    it('accepts a non-Latin name', () => {
        expect(validateNickname('Ана')).toEqual({ ok: true, value: 'Ана' });
    });
});

describe('agreement with the server', () => {
    /**
     * The real guarantee, not a restatement of it.
     *
     * `parseNickname` is private to `protocol.ts`, but `parseClientMessage` is
     * the door every nickname actually goes through — so driving both sides with
     * the same candidates proves the client never offers a name the server will
     * refuse, and never refuses one the server would take.
     */
    function serverAccepts(nickname: string): boolean {
        return parseClientMessage(JSON.stringify({ type: 'CLAIM_SEAT', matchId: 'K7QX2', nickname }), MAX_NICKNAME_LENGTH)
            .ok;
    }

    const CANDIDATES = [
        'Ana',
        '  Ana  ',
        '',
        '   ',
        '\t',
        'C'.repeat(MAX_NICKNAME_LENGTH),
        'C'.repeat(MAX_NICKNAME_LENGTH + 1),
        `   ${'C'.repeat(MAX_NICKNAME_LENGTH)}   `,
        'Ana\u0007na',
        'Ana\u007Fna',
        'Ana\nBayta',
        'Ana\u0000',
        '\u{1F984} Mule',
        'Ана',
        '中文',
        'a',
        'Mayor Indbur III'
    ];

    it.each(CANDIDATES)('agrees with the server about %j', candidate => {
        expect(validateNickname(candidate).ok).toBe(serverAccepts(candidate));
    });

    it('sends the same trimmed value the server would store', () => {
        const result = validateNickname('  Bayta  ');
        expect(result.ok).toBe(true);

        const parsed = parseClientMessage(
            JSON.stringify({ type: 'CLAIM_SEAT', matchId: 'K7QX2', nickname: '  Bayta  ' }),
            MAX_NICKNAME_LENGTH
        );
        expect(parsed.ok && parsed.msg.type === 'CLAIM_SEAT' ? parsed.msg.nickname : null).toBe(
            result.ok ? result.value : null
        );
    });
});

describe('nicknameProblemMessage', () => {
    it.each(['empty', 'too-long', 'control-char'] as const)('has designed copy for %s', problem => {
        const message = nicknameProblemMessage(problem);
        expect(message.length).toBeGreaterThan(0);
        expect(message).not.toMatch(/error|invalid|failed/i); // guidance, not a status dump
    });

    it('names the actual limit rather than hard-coding a number in prose', () => {
        expect(nicknameProblemMessage('too-long')).toContain(String(MAX_NICKNAME_LENGTH));
    });
});
