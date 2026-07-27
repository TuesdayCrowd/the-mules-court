/**
 * The embedded-asset manifest generator.
 *
 * Bun resolves `with { type: 'file' }` at bundle time, so the list of files a
 * binary embeds cannot be a runtime glob over dist/ — it has to be source code.
 * Code that is generated is code worth testing, and these tests run against a
 * fixture tree rather than the real dist/, so they are deterministic and pass on
 * a clone that has never built.
 *
 * One test at the bottom does check the committed manifest against a real
 * dist/, and skips itself when there is none.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectAssetFiles, renderManifest } from '../embeddedManifest';

const DIST = join(import.meta.dir, '..', '..', '..', 'dist');

function fixtureTree(): string {
    const root = mkdtempSync(join(tmpdir(), 'mules-manifest-'));
    mkdirSync(join(root, 'assets', 'mule'), { recursive: true });
    mkdirSync(join(root, 'fonts'), { recursive: true });
    writeFileSync(join(root, 'index.html'), '<!doctype html>');
    writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(join(root, 'assets', 'mule', 'portrait_0.png'), 'PNG');
    writeFileSync(join(root, 'fonts', 'inter.woff2'), 'FONT');
    writeFileSync(join(root, '.DS_Store'), 'JUNK');
    writeFileSync(join(root, 'assets', '.DS_Store'), 'JUNK');
    return root;
}

describe('collectAssetFiles', () => {
    it('finds every file at every depth, as URL paths', () => {
        expect(collectAssetFiles(fixtureTree())).toEqual([
            '/assets/app.js',
            '/assets/mule/portrait_0.png',
            '/fonts/inter.woff2',
            '/index.html'
        ]);
    });

    it('skips dotfiles at every depth, so .DS_Store is never baked into a binary', () => {
        // public/ is copied into dist/ verbatim, and macOS has already put a
        // .DS_Store in there once. A generator without this filter ships it.
        expect(collectAssetFiles(fixtureTree()).some(path => path.includes('.DS_Store'))).toBe(false);
    });

    it('sorts, so an unchanged dist/ regenerates an unchanged manifest', () => {
        // The generated file is committed. Output that depended on
        // directory-read order would show a diff on every single build.
        const files = collectAssetFiles(fixtureTree());
        expect(files).toEqual([...files].sort());
    });

    it('throws on a missing root rather than emitting an empty manifest', () => {
        // An empty manifest compiles fine and 404s every request — a binary
        // that starts, serves nothing, and explains nothing.
        expect(() => collectAssetFiles(join(tmpdir(), 'mules-nope-does-not-exist'))).toThrow(/not found/i);
    });

    it('throws when the root holds no index.html, because the SPA fallback needs one', () => {
        const bare = mkdtempSync(join(tmpdir(), 'mules-bare-'));
        writeFileSync(join(bare, 'stray.txt'), 'x');
        expect(() => collectAssetFiles(bare)).toThrow(/index\.html/);
    });
});

describe('renderManifest', () => {
    const source = renderManifest(['/index.html', '/assets/app.js']);

    it('emits one file import per asset, resolved from src/server/', () => {
        expect(source).toContain("import a0 from '../../dist/index.html' with { type: 'file' };");
        expect(source).toContain("import a1 from '../../dist/assets/app.js' with { type: 'file' };");
    });

    it('maps every URL path to its imported binding', () => {
        expect(source).toContain("['/index.html', a0]");
        expect(source).toContain("['/assets/app.js', a1]");
    });

    it('annotates the export, so consumers type-check even though the file does not', () => {
        expect(source).toContain('export const EMBEDDED: ReadonlyMap<string, string>');
    });

    it('opts out of type-checking on its first line', () => {
        // Three of dist/'s extensions have no usable declaration for a file
        // import: @types/bun types *.html as HTMLBundle (right for its
        // fullstack dev server, wrong for type: 'file'), *.js resolves to the
        // real module, *.md has none at all. Checking generated glue buys
        // nothing, and the opt-out is also what lets the committed file
        // reference a dist/ that a fresh clone has not built.
        expect(source.split('\n')[0]).toBe('// @ts-nocheck');
    });

    it('says it is generated and how to regenerate it', () => {
        expect(source).toMatch(/GENERATED/);
        expect(source).toMatch(/bun run compile/);
    });

    it('is deterministic', () => {
        expect(renderManifest(['/index.html'])).toBe(renderManifest(['/index.html']));
    });

    it('renders a usable module for an empty file list', () => {
        // Not a configuration anything should ship, but the generator must not
        // emit `new Map([\n\n])` and fail to parse if it ever happens.
        expect(renderManifest([])).toContain('new Map([]);');
    });
});

describe('the committed manifest', () => {
    it.skipIf(!existsSync(join(DIST, 'index.html')))('covers every file in the current dist/', async () => {
        // Skipped on a clone that has never built — dist/ is gitignored. When
        // it does run it is the gate against a stale manifest: a rebuild that
        // renames a hashed chunk otherwise leaves the binary 404ing the app's
        // own JavaScript, and the app never boots.
        const { EMBEDDED } = await import('../embeddedAssets.generated');
        expect([...EMBEDDED.keys()].sort()).toEqual(collectAssetFiles(DIST));
    });
});
