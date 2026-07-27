/**
 * Static hosting and the SPA fallback (UIX §2.6).
 *
 * `joinUrl` is `publicBaseUrl + '/join/' + matchId` (`roomRegistry.ts:63`) and
 * `publicBaseUrl` defaults to the server's own origin — but `fetch` answered
 * every non-upgrade request with 404, so every invite link was dead. This suite
 * pins the routing order, the fallback, and the path-traversal refusal.
 *
 * `staticRoot` defaults to null, so these tests build their own fixture tree
 * under a temp directory and pass it explicitly. Nothing here reads `dist/`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { makeConfig } from '../config';
import { serveStatic, startServer } from '../index';
import type { RunningServer } from '../index';

describe('static hosting', () => {
    let running: RunningServer;
    let base: string;
    let root: string;

    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), 'mules-static-'));
        mkdirSync(join(root, 'assets'), { recursive: true });
        writeFileSync(join(root, 'index.html'), '<!doctype html><title>court</title>');
        writeFileSync(join(root, 'assets', 'card.png'), 'PNGDATA');

        running = startServer(makeConfig({ port: 0, dbPath: ':memory:', staticRoot: root }));
        base = `http://localhost:${running.server.port}`;
    });

    afterAll(() => {
        running.stop();
        rmSync(root, { recursive: true, force: true });
    });

    it('serves index.html at the root', async () => {
        expect(await (await fetch(`${base}/`)).text()).toContain('court');
    });

    it('falls back to index.html for a join route so the SPA can boot', async () => {
        const res = await fetch(`${base}/join/K7QX2`);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('court');
    });

    it('serves a real asset with its own bytes', async () => {
        expect(await (await fetch(`${base}/assets/card.png`)).text()).toBe('PNGDATA');
    });

    it('refuses an encoded traversal that survives URL normalisation', async () => {
        // Only %2f-encoded separators reach the server intact. `fetch` collapses
        // `..` before sending, so `/../config.ts` arrives as `/config.ts` and
        // `/%2e%2e/%2e%2e/etc/passwd` as `/etc/passwd` — both 404 merely because
        // the file is absent from the fixture root, proving nothing about the
        // guard. The traversal logic itself is tested directly below, against
        // raw pathnames no URL parser has touched.
        const res = await fetch(`${base}/..%2f..%2fetc%2fpasswd`);
        expect(res.status).toBe(404);
    });

    it('404s a missing file that looks like a file', async () => {
        expect((await fetch(`${base}/assets/missing.png`)).status).toBe(404);
    });

    it('404s an unknown API path rather than falling back to the app', async () => {
        expect((await fetch(`${base}/api/nope`)).status).toBe(404);
    });

    it('still creates a room on the API path it does serve', async () => {
        const res = await fetch(`${base}/api/rooms`, { method: 'POST' });
        expect(res.status).toBe(201);
    });

    it('still upgrades a WebSocket on any path', async () => {
        const ws = new WebSocket(`ws://localhost:${running.server.port}/ws`);
        await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => reject(new Error('upgrade refused'));
        });
        ws.close();
    });
});

describe('static hosting disabled', () => {
    let running: RunningServer;
    let base: string;

    beforeAll(() => {
        running = startServer(makeConfig({ port: 0, dbPath: ':memory:' }));
        base = `http://localhost:${running.server.port}`;
    });

    afterAll(() => {
        running.stop();
    });

    it('defaults staticRoot to null, so a transport with no client 404s the root', async () => {
        // dist/ is gitignored build output; a transport default naming it would
        // make the server's configuration depend on an artifact that need not
        // exist. Hosting is an explicit deployment opt-in.
        expect((await fetch(`${base}/`)).status).toBe(404);
    });

    it('still serves the API and the upgrade with no static root', async () => {
        expect((await fetch(`${base}/api/rooms`, { method: 'POST' })).status).toBe(201);

        const ws = new WebSocket(`ws://localhost:${running.server.port}/ws`);
        await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => reject(new Error('upgrade refused'));
        });
        ws.close();
    });
});

/**
 * The traversal guard, driven directly.
 *
 * Every pathname here is what `serveStatic` would receive from a client or a
 * proxy that has already decoded its input — the forms an HTTP-level test
 * cannot produce, because the URL parser rewrites them first.
 */
describe('serveStatic path safety', () => {
    let root: string;
    let sibling: string;

    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), 'mules-direct-'));
        mkdirSync(join(root, 'assets'), { recursive: true });
        writeFileSync(join(root, 'index.html'), '<!doctype html><title>court</title>');
        writeFileSync(join(root, 'assets', 'card.png'), 'PNGDATA');

        // A neighbour whose name starts with the root's, to prove the prefix
        // test compares against `base + sep` and not bare `base`.
        sibling = `${root}-evil`;
        mkdirSync(sibling, { recursive: true });
        writeFileSync(join(sibling, 'secret.txt'), 'SECRET');
    });

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
        rmSync(sibling, { recursive: true, force: true });
    });

    it('serves the shell at the root, which resolves to the base itself', async () => {
        const res = await serveStatic(root, '/');
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('court');
    });

    it('serves a real asset', async () => {
        expect(await (await serveStatic(root, '/assets/card.png')).text()).toBe('PNGDATA');
    });

    it('falls back to the shell for an extensionless client route', async () => {
        const res = await serveStatic(root, '/join/K7QX2');
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('court');
    });

    it('404s a missing file that carries an extension', async () => {
        expect((await serveStatic(root, '/assets/missing.png')).status).toBe(404);
    });

    it.each([
        ['bare parent', '/../secret.txt'],
        ['nested parent', '/assets/../../secret.txt'],
        ['absolute escape', '/../../../../etc/passwd'],
        ['encoded separator', '/..%2f..%2fetc%2fpasswd'],
        ['encoded dots', '/%2e%2e/%2e%2e/etc/passwd'],
        ['mixed encoding', '/assets/%2e%2e/%2e%2e/secret.txt']
    ])('refuses a %s traversal', async (_name, pathname) => {
        expect((await serveStatic(root, pathname)).status).toBe(404);
    });

    it('refuses a sibling directory whose name merely starts with the root', async () => {
        const res = await serveStatic(root, `/../${basename(sibling)}/secret.txt`);
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain('SECRET');
    });

    it('404s a malformed percent-escape instead of throwing', async () => {
        expect((await serveStatic(root, '/%ZZ')).status).toBe(404);
    });

    it('serves nothing when the root does not exist', async () => {
        expect((await serveStatic(join(root, 'nope'), '/index.html')).status).toBe(404);
    });
});
