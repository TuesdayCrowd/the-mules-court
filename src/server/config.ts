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
    readonly revealWindowMs: number;         // 10_000 — fixed by design
    readonly botThinkMs: number;             // 1_200 — pacing, not compute
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
    // Deliberate pacing, not the time a decision takes. The heuristic answers
    // in well under a millisecond, and a bot that replies instantly reads as a
    // scripted cutscene rather than an opponent — it also outruns the client's
    // own beat cadence, so cards would move before the last animation landed.
    botThinkMs: 1_200,
    revealWindowMs: 10_000,
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
 * One port rule, shared by the environment variable and the command-line flag,
 * so the two cannot disagree about what a port is.
 *
 * `Number('')` is 0 and `Number(' 80 ')` is 80, so the range check does the work
 * an eager `parseInt` would have got wrong in both directions.
 */
function parsePort(raw: string, source: string): number {
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${source} must be an integer from 1 to 65535, got ${JSON.stringify(raw)}`);
    }
    return port;
}

/**
 * The four tunables a *deployment* sets, read from the environment.
 *
 * Separate from the rest of `DEFAULT_CONFIG` because those are design constants
 * — the reveal window is ten seconds because the design says so, on every
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
        const port = parsePort(env.MULES_PORT, 'MULES_PORT');
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

export interface Flags {
    readonly port?: number;
}

export const USAGE = 'Accepted flags: --port=<1-65535>';

/**
 * The command line: `--port=5000` or `--port 5000`, and nothing else.
 *
 * Only the port has a flag, because it is the only one of the four tunables
 * whose value someone learns *at the moment of starting the server* — :3000 is
 * busy, and there is nowhere to put an environment variable in that sentence.
 * A db path or a public URL is a property of a deployment, which is what
 * `envOverrides` is for.
 *
 * Takes the arguments as a parameter rather than reading `Bun.argv`, for the
 * same reason `envOverrides` takes the environment: the two entrypoints slice
 * `Bun.argv` once and the tests stay pure.
 *
 * Anything unrecognized throws. Silently ignoring an argument is the exact
 * failure this flag exists to fix — a server that answers `--prot=5000` by
 * listening on 3000 and saying nothing has taught its user that the flag does
 * not work.
 */
export function parseFlags(args: readonly string[]): Flags {
    const flags: { -readonly [K in keyof Flags]?: Flags[K] } = {};

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;

        if (arg.startsWith('--port=')) {
            flags.port = parsePort(arg.slice('--port='.length), '--port');
            continue;
        }

        if (arg === '--port') {
            const value = args[i + 1];
            if (value === undefined) throw new Error(`--port needs a value, as --port=5000 or --port 5000`);
            flags.port = parsePort(value, '--port');
            i++;
            continue;
        }

        throw new Error(`Unrecognized argument ${JSON.stringify(arg)}.\n${USAGE}`);
    }

    return flags;
}

/**
 * Every override a launch can carry: the environment first, then the command
 * line over the top of it, because a flag is typed at the launch itself and the
 * environment may well have come from a shell profile or a container image.
 *
 * The port's effect on `publicBaseUrl` (deferred item D3) has to be resolved
 * here rather than inside either parser, since the winning port and the winning
 * URL can come from different layers. The rule is the one `envOverrides` already
 * applies within its own layer: a *named* URL outranks a *derived* one, because
 * a proxy or a domain name is a deployment fact that moving the listen port does
 * not invalidate.
 */
export function deploymentOverrides(
    env: Record<string, string | undefined>,
    args: readonly string[]
): Partial<TransportConfig> {
    const fromEnv = envOverrides(env);
    const { port } = parseFlags(args);

    if (port === undefined) return fromEnv;

    return {
        ...fromEnv,
        port,
        publicBaseUrl:
            env.MULES_PUBLIC_BASE_URL !== undefined ? fromEnv.publicBaseUrl! : `http://localhost:${port}`
    };
}
