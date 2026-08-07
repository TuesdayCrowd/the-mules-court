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
import { ASSET_MAX_AGE_SECONDS, cacheControlFor, embeddedLookup, filesystemLookup, serveFrom } from '../staticAssets';

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

/**
 * Compression is negotiated in `serveFrom` rather than in a lookup, for the
 * same reason the traversal guard is: it is policy, and forking it per source
 * is what this file's split exists to prevent. A binary that served
 * uncompressed while the directory server gzipped would be a silent 1.3 MB
 * regression nobody would think to look for.
 */
describe('compression', () => {
    /** Big enough to clear the floor, and compressible enough to prove it ran. */
    const scriptBody = `// ${'the mule looms. '.repeat(400)}\n`;

    function withScript<T>(run: (root: string) => Promise<T>): Promise<T> {
        const root = mkdtempSync(join(tmpdir(), 'mules-gzip-'));
        mkdirSync(join(root, 'assets'), { recursive: true });
        writeFileSync(join(root, 'index.html'), '<!doctype html><title>court</title>');
        writeFileSync(join(root, 'assets', 'app.js'), scriptBody);
        writeFileSync(join(root, 'assets', 'card.png'), 'PNGDATA'.repeat(500));

        return run(root).finally(() => rmSync(root, { recursive: true, force: true }));
    }

    it('gzips a script when the client asks, and the body still decodes to the original', async () => {
        await withScript(async root => {
            const res = await serveFrom(filesystemLookup(root), '/assets/app.js', 'gzip, deflate, br');

            expect(res.headers.get('content-encoding')).toBe('gzip');
            expect(res.headers.get('content-type')).toContain('javascript');

            const raw = new Uint8Array(await res.arrayBuffer());
            expect(new TextDecoder().decode(Bun.gunzipSync(raw))).toBe(scriptBody);
            expect(raw.length).toBeLessThan(scriptBody.length);
        });
    });

    it('varies on accept-encoding, so a shared cache cannot replay gzip at a client that never asked', async () => {
        await withScript(async root => {
            const res = await serveFrom(filesystemLookup(root), '/assets/app.js', 'gzip');
            expect(res.headers.get('vary')?.toLowerCase()).toContain('accept-encoding');
        });
    });

    it('sends the raw bytes when the client offers no encoding', async () => {
        await withScript(async root => {
            const res = await serveFrom(filesystemLookup(root), '/assets/app.js');

            expect(res.headers.get('content-encoding')).toBeNull();
            expect(await res.text()).toBe(scriptBody);
        });
    });

    it('leaves an already-compressed format alone however much of it there is', async () => {
        await withScript(async root => {
            const res = await serveFrom(filesystemLookup(root), '/assets/card.png', 'gzip');

            expect(res.headers.get('content-encoding')).toBeNull();
            expect(await res.text()).toBe('PNGDATA'.repeat(500));
        });
    });

    it('compresses the shell a client route falls back to, not just an exact hit', async () => {
        await withScript(async root => {
            // A long shell, so the fallback branch clears the floor too.
            writeFileSync(join(root, 'index.html'), `<!doctype html><title>court</title><!--${'x'.repeat(2000)}-->`);

            const res = await serveFrom(filesystemLookup(root), '/join/K7QX2', 'gzip');
            expect(res.headers.get('content-encoding')).toBe('gzip');
            expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await res.arrayBuffer())))).toContain('court');
        });
    });

    it('serves fresh bytes after a rebuild renames nothing, which is what /index.html does', async () => {
        await withScript(async root => {
            const shell = join(root, 'index.html');
            writeFileSync(shell, `<!doctype html><title>court one</title><!--${'x'.repeat(2000)}-->`);
            const first = await serveFrom(filesystemLookup(root), '/join/A', 'gzip');
            expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await first.arrayBuffer())))).toContain('court one');

            // Same path, different bytes — the cache key has to notice.
            writeFileSync(shell, `<!doctype html><title>court two</title><!--${'y'.repeat(2100)}-->`);
            const second = await serveFrom(filesystemLookup(root), '/join/A', 'gzip');
            expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await second.arrayBuffer())))).toContain('court two');
        });
    });
});

