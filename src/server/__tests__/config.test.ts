import { describe, expect, it } from 'bun:test';
import { DEFAULT_CONFIG, deploymentOverrides, envOverrides, makeConfig, parseFlags } from '../config';

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

/**
 * The command line, for the one tunable someone changes *while* starting the
 * server rather than while deploying it: a downloaded binary told :3000 is busy
 * has no obvious place to set an environment variable, and typing
 * `--port=5000` is what anyone tries first.
 */
describe('parseFlags', () => {
    it('finds no port in an empty argument list', () => {
        expect(parseFlags([])).toEqual({});
    });

    it('reads --port=5000', () => {
        expect(parseFlags(['--port=5000'])).toEqual({ port: 5000 });
    });

    it('reads --port 5000, because a space is what half of all CLIs take', () => {
        expect(parseFlags(['--port', '5000'])).toEqual({ port: 5000 });
    });

    it('throws when --port ends the argument list with no value after it', () => {
        expect(() => parseFlags(['--port'])).toThrow(/--port/);
    });

    it.each([
        ['zero', '0'],
        ['negative', '-1'],
        ['fractional', '80.5'],
        ['words', 'eighty'],
        ['blank', ''],
        ['out of range', '70000']
    ])('throws on a %s port rather than silently falling back to 3000', (_name, value) => {
        expect(() => parseFlags([`--port=${value}`])).toThrow(/--port/);
    });

    it('throws on an unrecognized argument, naming it and the flags that exist', () => {
        // The bug this whole flag fixes was an argument accepted and ignored.
        // Reproducing that for `--prot=5000` would be the same failure wearing a
        // typo, so anything unrecognized is refused out loud.
        expect(() => parseFlags(['--prot=5000'])).toThrow(/--prot=5000[\s\S]*--port/);
    });
});

describe('deploymentOverrides', () => {
    it('returns no overrides for an empty environment and no arguments', () => {
        expect(deploymentOverrides({}, [])).toEqual({});
    });

    it('passes the environment through untouched when no flag is given', () => {
        const env = { MULES_PORT: '8123', MULES_STATIC_ROOT: 'dist' };
        expect(deploymentOverrides(env, [])).toEqual(envOverrides(env));
    });

    it('lets --port win over MULES_PORT, since the flag is typed at the launch', () => {
        expect(deploymentOverrides({ MULES_PORT: '8123' }, ['--port=5000']).port).toBe(5000);
    });

    it('derives publicBaseUrl from the port the flag chose, not the one the env named', () => {
        const overrides = deploymentOverrides({ MULES_PORT: '8123' }, ['--port=5000']);
        expect(overrides.publicBaseUrl).toBe('http://localhost:5000');
    });

    it('keeps an explicit MULES_PUBLIC_BASE_URL ahead of the port the flag derives', () => {
        // D3's rule, across layers this time: a named URL is a deployment fact
        // (a proxy, a domain) that moving the listen port does not invalidate.
        const env = { MULES_PUBLIC_BASE_URL: 'https://mules.example' };
        expect(deploymentOverrides(env, ['--port=5000']).publicBaseUrl).toBe('https://mules.example');
    });

    it('feeds makeConfig to produce a complete config', () => {
        expect(makeConfig(deploymentOverrides({}, ['--port=5000']))).toEqual({
            ...DEFAULT_CONFIG,
            port: 5000,
            publicBaseUrl: 'http://localhost:5000'
        });
    });
});
