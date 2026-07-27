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

/**
 * Any manifest entry with the given extension.
 *
 * The manifest is regenerated from dist/ on every build, so nothing here may
 * name one of its files: the hashed chunks move, and the rest are only whatever
 * `public/` happened to hold that day. Probing by extension asks the question
 * these tests are actually about — does a `.png` come back as `image/png` —
 * without pinning the suite to an asset someone is free to rename or delete.
 *
 * `/index.html` is the one exception, and it is a contract rather than content:
 * `collectAssetFiles` refuses to emit a manifest without it, because the SPA
 * fallback would have nothing to serve.
 */
function anyAssetEndingIn(extension: string): string {
    const hit = [...EMBEDDED.keys()].find(path => path.endsWith(extension));
    if (hit === undefined) throw new Error(`No ${extension} file in the manifest to probe with`);
    return hit;
}

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

    it('serves every asset the shell references, which is what proves the client can boot', async () => {
        // Derived from the shell rather than named here. The manifest's contents
        // are ephemeral — the bundle and the stylesheet carry content hashes
        // that move on every client build — so a test naming '/assets/index-'
        // is pinned to Vite's chunk-naming convention rather than to anything
        // this file is about, and would fail on a rename that broke nothing.
        //
        // Asking the shell what it needs is also the stronger claim: not "a
        // JavaScript file is reachable" but "every URL the app requests to boot
        // is served by the binary".
        const shell = await (await fetch(`${base}/`)).text();
        const referenced = [...shell.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map(match => match[1]);
        expect(referenced.length).toBeGreaterThan(0);

        const served = await Promise.all(
            referenced.map(async path => `${path} → ${(await fetch(`${base}${path}`)).status}`)
        );
        expect(served).toEqual(referenced.map(path => `${path} → 200`));
    });

    it('infers an image content type with no MIME table of its own', async () => {
        const image = anyAssetEndingIn('.png');
        const res = await fetch(`${base}${image}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('image/png');
    });

    it('falls back to the shell on an invite route', async () => {
        const res = await fetch(`${base}/join/K7QX2`);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('game-container');
    });

    it('404s a missing asset rather than pretending it is the homepage', async () => {
        // Checked rather than assumed: the whole point of the case is that the
        // path is absent from the manifest, and the manifest is regenerated
        // from whatever dist/ holds.
        const absent = '/assets/definitely-not-in-the-manifest.png';
        expect(EMBEDDED.has(absent)).toBe(false);

        expect((await fetch(`${base}${absent}`)).status).toBe(404);
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
