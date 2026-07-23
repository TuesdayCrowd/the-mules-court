/**
 * Rate limiting primitives (Design §8 step 4): a per-connection token bucket
 * meant to be applied to every message type, plus a per-IP window meant to
 * guard new connections, room lookups, and room creates. Limiting only one
 * message type (e.g. PLAY_CARD) leaves every other type floodable — that
 * policy decision belongs to the caller (dispatch.ts, index.ts), not here.
 *
 * Dependency-free by design: capacities/rates are constructor args, never
 * read from `TransportConfig` in this file. `now` is injectable so tests
 * never sleep.
 */

/** Classic token bucket: refills continuously, spends one token per `take()`. */
export class TokenBucket {
    private tokens: number;
    private lastRefill: number;

    constructor(
        private readonly capacity: number,
        private readonly refillPerSec: number,
        private readonly now: () => number = Date.now
    ) {
        this.tokens = capacity;
        this.lastRefill = now();
    }

    /** Refills for elapsed time, then spends one token if available. */
    take(): boolean {
        const current = this.now();
        const elapsedSec = (current - this.lastRefill) / 1000;
        this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
        this.lastRefill = current;
        if (this.tokens < 1) return false;
        this.tokens -= 1;
        return true;
    }
}

/** Fixed window size for `IpLimiter` (Design §8 step 4). */
const IP_WINDOW_MS = 60_000;

interface IpWindow {
    windowStart: number;
    count: number;
}

/** Per-IP fixed 60-second window, counting events (new sockets, room lookups/creates). */
export class IpLimiter {
    private readonly windows = new Map<string, IpWindow>();

    constructor(
        private readonly perMinute: number,
        private readonly now: () => number = Date.now
    ) {}

    /** Number of IPs currently tracked. Exposed for tests only. */
    get size(): number {
        return this.windows.size;
    }

    /** True when `ip` has not yet used up `perMinute` events in its current window. */
    take(ip: string): boolean {
        const current = this.now();
        let win = this.windows.get(ip);
        if (!win || current - win.windowStart >= IP_WINDOW_MS) {
            win = { windowStart: current, count: 0 };
            this.windows.set(ip, win);
        }
        if (win.count >= this.perMinute) return false;
        win.count += 1;
        return true;
    }

    /** Drops IPs whose window has fully passed. Called by the reaper sweep. */
    prune(): void {
        const current = this.now();
        for (const [ip, win] of this.windows) {
            if (current - win.windowStart >= IP_WINDOW_MS) this.windows.delete(ip);
        }
    }
}
