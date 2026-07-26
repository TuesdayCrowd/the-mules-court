/**
 * `Bun.serve` entrypoint (plan Task 12; Design §2, §3, §8 step 1). Wiring
 * only: this file adapts a `ServerWebSocket` to the `SeatConnection` that
 * `Room` already speaks, and a per-IP limiter to the two places Design §8
 * step 4 requires one (new connections, room creation). No game logic lives
 * here — every rule this file enforces is one line deferred to
 * `dispatchMessage`, `RoomRegistry`, or `Room`.
 */

import { basename, join, resolve, sep } from 'node:path';
import type { TransportConfig } from './config';
import { makeConfig } from './config';
import type { ConnectionState } from './dispatch';
import { dispatchMessage } from './dispatch';
import { MatchStore } from './persistence';
import { IpLimiter, TokenBucket } from './rateLimiter';
import { RoomRegistry } from './roomRegistry';

export interface RunningServer {
    // Bun.Server takes exactly one required generic (the WebSocket data
    // type) — bare `Bun.Server` fails tsc (TS2314).
    server: Bun.Server<ConnectionState>;
    registry: RoomRegistry;
    stop(): void;
}

/**
 * Static hosting with an SPA fallback for `/join/:matchId` (UIX §2.6).
 *
 * The resolve-then-prefix-check is the whole security story: `resolve`
 * collapses every `..`, and a resolved path that no longer starts with the root
 * is refused before `Bun.file` ever opens it. Percent-encoded traversal is
 * covered because decoding happens first and resolution second — checking the
 * raw pathname would miss `%2e%2e`, and decoding after resolving would
 * reintroduce it.
 *
 * The `target !== base` arm matters: a request for `/` resolves to the root
 * itself, which is legitimate and does not carry the trailing separator the
 * prefix test looks for. Comparing against `base + sep` alone would 404 the
 * homepage; comparing against `base` alone would let `/../dist-evil` through
 * on a sibling directory whose name merely starts with the root's.
 *
 * Exported for direct testing. Driving this through `fetch` cannot exercise it:
 * the URL parser collapses `..` before the request leaves the client, so
 * `/../secret` arrives as `/secret` and a traversal test run that way would
 * pass against a function with no check in it at all. Only `%2f`-encoded
 * separators survive that normalisation — and an upstream proxy may well decode
 * them, so the guard is tested here against raw pathnames instead.
 */
export async function serveStatic(root: string, pathname: string): Promise<Response> {
    const base = resolve(root);

    let decoded: string;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        // A malformed percent-escape is not a path worth guessing at.
        return new Response('Not Found', { status: 404 });
    }

    const target = resolve(base, '.' + decoded);
    if (target !== base && !target.startsWith(base + sep)) {
        return new Response('Not Found', { status: 404 });
    }

    const file = Bun.file(target);
    if (await file.exists()) return new Response(file);

    // A path with no extension is a client route, so hand back the app shell
    // and let the router sort it out. A missing .png stays a 404: pretending a
    // broken asset is the homepage hides the breakage.
    if (!basename(target).includes('.')) {
        const shell = Bun.file(join(base, 'index.html'));
        if (await shell.exists()) return new Response(shell);
    }

    return new Response('Not Found', { status: 404 });
}

/** Builds the JSON `201` body for a successful `POST /api/rooms` (Design §3). */
function roomCreatedResponse(created: { matchId: string; joinUrl: string; hostSeat: 'p1'; hostSeatToken: string }): Response {
    return new Response(JSON.stringify(created), { status: 201, headers: { 'content-type': 'application/json' } });
}

