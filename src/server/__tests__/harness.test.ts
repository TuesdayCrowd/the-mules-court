import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';

describe('server test harness', () => {
    it('runs under the Bun runtime, not Node', () => {
        expect(typeof Bun).toBe('object');
        expect(1 + 1).toBe(2);
    });

    it('opens an in-memory bun:sqlite database', () => {
        const db = new Database(':memory:');
        db.run('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)');
        db.run('INSERT INTO t (id, n) VALUES (?, ?)', ['a', 1]);
        expect((db.query('SELECT n FROM t WHERE id = ?').get('a') as { n: number }).n).toBe(1);
        db.close();
    });

    it('serves a WebSocket with per-socket data and an ephemeral port', async () => {
        // One type argument only: the second generic is Bun's route-path string
        // literal type and must be left to default — `{}` fails tsc (TS2344).
        const server = Bun.serve<{ tag: string }>({
            port: 0,
            fetch(req, srv) {
                if (srv.upgrade(req, { data: { tag: 'x' } })) return;
                return new Response('http');
            },
            websocket: {
                perMessageDeflate: false,
                maxPayloadLength: 4096,
                message(ws, raw) {
                    ws.send(JSON.stringify({ echo: String(raw), tag: ws.data.tag }));
                }
            }
        });
        const ws = new WebSocket(`ws://localhost:${server.port}/`);
        const got = new Promise<string>(resolve => (ws.onmessage = e => resolve(String(e.data))));
        await new Promise<void>(resolve => (ws.onopen = () => resolve()));
        ws.send('hi');
        expect(JSON.parse(await got)).toEqual({ echo: 'hi', tag: 'x' });
        ws.close();
        server.stop(true);
    });
});
