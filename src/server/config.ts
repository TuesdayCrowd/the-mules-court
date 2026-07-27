/**
 * Every tunable from the transport design (Design §5, §6, §8, §14.5) in one
 * object. No other transport file may hold a numeric literal for any of
 * these — later modules take a `TransportConfig` as an explicit constructor
 * argument instead of reaching for a global or re-deriving a default.
 */
export interface TransportConfig {
    readonly port: number;
    readonly publicBaseUrl: string;          // joinUrl prefix
    readonly dbPath: string;                 // ':memory:' in tests
    readonly revealWindowMs: number;         // 5000 — fixed by design
    readonly lobbyDisconnectGraceMs: number; // 60_000
    readonly lobbyTtlMs: number;             // 15 * 60_000
    readonly activeGraceMs: number;          // 120_000
    readonly zeroConnTtlMs: number;          // 10 * 60_000
    readonly retentionMs: number;            // 60 * 60_000
    readonly sweepIntervalMs: number;        // 60_000
    readonly maxPayloadLength: number;       // 4096
    readonly messageBurst: number;           // 10 — token bucket capacity
    readonly messageRefillPerSec: number;    // 5
    readonly ipConnectionsPerMinute: number; // 30 — new sockets + room lookups + room creates
    readonly maxNicknameLength: number;      // 24
    /**
     * Directory of built client files to host, or null to serve none.
     *
     * Defaults to null rather than 'dist': dist/ is gitignored Vite output, and
     * a transport default naming it would make the server's configuration
     * depend on a build artifact that need not exist. A transport with no
     * client to serve is a valid configuration — it is what every test is — so
     * hosting is an explicit deployment opt-in, wired in package.json's `serve`
     * script one line from the `build` script that produces the directory.
     */
    readonly staticRoot: string | null;
}

export const DEFAULT_CONFIG: TransportConfig = {
    port: 3000,
    publicBaseUrl: 'http://localhost:3000',
    dbPath: 'mules-court.sqlite',
    revealWindowMs: 5000,
    lobbyDisconnectGraceMs: 60_000,
    lobbyTtlMs: 15 * 60_000,
    activeGraceMs: 120_000,
    zeroConnTtlMs: 10 * 60_000,
    retentionMs: 60 * 60_000,
    sweepIntervalMs: 60_000,
    maxPayloadLength: 4096,
    messageBurst: 10,
    messageRefillPerSec: 5,
    ipConnectionsPerMinute: 30,
    maxNicknameLength: 24,
    staticRoot: null
};

/** Builds a `TransportConfig`, applying `overrides` on top of the defaults. */
export function makeConfig(overrides: Partial<TransportConfig> = {}): TransportConfig {
    return { ...DEFAULT_CONFIG, ...overrides };
}

/**
 * The four tunables a *deployment* sets, read from the environment.
 *
 * Separate from the rest of `DEFAULT_CONFIG` because those are design constants
 * — the reveal window is five seconds because the design says so, on every
 * machine. These four are the ones that differ between this repo's `serve`
 * script and a binary someone downloaded, which cannot assume :3000 is free or
 * that its working directory is the one you meant.
 *
 * Takes the environment as an argument rather than reading `Bun.env`, so tests
 * are pure and no test can leak a variable into the next one.
 */
export function envOverrides(env: Record<string, string | undefined>): Partial<TransportConfig> {
    // `Partial<T>` makes fields optional but keeps them `readonly`, and every
    // field here is readonly by design — so the accumulator drops the modifier
    // and the return type puts it back.
    const overrides: { -readonly [K in keyof TransportConfig]?: TransportConfig[K] } = {};

    if (env.MULES_PORT !== undefined) {
        // `Number('')` is 0 and `Number(' 80 ')` is 80, so the range check does
        // the work an eager `parseInt` would have got wrong in both directions.
        const port = Number(env.MULES_PORT);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error(`MULES_PORT must be an integer from 1 to 65535, got ${JSON.stringify(env.MULES_PORT)}`);
        }
        overrides.port = port;
        // Deferred item D3: `joinUrl` is built from `publicBaseUrl`, so moving
        // the port and saying nothing about the URL has to move the invite link
        // too — otherwise every guest is sent to a port nothing is serving.
        // Overwritten just below if the deployment names a URL of its own.
        overrides.publicBaseUrl = `http://localhost:${port}`;
    }

    if (env.MULES_PUBLIC_BASE_URL !== undefined) {
        // `${base}/join/${id}` would otherwise double the slash.
        overrides.publicBaseUrl = env.MULES_PUBLIC_BASE_URL.replace(/\/+$/, '');
    }

    if (env.MULES_DB_PATH !== undefined) overrides.dbPath = env.MULES_DB_PATH;
    if (env.MULES_STATIC_ROOT !== undefined) overrides.staticRoot = env.MULES_STATIC_ROOT;

    return overrides;
}
