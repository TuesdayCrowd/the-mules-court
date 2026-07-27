import { describe, expect, it } from 'vitest';
import { browserIdMinter, createIdMinter } from './ids';

const MAX_CLIENT_MSG_ID = 64; // protocol.ts's isClientMsgId

describe('createIdMinter without crypto.randomUUID', () => {
    // The case that actually shipped broken: over http:// on a LAN address,
    // crypto.randomUUID is undefined and calling it threw inside a click
    // handler, which read from the outside as the Play button doing nothing.
    const minter = () => createIdMinter({ now: () => 1_700_000_000_000, random: () => 0.5 });

    it('mints an id at all', () => {
        expect(minter()().length).toBeGreaterThan(0);
    });

    it('never repeats within a session, even on a frozen clock', () => {
        const mint = minter();
        const ids = Array.from({ length: 1000 }, () => mint());
        expect(new Set(ids).size).toBe(1000);
    });

    it('stays inside the protocol cap', () => {
        const mint = minter();
        for (let i = 0; i < 1000; i++) expect(mint().length).toBeLessThanOrEqual(MAX_CLIENT_MSG_ID);
    });

    it('separates two tabs minting at the same instant', () => {
        const a = createIdMinter({ now: () => 1_700_000_000_000, random: () => 0.25 })();
        const b = createIdMinter({ now: () => 1_700_000_000_000, random: () => 0.75 })();
        expect(a).not.toBe(b);
    });
});

describe('createIdMinter with crypto.randomUUID', () => {
    it('uses it when the context provides one', () => {
        const mint = createIdMinter({ now: () => 0, random: () => 0, uuid: () => 'from-crypto' });
        expect(mint()).toBe('from-crypto');
    });
});

describe('browserIdMinter', () => {
    it('prefers randomUUID where it exists', () => {
        expect(browserIdMinter({ randomUUID: () => 'uuid-value' })()).toBe('uuid-value');
    });

    it('falls back when crypto has no randomUUID — the insecure-context case', () => {
        expect(browserIdMinter({})()).not.toBe('');
    });

    it('falls back when there is no crypto at all', () => {
        expect(browserIdMinter(undefined)()).not.toBe('');
    });

    it('calls randomUUID on crypto, not bare', () => {
        // Reading the method off and calling it loose loses `this`, which some
        // engines reject outright.
        const cryptoLike = {
            marker: 'ok',
            randomUUID(this: { marker: string }) {
                return this.marker;
            }
        };
        expect(browserIdMinter(cryptoLike)()).toBe('ok');
    });

    it('still respects the protocol cap on the fallback path', () => {
        const mint = browserIdMinter({});
        for (let i = 0; i < 200; i++) expect(mint().length).toBeLessThanOrEqual(MAX_CLIENT_MSG_ID);
    });
});
