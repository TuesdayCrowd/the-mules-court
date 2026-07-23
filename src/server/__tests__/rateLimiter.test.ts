import { describe, expect, it } from 'bun:test';
import { IpLimiter, TokenBucket } from '../rateLimiter';

describe('TokenBucket', () => {
    it('grants exactly `capacity` takes immediately, then refuses', () => {
        let t = 0;
        const now = () => t;
        const bucket = new TokenBucket(10, 5, now);

        for (let i = 0; i < 10; i++) {
            expect(bucket.take()).toBe(true);
        }
        expect(bucket.take()).toBe(false);
    });

    it('grants exactly one more after the clock advances 200ms at 5/s', () => {
        let t = 0;
        const now = () => t;
        const bucket = new TokenBucket(10, 5, now);

        for (let i = 0; i < 10; i++) bucket.take();
        expect(bucket.take()).toBe(false);

        t += 200; // 200ms * 5/s = 1 token
        expect(bucket.take()).toBe(true);
        expect(bucket.take()).toBe(false);
    });

    it('does not grant a token before enough time has accumulated', () => {
        let t = 0;
        const now = () => t;
        const bucket = new TokenBucket(1, 5, now);

        expect(bucket.take()).toBe(true); // spends the initial token
        t += 100; // 100ms * 5/s = 0.5 tokens — not enough
        expect(bucket.take()).toBe(false);
        t += 100; // another 0.5 tokens — 1.0 total now
        expect(bucket.take()).toBe(true);
    });

    it('never refills past capacity', () => {
        let t = 0;
        const now = () => t;
        const bucket = new TokenBucket(3, 5, now);

        t += 10_000; // huge gap — would be 50 tokens uncapped
        for (let i = 0; i < 3; i++) {
            expect(bucket.take()).toBe(true);
        }
        expect(bucket.take()).toBe(false);
    });
});

describe('IpLimiter', () => {
    it('counts each IP independently', () => {
        let t = 0;
        const now = () => t;
        const limiter = new IpLimiter(2, now);

        expect(limiter.take('1.1.1.1')).toBe(true);
        expect(limiter.take('1.1.1.1')).toBe(true);
        expect(limiter.take('1.1.1.1')).toBe(false);

        // A different IP is unaffected by the first IP's exhausted window.
        expect(limiter.take('2.2.2.2')).toBe(true);
        expect(limiter.take('2.2.2.2')).toBe(true);
        expect(limiter.take('2.2.2.2')).toBe(false);
    });

    it('resets an IP once its window has fully passed', () => {
        let t = 0;
        const now = () => t;
        const limiter = new IpLimiter(1, now);

        expect(limiter.take('1.1.1.1')).toBe(true);
        expect(limiter.take('1.1.1.1')).toBe(false);

        t += 60_000; // window fully passed
        expect(limiter.take('1.1.1.1')).toBe(true);
    });

    it('prune() forgets an IP whose window has fully passed', () => {
        let t = 0;
        const now = () => t;
        const limiter = new IpLimiter(5, now);

        limiter.take('1.1.1.1');
        expect(limiter.size).toBe(1);

        t += 60_000;
        limiter.prune();
        expect(limiter.size).toBe(0);
    });

    it('prune() leaves an IP whose window has not yet passed', () => {
        let t = 0;
        const now = () => t;
        const limiter = new IpLimiter(5, now);

        limiter.take('1.1.1.1');
        t += 30_000; // window is 60s, so this IP is still active
        limiter.prune();
        expect(limiter.size).toBe(1);
    });
});