export function startServer(config: TransportConfig): RunningServer {
    const store = new MatchStore(config.dbPath);
    const registry = new RoomRegistry(config, store);
    registry.startSweeping();

    const ipLimiter = new IpLimiter(config.ipConnectionsPerMinute);

    // `server.stop(true)` force-closes every live socket, which synchronously
    // fires this file's own `websocket.close` handler for each of them. That
    // handler calls `registry.get`, which falls back to `store.load` on a
    // cache miss — a fallback that must never run against an already-closed
    // `MatchStore`. Guarding on this flag (set as `stop()`'s very first line,
    // before `registry.stop()`/`store.close()` run) is simpler and more
    // robust than reordering teardown, since it holds regardless of whether
    // the runtime fires `close` synchronously inside `server.stop()` or on a
    // later microtask.
    let stopped = false;

    const server = Bun.serve<ConnectionState>({
        port: config.port,

        fetch(req, srv) {
            const url = new URL(req.url);
            const ip = srv.requestIP(req)?.address ?? 'unknown';

            if (req.method === 'POST' && url.pathname === '/api/rooms') {
                if (!ipLimiter.take(ip)) {
                    return new Response('Too Many Requests', { status: 429 });
                }
                return roomCreatedResponse(registry.createRoom());
            }

            // Keyed on the header, not the path: the Vite dev proxy wants a
            // stable `/ws` prefix, while thirteen existing tests connect to
            // `/`. Both work, and static hosting can own every other path.
            if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
                if (!ipLimiter.take(ip)) {
                    return new Response('Too Many Requests', { status: 429 });
                }

                const data: ConnectionState = {
                    ip,
                    bucket: new TokenBucket(config.messageBurst, config.messageRefillPerSec),
                    seat: null,
                    matchId: null,
                    // Assigned in websocket.open(), which always precedes the first
                    // message — see the comment on ConnectionState.conn in dispatch.ts.
                    conn: undefined as unknown as ConnectionState['conn']
                };
                if (srv.upgrade(req, { data })) return;

                return new Response('Upgrade Failed', { status: 400 });
            }

            // An unknown /api/ path is a client bug, never a client route: it
            // must not fall through to the app shell and 200.
            if (url.pathname.startsWith('/api/')) {
                return new Response('Not Found', { status: 404 });
            }

            if (config.staticRoot !== null) {
                return serveStatic(config.staticRoot, url.pathname);
            }

            return new Response('Not Found', { status: 404 });
        },

        websocket: {
            perMessageDeflate: false,
            maxPayloadLength: config.maxPayloadLength,

            open(ws) {
                ws.data.conn = {
                    send: json => {
                        ws.send(json);
                    },
                    close: () => {
                        ws.close();
                    }
                };
            },

            message(ws, raw) {
                void dispatchMessage(registry, config, ws.data, String(raw));
            },

            close(ws) {
                if (stopped) return;
                if (ws.data.seat === null || ws.data.matchId === null) return;
                // The room must already be mapped: this socket could only have
                // bound a seat by succeeding CLAIM_SEAT/RESUME_SEAT against a
                // room that `registry.get` had already resolved (created or
                // rebuilt). A disconnect of a room that was never touched this
                // process is meaningless, so a plain `get` — never a rebuild
                // trigger of its own — is exactly right here.
                const room = registry.get(ws.data.matchId);
                if (room === null) return;
                // Mirrors every other `enqueue` call site's `.catch` (e.g.
                // `Room`'s own reveal-timer callback): a throw here must log,
                // never surface as an unhandled rejection from inside a
                // socket event handler.
                room.enqueue(() => room.handleClose(ws.data.conn)).catch(err => {
                    console.error('close: room.handleClose threw', ws.data.matchId, err);
                });
            }
        }
    });

    return {
        server,
        registry,
        stop(): void {
            stopped = true;
            registry.stop();
            store.close();
            server.stop(true);
        }
    };
}

if (import.meta.main) {
    // Hosting is opt-in, set by package.json's `serve` script — the only place
    // that knows this repo builds to dist/, one line from the script producing it.
    startServer(makeConfig({ staticRoot: Bun.env.MULES_STATIC_ROOT ?? null }));
}
