import { describe, expect, it } from 'bun:test';
import { DEFAULT_CONFIG, makeConfig } from '../config';

describe('makeConfig', () => {
    it('returns the defaults when called with no overrides', () => {
        expect(makeConfig()).toEqual(DEFAULT_CONFIG);
    });

    it('overrides one field and leaves every other field at its default', () => {
        const config = makeConfig({ revealWindowMs: 20 });
        expect(config.revealWindowMs).toBe(20);
        expect(config).toEqual({ ...DEFAULT_CONFIG, revealWindowMs: 20 });
    });
});