/**
 * Caching, which is one policy over both lookups like everything else here.
 *
 * The bug that prompted it: with no `cache-control` at all, a browser refetched
 * every sound effect on the page navigation that hosting a game performs —
 * roughly 370 KB of mp3 re-downloaded inside one session, verified against the
 * running server.
 */
describe('cache-control', () => {
    const fsLookup = filesystemLookup(join(import.meta.dir, 'fixtures'));

    it('is set on a served asset at all, which was the whole bug', async () => {
        const res = await serveFrom(embeddedLookup(EMBEDDED), '/assets/card.png');
        expect(res.headers.get('cache-control')).not.toBeNull();
    });

    it('gives an unhashed asset a bounded life rather than an unbounded one', async () => {
        const res = await serveFrom(embeddedLookup(EMBEDDED), '/assets/card.png');
        expect(res.headers.get('cache-control')).toBe(`public, max-age=${ASSET_MAX_AGE_SECONDS}`);
        expect(res.headers.get('cache-control')).not.toContain('immutable');
    });

    /**
     * A stale shell asks for hashed chunks that no longer exist after a deploy,
     * which is a blank page rather than an old one.
     */
    it('makes the shell revalidate every time', async () => {
        const res = await serveFrom(embeddedLookup(EMBEDDED), '/');
        expect(res.headers.get('cache-control')).toBe('no-cache');
    });

    it('makes every client route revalidate too, since they are all the shell', async () => {
        const res = await serveFrom(embeddedLookup(EMBEDDED), '/join/K7QX2');
        expect(res.headers.get('cache-control')).toBe('no-cache');
    });

    it('lets a fingerprinted bundle be kept forever, because its name changes with it', () => {
        expect(cacheControlFor('/assets/index-CtByFVTU.js')).toContain('immutable');
        expect(cacheControlFor('/assets/index-i3XKi0pu.css')).toContain('immutable');
    });

    /**
     * The false positive that would matter most: an audio file whose own name
     * happens to have the shape of a fingerprint. `amb-mule-presence.mp3` ends
     * in a hyphen followed by exactly eight characters, and treating it as
     * immutable would pin a stale sound effect for a year.
     */
    it('never mistakes a hyphenated asset name for a content hash', () => {
        for (const key of [
            '/assets/sfx/amb-mule-presence.mp3',
            '/assets/sfx/token-award.mp3',
            '/assets/sfx/your-turn.mp3',
            '/assets/card-back/card_back_2.png',
            '/assets/first-speaker/portrait_0.png',
            '/fonts/inter-var-latin-ext.woff2'
        ]) {
            expect(cacheControlFor(key)).not.toContain('immutable');
        }
    });

    it('applies the same rule through the filesystem lookup', async () => {
        const res = await serveFrom(fsLookup, '/card.png');
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe(`public, max-age=${ASSET_MAX_AGE_SECONDS}`);
    });

    it('survives compression, which builds its own header set', async () => {
        const res = await serveFrom(embeddedLookup(EMBEDDED), '/index.html', 'gzip');
        expect(res.headers.get('cache-control')).toBe('no-cache');
    });
});

/**
 * The homepage reaches `respond` under a different key depending on the lookup:
 * the embedded one translates '/' to the shell and hits, the filesystem one
 * misses on the root directory and falls back under SHELL_PATH. One policy over
 * two lookups is this file's entire premise, so the header must not notice.
 */
describe('the homepage caches the same way whichever lookup serves it', () => {
    it('agrees across both lookups', async () => {
        // A real root on disk, because the shared fixtures directory holds a
        // `shell.html` rather than an `index.html` and so has no homepage to
        // serve — the filesystem lookup would 404 and the comparison would pass
        // by both sides being wrong.
        const root = mkdtempSync(join(tmpdir(), 'mules-cache-'));
        writeFileSync(join(root, 'index.html'), '<!doctype html><title>court</title>');

        try {
            const embedded = await serveFrom(embeddedLookup(EMBEDDED), '/');
            const onDisk = await serveFrom(filesystemLookup(root), '/');

            expect(embedded.status).toBe(200);
            expect(onDisk.status).toBe(200);
            expect(embedded.headers.get('cache-control')).toBe('no-cache');
            expect(onDisk.headers.get('cache-control')).toBe(embedded.headers.get('cache-control'));
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
