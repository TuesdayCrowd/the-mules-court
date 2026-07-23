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
    maxNicknameLength: 24
};

/** Builds a `TransportConfig`, applying `overrides` on top of the defaults. */
export function makeConfig(overrides: Partial<TransportConfig> = {}): TransportConfig {
    return { ...DEFAULT_CONFIG, ...overrides };
}
