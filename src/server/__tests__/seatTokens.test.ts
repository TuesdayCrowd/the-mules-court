import { describe, expect, it } from 'bun:test';
import { hashToken, mintMatchId, mintSeed, mintToken, tokenMatches } from '../seatTokens';

const HEX_128_RE = /^[0-9a-f]{32}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** Shared shape assertions for the three 128-bit minters (Design §4, §9, §13). */
function describeMinter(name: string, mint: () => string): void {
    describe(name, () => {
        it('mints 32 lowercase hex characters', () => {
            expect(mint()).toMatch(HEX_128_RE);
        });

        it('mints 1000 unique values', () => {
            const values = new Set(Array.from({ length: 1000 }, () => mint()));
            expect(values.size).toBe(1000);
        });
    });
}

describeMinter('mintToken', mintToken);
describeMinter('mintMatchId', mintMatchId);
describeMinter('mintSeed', mintSeed);

describe('hashToken', () => {
    it('returns 64 lowercase hex characters', () => {
        expect(hashToken(mintToken())).toMatch(SHA256_HEX_RE);
    });

    it('is stable for the same input', () => {
        const token = mintToken();
        expect(hashToken(token)).toBe(hashToken(token));
    });

    it('differs for different inputs', () => {
        expect(hashToken(mintToken())).not.toBe(hashToken(mintToken()));
    });
});

describe('tokenMatches', () => {
    it('is true for a token against its own hash', () => {
        const token = mintToken();
        expect(tokenMatches(token, hashToken(token))).toBe(true);
    });

    it('is false for a different token', () => {
        const token = mintToken();
        const other = mintToken();
        expect(tokenMatches(other, hashToken(token))).toBe(false);
    });

    it('is false for an empty presented token', () => {
        const token = mintToken();
        expect(tokenMatches('', hashToken(token))).toBe(false);
    });

    it('does not throw and returns false for odd-length garbage input', () => {
        const token = mintToken();
        expect(() => tokenMatches('abc', hashToken(token))).not.toThrow();
        expect(tokenMatches('abc', hashToken(token))).toBe(false);
    });

    it('does not throw and returns false for non-hex garbage input', () => {
        const token = mintToken();
        expect(() => tokenMatches('not-hex-at-all!!', hashToken(token))).not.toThrow();
        expect(tokenMatches('not-hex-at-all!!', hashToken(token))).toBe(false);
    });

    it('does not throw and returns false for very long garbage input', () => {
        const token = mintToken();
        const long = 'z'.repeat(4097);
        expect(() => tokenMatches(long, hashToken(token))).not.toThrow();
        expect(tokenMatches(long, hashToken(token))).toBe(false);
    });
});
