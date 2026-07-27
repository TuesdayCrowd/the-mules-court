/**
 * The wiring a compiled binary uses: `startServer` with an embedded asset
 * handler and no `staticRoot`. `standalone.ts` itself is a console banner and
 * two signal handlers over exactly this, so importing it here would only bind a
 * port and install handlers the suite would then have to undo.
 *
 * Unlike `static.test.ts`, which builds its own fixture tree, this runs against
 * the real committed manifest — so it fails if a rebuild renamed a hashed chunk
 * and nobody regenerated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { makeConfig } from '../config';
import { EMBEDDED } from '../embeddedAssets.generated';
import { startServer } from '../index';
import type { RunningServer } from '../index';
import { embeddedLookup, serveFrom } from '../staticAssets';

describe('standalone wiring', () => {
    let running: RunningServer;
    let base: string;

    beforeAll(() => {
        const lookup = embeddedLookup(EMBEDDED);
        running = startServer(makeConfig({ port: 0, dbPath: ':memory:' }), pathname => serveFrom(lookup, pathname));
        base = `http://localhost:${running.server.port}`;
    });

    afterAll(() => {
        running.stop();
    });

    it('serves the real app shell with no staticRoot configured', async () => {
        const res = await fetch(`${base}/`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/html');
        expect(await res.text()).toContain('game-container');
    });

    it('serves the app bundle, which is what proves the binary can boot the client', async () => {
        const script = [...EMBEDDED.keys()].find(path => path.startsWith('/assets/index-') && path.endsWith('.js'));
        expect(script).toBeDefined();

        const res = await fetch(`${base}${script}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('javascript');
    });

    it('infers an image content type with no MIME table of its own', async () => {
        const res = await fetch(`${base}/favicon.png`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('image/png');
    });

    it('falls back to the shell on an invite route', async () => {
        const res = await fetch(`${base}/join/K7QX2`);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('game-container');
    });

    it('404s a missing asset rather than pretending it is the homepage', async () => {
        expect((await fetch(`${base}/assets/missing.png`)).status).toBe(404);
    });

    it('404s an unknown API path', async () => {
        expect((await fetch(`${base}/api/nope`)).status).toBe(404);
    });

    it('still creates a room, so the transport half survived the swap', async () => {
        const res = await fetch(`${base}/api/rooms`, { method: 'POST' });
        expect(res.status).toBe(201);
        expect(await res.json()).toMatchObject({ hostSeat: 'p1' });
    });

    it('still upgrades a WebSocket', async () => {
        const ws = new WebSocket(`ws://localhost:${running.server.port}/ws`);
        await new Promise<void>((done, fail) => {
            ws.onopen = () => done();
            ws.onerror = () => fail(new Error('upgrade refused'));
        });
        ws.close();
    });
});
