/**
 * The static-hosting policy, independent of where the bytes come from.
 *
 * `static.test.ts` drives the filesystem lookup end to end and was left
 * untouched by the refactor that produced this file — it is the regression
 * gate, and it passing unedited is the proof the split changed no behaviour.
 *
 * This suite covers the seam: that one policy drives two lookups identically,
 * and that the embedded lookup a compiled binary uses obeys the same
 * SPA-fallback and 404 rules as the directory one. Without it, the binary's
 * routing would be tested only by compiling and curling it.
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { embeddedLookup, filesystemLookup, serveFrom } from '../staticAssets';

const SHELL = join(import.meta.dir, 'fixtures', 'shell.html');
const CARD = join(import.meta.dir, 'fixtures', 'card.png');

/**
 * What the generated manifest is: URL path to the path a `type: 'file'` import
 * evaluated to. Real fixture files stand in for embedded ones, which is exactly
 * what happens when `standalone.ts` runs uncompiled under `bun`.
 */
const EMBEDDED = new Map([
    ['/index.html', SHELL],
    ['/assets/card.png', CARD]
]);

describe('embeddedLookup', () => {
    const lookup = embeddedLookup(EMBEDDED);

    it('serves the shell at the root', async () => {
        const res = await serveFrom(lookup, '/');
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('court');
    });

    it('serves an embedded asset with its own bytes', async () => {
        expect(await (await serveFrom(lookup, '/assets/card.png')).text()).toBe('PNGDATA');
    });

    it('infers the content type from the extension, with no MIME table of its own', async () => {
        expect((await serveFrom(lookup, '/assets/card.png')).headers.get('content-type')).toContain('image/png');
    });

    it('falls back to the shell for an extensionless client route', async () => {
        const res = await serveFrom(lookup, '/join/K7QX2');
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('court');
    });

    it('404s a missing file that carries an extension', async () => {
        // Pretending a broken asset is the homepage hides the breakage.
        expect((await serveFrom(lookup, '/assets/missing.png')).status).toBe(404);
    });

    it('404s an extensionless traversal instead of answering it with the app shell', async () => {
        // The regression that made the policy refuse `..` itself. A lookup can
        // only answer "no file", and "no file" is what triggers the fallback —
        // so a traversal reaching it gets a 200 and the homepage, because
        // `/etc/passwd` has no extension and reads as a client route. Harmless
        // in what it discloses, wrong in what it says, and it masked the same
        // hole on the filesystem side where it is not harmless at all.
        expect((await serveFrom(lookup, '/../../etc/passwd')).status).toBe(404);
        expect((await serveFrom(lookup, '/join/../../../etc/shadow')).status).toBe(404);
    });

    it('serves a file whose name merely starts with dots', async () => {
        // The refusal tests whole segments, not substrings: '..png' is a name.
        const dotty = embeddedLookup(new Map([['/assets/..png', CARD]]));
        expect((await serveFrom(dotty, '/assets/..png')).status).toBe(200);
    });

    it('404s a malformed percent-escape instead of throwing', async () => {
        expect((await serveFrom(lookup, '/%ZZ')).status).toBe(404);
    });

    it('decodes a percent-encoded path, so an asset whose name has a space is reachable', async () => {
        const spaced = embeddedLookup(new Map([['/a b.png', CARD]]));
        expect((await serveFrom(spaced, '/a%20b.png')).status).toBe(200);
    });

    it('404s everything when the manifest is empty rather than throwing', async () => {
        expect((await serveFrom(embeddedLookup(new Map()), '/')).status).toBe(404);
    });

    it('404s an entry whose file has gone missing', async () => {
        const stale = embeddedLookup(new Map([['/index.html', join(tmpdir(), 'mules-not-here.html')]]));
        expect((await serveFrom(stale, '/index.html')).status).toBe(404);
    });
});

describe('filesystemLookup', () => {
    it('serves the shell at the root of a directory whose own name contains a dot', async () => {
        // The pre-refactor policy tested for an extension on the *resolved*
        // path. A request for '/' resolves to the root directory itself, so its
        // basename was the directory's own name — meaning a root named
        // 'mules.court' looked like it had an extension and the homepage 404ed
        // instead of falling back to the shell. Every existing test used a
        // dot-free temp directory, so nothing caught it.
        //
        // The policy now reads the request path, where '/' has no last segment
        // and the fallback is unambiguous.
        const parent = mkdtempSync(join(tmpdir(), 'mules-dotted-'));
        const root = join(parent, 'mules.court');
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, 'index.html'), '<!doctype html><title>court</title>');

        try {
            const res = await serveFrom(filesystemLookup(root), '/');
            expect(res.status).toBe(200);
            expect(await res.text()).toContain('court');
        } finally {
            rmSync(parent, { recursive: true, force: true });
        }
    });

    it('404s an extensionless traversal rather than falling back to the shell', async () => {
        // The same regression from the filesystem side, where the disclosure
        // would be real: `/../../../../etc/hostname` resolves outside the root,
        // the guard refuses it, and the policy must not then decide it looked
        // like a client route.
        const root = mkdtempSync(join(tmpdir(), 'mules-fallback-'));
        writeFileSync(join(root, 'index.html'), '<!doctype html><title>court</title>');

        try {
            expect((await serveFrom(filesystemLookup(root), '/../../../../etc/hostname')).status).toBe(404);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('still refuses a traversal at the lookup, as defence in depth', async () => {
        const root = mkdtempSync(join(tmpdir(), 'mules-guard-'));
        writeFileSync(join(root, 'index.html'), '<!doctype html><title>court</title>');
        const sibling = `${root}-evil`;
        mkdirSync(sibling, { recursive: true });
        writeFileSync(join(sibling, 'secret.txt'), 'SECRET');

        try {
            const lookup = filesystemLookup(root);
            expect(await lookup('/../mules-guard-evil/secret.txt')).toBeNull();
            expect(await lookup('/etc/passwd')).toBeNull();
        } finally {
            rmSync(root, { recursive: true, force: true });
            rmSync(sibling, { recursive: true, force: true });
        }
    });
});
