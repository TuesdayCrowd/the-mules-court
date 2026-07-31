import { describe, expect, it } from 'bun:test';
import { COMPRESSIBLE_FLOOR_BYTES, acceptsGzip, compressibleType, shouldCompress } from '../compression';

describe('acceptsGzip', () => {
    it('accepts the header browsers actually send', () => {
        expect(acceptsGzip('gzip, deflate, br, zstd')).toBe(true);
    });

    it('refuses a missing header, because a client that did not ask cannot be assumed to cope', () => {
        expect(acceptsGzip(null)).toBe(false);
        expect(acceptsGzip('')).toBe(false);
    });

    it('refuses an encoding list that names every codec but gzip', () => {
        expect(acceptsGzip('br, zstd, deflate')).toBe(false);
    });

    it('reads gzip as a whole token, not a substring', () => {
        // The bug this pins: `includes('gzip')` matches 'notgzip' and
        // 'x-gzip-ish', and an encoding nobody implements is not gzip.
        expect(acceptsGzip('notgzip')).toBe(false);
        expect(acceptsGzip('gzipper')).toBe(false);
    });

    it('ignores case and quality values, both of which are legal in the header', () => {
        expect(acceptsGzip('GZIP;q=1.0')).toBe(true);
        expect(acceptsGzip('deflate;q=0.5, gzip;q=0.9')).toBe(true);
    });

    it('honours an explicit refusal, which is what q=0 means', () => {
        expect(acceptsGzip('gzip;q=0')).toBe(false);
        expect(acceptsGzip('gzip;q=0.0')).toBe(false);
    });
});

describe('compressibleType', () => {
    it('compresses the three types that carry this app', () => {
        expect(compressibleType('text/javascript;charset=utf-8')).toBe(true);
        expect(compressibleType('text/css;charset=utf-8')).toBe(true);
        expect(compressibleType('text/html;charset=utf-8')).toBe(true);
    });

    it('compresses svg, which is markup wearing an image content-type', () => {
        expect(compressibleType('image/svg+xml')).toBe(true);
    });

    it('refuses the formats that are already compressed', () => {
        // 8.1 MB of public/assets is exactly this. Gzipping a PNG spends CPU to
        // make the response very slightly larger.
        expect(compressibleType('image/png')).toBe(false);
        expect(compressibleType('image/jpeg')).toBe(false);
        expect(compressibleType('font/woff2')).toBe(false);
    });

    it('refuses an absent content-type rather than guessing', () => {
        expect(compressibleType(null)).toBe(false);
        expect(compressibleType('')).toBe(false);
    });
});

describe('shouldCompress', () => {
    const js = 'text/javascript;charset=utf-8';

    it('compresses a real asset for a real browser', () => {
        expect(shouldCompress('gzip, deflate', js, 81_339)).toBe(true);
    });

    it('refuses when the client did not ask', () => {
        expect(shouldCompress(null, js, 81_339)).toBe(false);
    });

    it('refuses a body below the floor, where the gzip header costs more than it saves', () => {
        expect(shouldCompress('gzip', js, COMPRESSIBLE_FLOOR_BYTES - 1)).toBe(false);
        expect(shouldCompress('gzip', js, COMPRESSIBLE_FLOOR_BYTES)).toBe(true);
    });

    it('refuses an already-compressed type however large it is', () => {
        expect(shouldCompress('gzip', 'image/png', 5_000_000)).toBe(false);
    });
});
