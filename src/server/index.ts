/**
 * `Bun.serve` entrypoint (plan Task 12; Design §2, §3, §8 step 1). Wiring
 * only: this file adapts a `ServerWebSocket` to the `SeatConnection` that
 * `Room` already speaks, and a per-IP limiter to the two places Design §8
 * step 4 requires one (new connections, room creation). No game logic lives
 * here — every rule this file enforces is one line deferred to
 * `dispatchMessage`, `RoomRegistry`, or `Room`.
 */

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
    startServer(makeConfig());
}
