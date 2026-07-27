import { describe, expect, it } from 'bun:test';
import { DEFAULT_CONFIG, envOverrides, makeConfig } from '../config';

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

/**
 * The four tunables a *deployment* moves, as opposed to the design constants.
 * They exist because a binary someone downloaded has different needs from this
 * repo's `serve` script: it cannot assume :3000 is free, cannot assume the
 * working directory is writable, and cannot assume the invite link it hands out
 * names the port it is actually listening on (deferred item D3).
 */
describe('envOverrides', () => {
    it('returns no overrides for an empty environment', () => {
        expect(envOverrides({})).toEqual({});
    });

    it('reads every supported variable', () => {
        expect(
            envOverrides({
                MULES_PORT: '8123',
                MULES_DB_PATH: '/var/lib/mules.sqlite',
                MULES_PUBLIC_BASE_URL: 'https://mules.example',
                MULES_STATIC_ROOT: 'dist'
            })
        ).toEqual({
            port: 8123,
            dbPath: '/var/lib/mules.sqlite',
            publicBaseUrl: 'https://mules.example',
            staticRoot: 'dist'
        });
    });

    it('derives publicBaseUrl from MULES_PORT so an invite link points at the port in use', () => {
        // D3: the default base URL names :3000. A host who moves the port and
        // says nothing about the URL means the new port, not the old one.
        expect(envOverrides({ MULES_PORT: '8123' }).publicBaseUrl).toBe('http://localhost:8123');
    });

    it('lets an explicit MULES_PUBLIC_BASE_URL win over the derived one', () => {
        const env = { MULES_PORT: '8123', MULES_PUBLIC_BASE_URL: 'https://mules.example' };
        expect(envOverrides(env).publicBaseUrl).toBe('https://mules.example');
    });

    it('strips a trailing slash so joinUrl never doubles it', () => {
        expect(envOverrides({ MULES_PUBLIC_BASE_URL: 'https://mules.example/' }).publicBaseUrl).toBe(
            'https://mules.example'
        );
    });

    it.each([
        ['zero', '0'],
        ['negative', '-1'],
        ['fractional', '80.5'],
        ['words', 'eighty'],
        ['blank', ''],
        ['out of range', '70000']
    ])('throws on a %s port rather than silently falling back to 3000', (_name, value) => {
        expect(() => envOverrides({ MULES_PORT: value })).toThrow(/MULES_PORT/);
    });

    it('feeds makeConfig to produce a complete config', () => {
        expect(makeConfig(envOverrides({ MULES_PORT: '8123' }))).toEqual({
            ...DEFAULT_CONFIG,
            port: 8123,
            publicBaseUrl: 'http://localhost:8123'
        });
    });
});
