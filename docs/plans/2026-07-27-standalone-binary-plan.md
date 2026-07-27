# Standalone Binary Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship The Mule's Court as a single self-contained executable — server, client bundle and every asset in one file that runs from any directory with no `dist/`, no `bun install`, and no repo checkout.

**Architecture:** `bun build --compile` already handles the server half; the client half is the interesting one. `serveStatic` reads the real filesystem under `MULES_STATIC_ROOT`, and a compiled binary has no `dist/` to point at. Rather than fork the routing rules, this plan splits static hosting into **policy** (decode → exact hit → SPA fallback → 404, shared) and **lookup** (filesystem *or* embedded map, swappable). A codegen step walks `dist/` and emits one `with { type: 'file' }` import per file plus a `Map<urlPath, embeddedPath>`; a second entrypoint, `standalone.ts`, wires that map into the same policy. `index.ts` is left byte-identical in behaviour, so `bun run serve` and all 13 existing static tests keep exercising the real filesystem.

**Tech Stack:** Bun 1.3.14 (`--compile`, import attributes, `bun:sqlite`), TypeScript 5.7, Vite 6, `bun test`.

---

## Why these shapes

**Why a second entrypoint rather than a flag on the first.** `index.ts:145` branches on `config.staticRoot !== null`. Adding an `embedded` mode there would mean the production server carries a manifest of a `dist/` it may not have built, and every server test would boot code holding 70 MB of embedded imports. A separate entrypoint keeps the import graph honest: only the thing being compiled imports the compiled-in assets.

**Why the policy is shared and the lookup is not.** Duplicating "extensionless paths fall back to `index.html`, a missing `.png` stays a 404" in two files guarantees they drift, and the drift would be invisible until someone reports a dead invite link from a downloaded binary. Only the *resolution* step genuinely differs — one resolves against a directory and must refuse traversal, the other does a `Map.get` that cannot escape anything.

**Why the manifest is generated and committed.** Bun resolves `with { type: 'file' }` at bundle time, so the import list cannot be a runtime glob — it must be code. And it must be *committed* code: `standalone.ts` imports it, so a fresh clone missing it fails `bunx tsc --noEmit`, which AGENTS.md names as the only type check this project has. The generated file carries `// @ts-nocheck`, which makes its references to a possibly-absent `dist/` harmless (verified: TS2307 is suppressed) while its explicit `export const EMBEDDED: ReadonlyMap<string, string>` annotation still types correctly at every call site.

**Why `@ts-nocheck` at all.** Three of the seven extensions in `dist/` do not type-check as file imports. `vite/client` declares `*.png`, `*.css`, `*.woff2` and `*.txt` as `string` — fine. But `@types/bun` declares `*.html` as `HTMLBundle` (correct for Bun's fullstack dev server, wrong for `type: 'file'`), `*.js` resolves to the real JavaScript module, and `*.md` has no declaration at all. There is no ambient declaration that overrides those, so the generated file opts out of checking and the hand-written code around it stays fully checked.

**Why env-configurable tunables are in scope.** A binary someone downloads has different needs from a repo script: port 3000 is hardcoded, `publicBaseUrl` is baked at `http://localhost:3000` (deferred item **D3** in the UIX plan), and the sqlite file lands wherever the binary was launched from. All three are one function in `config.ts`, and doing them here closes D3.

---

## Stage map

| Stage | Deliverable | Tasks |
| ----- | ----------- | ----- |
| 1 | Env-configurable tunables; D3 closed | 1–2 |
| 2 | Static hosting split into policy + lookup | 3 |
| 3 | Embedded-asset manifest (pure module + CLI) | 4–6 |
| 4 | `standalone.ts` entrypoint and compile scripts | 7–9 |
| 5 | End-to-end verification and docs | 10–11 |

---

### Task 1: Read tunables from the environment

**Files:**
- Modify: `src/server/config.ts`
- Test: `src/server/__tests__/config.test.ts`

`makeConfig` stays pure. The new function is also pure — it takes an env *record* rather than reaching for `Bun.env`, so tests never mutate a global and never leak between files.

**Step 1: Write the failing tests**

Append to `src/server/__tests__/config.test.ts`:

```ts
describe('envOverrides', () => {
    it('returns no overrides for an empty environment', () => {
        expect(envOverrides({})).toEqual({});
    });

    it('reads every supported variable', () => {
        expect(
            envOverrides({
                MULES_PORT: '8123',
                MULES_DB_PATH: '/var/lib/mules.sqlite',
                MULES_PUBLIC_BASE_URL: 'https://mules.example',
                MULES_STATIC_ROOT: 'dist'
            })
        ).toEqual({
            port: 8123,
            dbPath: '/var/lib/mules.sqlite',
            publicBaseUrl: 'https://mules.example',
            staticRoot: 'dist'
        });
    });

    it('derives publicBaseUrl from MULES_PORT so an invite link points at the port in use', () => {
        // D3: the default base URL names :3000. A host who moves the port and
        // says nothing about the URL means the new port, not the old one.
        expect(envOverrides({ MULES_PORT: '8123' }).publicBaseUrl).toBe('http://localhost:8123');
    });

    it('lets an explicit MULES_PUBLIC_BASE_URL win over the derived one', () => {
        const env = { MULES_PORT: '8123', MULES_PUBLIC_BASE_URL: 'https://mules.example' };
        expect(envOverrides(env).publicBaseUrl).toBe('https://mules.example');
    });

    it('strips a trailing slash so joinUrl never doubles it', () => {
        expect(envOverrides({ MULES_PUBLIC_BASE_URL: 'https://mules.example/' }).publicBaseUrl).toBe(
            'https://mules.example'
        );
    });

    it.each([['zero', '0'], ['negative', '-1'], ['fractional', '80.5'], ['words', 'eighty'], ['blank', '']])(
        'throws on a %s port rather than silently falling back to 3000',
        (_name, value) => {
            expect(() => envOverrides({ MULES_PORT: value })).toThrow(/MULES_PORT/);
        }
    );

    it('feeds makeConfig to produce a complete config', () => {
        expect(makeConfig(envOverrides({ MULES_PORT: '8123' })).port).toBe(8123);
    });
});
```

Import `envOverrides` alongside the existing imports on line 2.

**Step 2: Run to verify it fails**

```bash
bun test src/server/__tests__/config.test.ts
```
Expected: FAIL — `envOverrides is not a function` / import error.

**Step 3: Implement**

Append to `src/server/config.ts`:

```ts
/**
 * The subset of `TransportConfig` a deployment sets from the environment
 * (Design §5). Kept separate from `DEFAULT_CONFIG` because these four are the
 * only values that differ between "this repo's `serve` script" and "a binary
 * someone downloaded" — every other tunable is a design constant.
 *
 * Takes the environment as an argument rather than reading `Bun.env`, so tests
 * are pure and no test can leak a variable into the next one.
 */
export function envOverrides(env: Record<string, string | undefined>): Partial<TransportConfig> {
    const overrides: Partial<TransportConfig> = {};

    if (env.MULES_PORT !== undefined) {
        const port = Number(env.MULES_PORT);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error(`MULES_PORT must be an integer from 1 to 65535, got ${JSON.stringify(env.MULES_PORT)}`);
        }
        overrides.port = port;
        // D3: joinUrl is built from publicBaseUrl, so moving the port without
        // saying anything about the URL must move the invite link too.
        // Overwritten below if the deployment names a URL of its own.
        overrides.publicBaseUrl = `http://localhost:${port}`;
    }

    if (env.MULES_PUBLIC_BASE_URL !== undefined) {
        // `${base}/join/${id}` would otherwise double the slash.
        overrides.publicBaseUrl = env.MULES_PUBLIC_BASE_URL.replace(/\/+$/, '');
    }

    if (env.MULES_DB_PATH !== undefined) overrides.dbPath = env.MULES_DB_PATH;
    if (env.MULES_STATIC_ROOT !== undefined) overrides.staticRoot = env.MULES_STATIC_ROOT;

    return overrides;
}
```

**Step 4: Run to verify it passes**

```bash
bun test src/server/__tests__/config.test.ts
```
Expected: PASS.

**Step 5: Commit**

```bash
but status -fv
but commit server/standalone-binary -m "feat(server): read port, db path and base URL from the environment" --changes <ids>
```

---

### Task 2: Wire the environment into the existing entrypoint

**Files:**
- Modify: `src/server/index.ts:205-209`

**Step 1: Implement**

Replace the `import.meta.main` block:

```ts
if (import.meta.main) {
    // Hosting stays opt-in, set by package.json's `serve` script — the only
    // place that knows this repo builds to dist/. Every other tunable a
    // deployment moves (port, database path, invite-link origin) now comes from
    // the same place; see `envOverrides`.
    startServer(makeConfig(envOverrides(Bun.env)));
}
```

Update the import on line 12 to `import { envOverrides, makeConfig } from './config';`.

**Step 2: Verify nothing regressed**

```bash
bun test src/server
bunx tsc --noEmit
```
Expected: PASS, no output from tsc. `MULES_STATIC_ROOT=dist` in the `serve` script still works — it now arrives via `envOverrides` instead of a bespoke read.

**Step 3: Commit**

```bash
but commit server/standalone-binary -m "feat(server): apply environment overrides at the entrypoint" --changes <ids>
```

---

### Task 3: Split static hosting into policy and lookup

**Files:**
- Create: `src/server/staticAssets.ts`
- Modify: `src/server/index.ts` (delete the body of `serveStatic`, re-export)
- Test: `src/server/__tests__/staticAssets.test.ts` (new); `src/server/__tests__/static.test.ts` (unchanged — it is the regression gate)

The existing `static.test.ts` must keep passing **without edits**. That is the proof the refactor is behaviour-preserving.

**Step 1: Write the failing tests**

Create `src/server/__tests__/staticAssets.test.ts`:

```ts
/**
 * The static-hosting policy, independent of where the bytes come from.
 *
 * `static.test.ts` covers the filesystem lookup end to end and is left
 * untouched by the refactor that produced this file — it is the regression
 * gate. This suite covers the seam: that one policy drives two lookups
 * identically, and that the embedded lookup a compiled binary uses obeys the
 * same SPA-fallback and 404 rules as the directory one.
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { embeddedLookup, filesystemLookup, serveFrom } from '../staticAssets';

const EMBEDDED = new Map([
    ['/index.html', join(import.meta.dir, 'fixtures', 'shell.html')],
    ['/assets/card.png', join(import.meta.dir, 'fixtures', 'card.png')]
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

    it('falls back to the shell for an extensionless client route', async () => {
        const res = await serveFrom(lookup, '/join/K7QX2');
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('court');
    });

    it('404s a missing file that carries an extension', async () => {
        expect((await serveFrom(lookup, '/assets/missing.png')).status).toBe(404);
    });

    it('404s a traversal, which a map lookup simply misses', async () => {
        expect((await serveFrom(lookup, '/../../etc/passwd')).status).toBe(404);
    });

    it('404s a malformed percent-escape instead of throwing', async () => {
        expect((await serveFrom(lookup, '/%ZZ')).status).toBe(404);
    });

    it('decodes a percent-encoded path so an asset with a space is reachable', async () => {
        const lookupWithSpace = embeddedLookup(
            new Map([['/a b.png', join(import.meta.dir, 'fixtures', 'card.png')]])
        );
        expect((await serveFrom(lookupWithSpace, '/a%20b.png')).status).toBe(200);
    });
});

describe('filesystemLookup', () => {
    it('serves the shell at the root of a directory whose own name contains a dot', async () => {
        // The pre-refactor code tested for an extension on the *resolved* path,
        // so a request for '/' resolved to the root directory itself and took
        // its basename — meaning a root named 'mules.court' had an "extension"
        // and the homepage 404ed. The policy now reads the request path, where
        // '/' has no last segment and the fallback is unambiguous.
        const parent = mkdtempSync(join(tmpdir(), 'mules-dotted-'));
        const root = join(parent, 'mules.court');
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, 'index.html'), '<!doctype html><title>court</title>');

        const res = await serveFrom(filesystemLookup(root), '/');
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('court');
    });
});
```

Create the fixtures:

```bash
mkdir -p src/server/__tests__/fixtures
printf '<!doctype html><title>court</title>' > src/server/__tests__/fixtures/shell.html
printf 'PNGDATA' > src/server/__tests__/fixtures/card.png
```

**Step 2: Run to verify it fails**

```bash
bun test src/server/__tests__/staticAssets.test.ts
```
Expected: FAIL — cannot resolve `../staticAssets`.

**Step 3: Implement**

Create `src/server/staticAssets.ts`:

```ts
/**
 * Static hosting, split so one set of rules can serve two sources of bytes.
 *
 * `serveFrom` owns the *policy* — decode, exact hit, SPA fallback for an
 * extensionless path, 404 for anything else (UIX §2.6). A `Lookup` owns
 * *resolution*, and only that differs between the two deployments: the
 * filesystem lookup resolves against a directory and must refuse traversal,
 * while the embedded lookup a compiled binary uses is a `Map.get` that cannot
 * escape anything by construction.
 *
 * Duplicating the policy per source is the failure this file exists to prevent:
 * the drift would surface as a dead invite link from a downloaded binary, with
 * nothing in the repo's own test run to catch it.
 */
import { basename, join, resolve, sep } from 'node:path';

/** Resolves an already-decoded, in-root request path to a file, or null. */
export type Lookup = (pathname: string) => Promise<Bun.BunFile | null>;

/**
 * Serves `pathname` through `lookup`, applying the routing policy.
 *
 * The extension test reads the *request* path rather than a resolved one. A
 * path with no extension is a client route, so it gets the app shell and the
 * router sorts it out; a missing `.png` stays a 404, because pretending a
 * broken asset is the homepage hides the breakage.
 */
export async function serveFrom(lookup: Lookup, pathname: string): Promise<Response> {
    let decoded: string;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        // A malformed percent-escape is not a path worth guessing at.
        return new Response('Not Found', { status: 404 });
    }

    const hit = await lookup(decoded);
    if (hit !== null) return new Response(hit);

    const lastSegment = decoded.slice(decoded.lastIndexOf('/') + 1);
    if (!lastSegment.includes('.')) {
        const shell = await lookup('/index.html');
        if (shell !== null) return new Response(shell);
    }

    return new Response('Not Found', { status: 404 });
}

/**
 * Reads from a directory on disk, refusing any path that escapes it.
 *
 * The resolve-then-prefix-check is the whole security story: `resolve`
 * collapses every `..`, and a resolved path that no longer starts with the root
 * is refused before `Bun.file` ever opens it. Percent-encoded traversal is
 * covered because `serveFrom` decodes first and this resolves second — checking
 * a raw pathname would miss `%2e%2e`, and decoding after resolving would
 * reintroduce it.
 *
 * The `target !== base` arm matters: a request for `/` resolves to the root
 * itself, which is legitimate and does not carry the trailing separator the
 * prefix test looks for. Comparing against `base + sep` alone would refuse the
 * homepage; comparing against `base` alone would let `/../dist-evil` through on
 * a sibling directory whose name merely starts with the root's.
 */
export function filesystemLookup(root: string): Lookup {
    const base = resolve(root);

    return async pathname => {
        const target = resolve(base, '.' + pathname);
        if (target !== base && !target.startsWith(base + sep)) return null;

        // `resolve` strips a trailing separator, so a request for '/' lands on
        // the directory itself. `Bun.file(dir).exists()` is false, which is the
        // answer we want — the shell fallback in `serveFrom` handles it.
        const file = Bun.file(target);
        return (await file.exists()) ? file : null;
    };
}

/**
 * Reads from the manifest `bun build --compile` embedded into the binary.
 *
 * The map's values are whatever `import … with { type: 'file' }` evaluated to:
 * an absolute filesystem path when run under `bun`, an opaque embedded-VFS path
 * inside a compiled binary. `Bun.file` accepts both, which is why
 * `standalone.ts` is runnable — and testable — without a 61 MB build step.
 *
 * No traversal guard: a `Map.get` for '/../../etc/passwd' misses, and there is
 * no directory to escape into.
 */
export function embeddedLookup(embedded: ReadonlyMap<string, string>): Lookup {
    return async pathname => {
        const key = pathname === '/' ? '/index.html' : pathname;
        const target = embedded.get(key);
        if (target === undefined) return null;

        const file = Bun.file(target);
        return (await file.exists()) ? file : null;
    };
}

/** Shell path used by the generator and asserted by the manifest tests. */
export const SHELL_PATH = '/index.html';

// `basename` and `join` are re-exported nowhere; they are used by neither
// function above. Remove the import if this comment survives review.
```

> **Note for the implementer:** delete `basename, join` from that import — the
> policy no longer needs them, and `noUnusedLocals` will fail the build if they
> stay. The trailing comment is a reminder, not code to keep.

Then in `src/server/index.ts`, replace the whole `serveStatic` body (lines 27–78) with a delegating wrapper that keeps its exported signature, since `static.test.ts` imports it:

```ts
/**
 * Static hosting with an SPA fallback for `/join/:matchId` (UIX §2.6).
 *
 * The rules live in `staticAssets.ts`, shared with the standalone binary so the
 * two deployments cannot drift. Still exported here because driving the policy
 * through `fetch` cannot exercise the traversal guard: the URL parser collapses
 * `..` before the request leaves the client, so a test run that way would pass
 * against a function with no check in it at all.
 */
export function serveStatic(root: string, pathname: string): Promise<Response> {
    return serveFrom(filesystemLookup(root), pathname);
}
```

Update `index.ts`'s imports: drop `basename, join, resolve, sep` from `node:path` (nothing else in the file uses them) and add `import { filesystemLookup, serveFrom } from './staticAssets';`.

**Step 4: Run to verify everything passes**

```bash
bun test src/server
bunx tsc --noEmit
```
Expected: PASS, including all 13 pre-existing `static.test.ts` cases with no edits to that file.

**Step 5: Commit**

```bash
but commit server/standalone-binary -m "refactor(server): share one static-hosting policy across two byte sources" --changes <ids>
```

---

### Task 4: The manifest as a pure module

**Files:**
- Create: `src/server/embeddedManifest.ts`
- Test: `src/server/__tests__/embeddedManifest.test.ts`

The decision — which files to embed and what source text to emit — is pure and belongs in a tested module. `scripts/` gets only the I/O.

**Step 1: Write the failing tests**

Create `src/server/__tests__/embeddedManifest.test.ts`:

```ts
/**
 * The embedded-asset manifest generator.
 *
 * Tested against a fixture tree rather than the real `dist/`, so the suite is
 * deterministic and runs on a clone that has never built. One test at the
 * bottom does check the committed manifest against a real `dist/` — and skips
 * itself when there is none.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectAssetFiles, renderManifest } from '../embeddedManifest';

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

    it('skips dotfiles, so .DS_Store is never baked into a binary', () => {
        // `public/` is copied verbatim into `dist/`, and macOS has put a
        // .DS_Store there before. A generator that embedded it would ship it.
        expect(collectAssetFiles(fixtureTree()).some(p => p.includes('.DS_Store'))).toBe(false);
    });

    it('sorts, so a rebuild with unchanged files produces an unchanged manifest', () => {
        const files = collectAssetFiles(fixtureTree());
        expect(files).toEqual([...files].sort());
    });

    it('throws on a missing root rather than emitting an empty manifest', () => {
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

    it('emits one file import per asset, relative to src/server/', () => {
        expect(source).toContain("import a0 from '../../dist/index.html' with { type: 'file' };");
        expect(source).toContain("import a1 from '../../dist/assets/app.js' with { type: 'file' };");
    });

    it('maps every URL path to its imported binding', () => {
        expect(source).toContain("['/index.html', a0]");
        expect(source).toContain("['/assets/app.js', a1]");
    });

    it('annotates the export so consumers type-check even though the file does not', () => {
        expect(source).toContain('export const EMBEDDED: ReadonlyMap<string, string>');
    });

    it('opts out of type-checking, because three of the extensions have no usable declaration', () => {
        // @types/bun types *.html as HTMLBundle, *.js resolves to the real
        // module, *.md has no declaration at all. Checking generated glue buys
        // nothing; the annotated export keeps every call site checked.
        expect(source.split('\n')[0]).toBe('// @ts-nocheck');
    });

    it('says it is generated, so nobody edits it by hand', () => {
        expect(source).toMatch(/GENERATED/);
        expect(source).toMatch(/bun run compile/);
    });

    it('is deterministic', () => {
        expect(renderManifest(['/index.html'])).toBe(renderManifest(['/index.html']));
    });
});

describe('the committed manifest', () => {
    it.skipIf(!existsSync(join(import.meta.dir, '..', '..', '..', 'dist', 'index.html')))(
        'covers every file in the current dist/',
        async () => {
            // Skipped on a clone that has never built — dist/ is gitignored.
            // When it does run it is the gate that catches a stale manifest:
            // a rebuild that renamed a hashed chunk leaves the binary serving
            // a 404 for the app's own JavaScript.
            const { EMBEDDED } = await import('../embeddedAssets.generated');
            const root = join(import.meta.dir, '..', '..', '..', 'dist');
            expect([...EMBEDDED.keys()].sort()).toEqual(collectAssetFiles(root));
        }
    );
});
```

**Step 2: Run to verify it fails**

```bash
bun test src/server/__tests__/embeddedManifest.test.ts
```
Expected: FAIL — cannot resolve `../embeddedManifest`.

**Step 3: Implement**

Create `src/server/embeddedManifest.ts`:

```ts
/**
 * Decides what a compiled binary embeds, and writes the source that embeds it.
 *
 * Bun resolves `with { type: 'file' }` at bundle time, so the import list cannot
 * be a runtime glob over `dist/` — it has to be code, and code that is generated
 * is code worth testing. Both functions here are pure enough to drive from a
 * fixture tree; `scripts/generateEmbeddedAssets.ts` adds only the file write.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

/** Where the generated module lives, relative to `dist/`. */
const IMPORT_PREFIX = '../../dist';

/**
 * Every file under `root`, as sorted URL paths ('/assets/app.js').
 *
 * Dotfiles are skipped at every depth. `public/` is copied into `dist/`
 * verbatim, and macOS has already put a `.DS_Store` in there once — a generator
 * without this filter would bake it into the binary.
 *
 * Sorted so an unchanged `dist/` regenerates an unchanged manifest: the file is
 * committed, and a generator whose output depended on directory-read order
 * would show a diff on every build.
 */
export function collectAssetFiles(root: string): string[] {
    if (!existsSync(root)) {
        throw new Error(`Asset root not found: ${root} — run \`bun run build\` first.`);
    }

    const files: string[] = [];

    const walk = (dir: string, urlPrefix: string): void => {
        for (const entry of readdirSync(dir)) {
            if (entry.startsWith('.')) continue;

            const full = join(dir, entry);
            const url = posix.join(urlPrefix, entry);
            if (statSync(full).isDirectory()) walk(full, url);
            else files.push(url);
        }
    };

    walk(root, '/');
    files.sort();

    if (!files.includes('/index.html')) {
        throw new Error(`Asset root ${root} has no index.html — the SPA fallback would have nothing to serve.`);
    }

    return files;
}

/** Renders the generated module's source text for `files`. */
export function renderManifest(files: string[]): string {
    const imports = files
        .map((file, i) => `import a${i} from '${IMPORT_PREFIX}${file}' with { type: 'file' };`)
        .join('\n');

    const entries = files.map((file, i) => `    ['${file}', a${i}]`).join(',\n');

    return `// @ts-nocheck
/**
 * GENERATED — do not edit. Run \`bun run compile\` to regenerate.
 *
 * One \`type: 'file'\` import per file in dist/, plus the URL-path map
 * \`embeddedLookup\` reads. Each import evaluates to a *path* string: an absolute
 * filesystem path under \`bun\`, an embedded-VFS path inside a compiled binary.
 * \`Bun.file\` accepts both.
 *
 * The file opts out of type-checking because three of dist/'s extensions have no
 * usable declaration for a file import — @types/bun types *.html as HTMLBundle,
 * *.js resolves to the real module, *.md has none at all. That also makes the
 * references below harmless on a clone whose dist/ has never been built. The
 * annotated export keeps every call site fully checked.
 */
${imports}

export const EMBEDDED: ReadonlyMap<string, string> = new Map([
${entries}
]);
`;
}
```

**Step 4: Run to verify it passes**

```bash
bun test src/server/__tests__/embeddedManifest.test.ts
```
Expected: PASS, with the `committed manifest` case **skipped** (the generated file does not exist yet).

**Step 5: Commit**

```bash
but commit server/standalone-binary -m "feat(server): decide and render the embedded-asset manifest" --changes <ids>
```

---

### Task 5: The generator CLI

**Files:**
- Create: `scripts/generateEmbeddedAssets.ts`

**Step 1: Implement**

```ts
/**
 * Regenerates `src/server/embeddedAssets.generated.ts` from `dist/`.
 *
 * Thin by design: every decision lives in `src/server/embeddedManifest.ts`,
 * which is tested against a fixture tree. This file adds a read of the real
 * directory and one write, and is reviewed by reading.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectAssetFiles, renderManifest } from '../src/server/embeddedManifest';

const repoRoot = join(import.meta.dir, '..');
const distRoot = join(repoRoot, 'dist');
const outPath = join(repoRoot, 'src', 'server', 'embeddedAssets.generated.ts');

const files = collectAssetFiles(distRoot);
writeFileSync(outPath, renderManifest(files));

console.log(`Embedded ${files.length} files from dist/ into ${outPath}`);
```

**Step 2: Run it**

```bash
bun run build
bun scripts/generateEmbeddedAssets.ts
```
Expected: `Embedded 30 files from dist/ into …/embeddedAssets.generated.ts` (the count tracks whatever `dist/` currently holds).

**Step 3: Verify the manifest test now runs instead of skipping**

```bash
bun test src/server/__tests__/embeddedManifest.test.ts
bunx tsc --noEmit
```
Expected: PASS with no skip, and tsc silent.

**Step 4: Commit — including the generated file**

```bash
but commit server/standalone-binary -m "feat(server): generate the embedded-asset manifest from dist/" --changes <ids>
```

---

### Task 6: (folded into Task 3)

`embeddedLookup` ships with the policy split, and its tests are in
`staticAssets.test.ts`. Kept as a numbered placeholder so later task numbers
match the commit history.

---

### Task 7: The standalone entrypoint

**Files:**
- Create: `src/server/standalone.ts`

Differences from `index.ts`'s `main` block, all of which exist because someone
downloaded this rather than checking it out:

- static bytes come from the manifest, not a directory;
- a startup banner names the URL, the database path and how to stop it;
- `SIGINT`/`SIGTERM` close sqlite before exiting, so Ctrl-C is not a hard kill.

**Step 1: Implement**

```ts
/**
 * Entrypoint for the single-file distributable (`bun run compile`).
 *
 * `index.ts` is the repo's server and stays exactly as it is: it reads
 * `dist/` off the filesystem, which is right for `bun run serve` and for the
 * transport tests. This file is the same server with its client bytes compiled
 * in, so the binary runs from any directory with no dist/ beside it.
 *
 * Only the *lookup* differs — the routing rules are the ones in
 * `staticAssets.ts`, shared, so a dead invite link cannot appear in the binary
 * without appearing in the repo's own test run first.
 */
import { envOverrides, makeConfig } from './config';
import { EMBEDDED } from './embeddedAssets.generated';
import { startServer } from './index';
import { embeddedLookup, serveFrom } from './staticAssets';

const config = makeConfig(envOverrides(Bun.env));
const lookup = embeddedLookup(EMBEDDED);

const running = startServer(config, pathname => serveFrom(lookup, pathname));

// The database is created relative to the working directory, so say where it
// went. A binary launched by double-click from a downloads folder writes there,
// and silently, that is the kind of thing someone finds a week later.
console.log(
    [
        `The Mule's Court — v${process.env.MULES_VERSION ?? '1.0.0'}`,
        ``,
        `  Playing at   ${config.publicBaseUrl}`,
        `  Database     ${config.dbPath === ':memory:' ? 'in memory (nothing written)' : Bun.pathToFileURL(config.dbPath).pathname}`,
        `  Assets       ${EMBEDDED.size} files compiled in`,
        ``,
        `  Set MULES_PORT, MULES_DB_PATH or MULES_PUBLIC_BASE_URL to change any of this.`,
        `  Press Ctrl-C to stop.`,
        ``
    ].join('\n')
);

// A hard kill leaves sqlite's WAL behind. `stop()` closes the store and
// force-closes every live socket, which is what the transport's own teardown
// path already expects.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        console.log('\nStopping…');
        running.stop();
        process.exit(0);
    });
}
```

**Step 2: Make `startServer` accept a static handler**

`src/server/index.ts` — add an optional second parameter, defaulting to the
filesystem behaviour so no existing call site changes:

```ts
export function startServer(
    config: TransportConfig,
    serveAsset: ((pathname: string) => Promise<Response>) | null = null
): RunningServer {
```

and replace the static branch in `fetch`:

```ts
            if (serveAsset !== null) return serveAsset(url.pathname);
            if (config.staticRoot !== null) return serveStatic(config.staticRoot, url.pathname);
```

An explicit handler wins over `staticRoot`; a binary sets the first and never
the second.

**Step 3: Verify it runs uncompiled**

```bash
MULES_PORT=39119 bun src/server/standalone.ts &
sleep 1
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://localhost:39119/
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://localhost:39119/favicon.png
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:39119/join/K7QX2
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:39119/assets/missing.png
curl -s -X POST -o /dev/null -w '%{http_code}\n' http://localhost:39119/api/rooms
kill %1
```
Expected: `200 text/html`, `200 image/png`, `200`, `404`, `201`.

**Step 4: Commit**

```bash
but commit server/standalone-binary -m "feat(server): standalone entrypoint serving compiled-in client assets" --changes <ids>
```

---

### Task 8: Cover the standalone wiring with a test

**Files:**
- Test: `src/server/__tests__/standalone.test.ts`

Booting `standalone.ts` from a test would bind a port and install signal
handlers, so the test drives the same wiring instead: `startServer` with an
embedded handler.

**Step 1: Write the test**

```ts
/**
 * The wiring a compiled binary uses: `startServer` with an embedded asset
 * handler and no `staticRoot`. `standalone.ts` itself is a console banner and
 * two signal handlers over exactly this.
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
        running = startServer(makeConfig({ port: 0, dbPath: ':memory:' }), p => serveFrom(lookup, p));
        base = `http://localhost:${running.server.port}`;
    });

    afterAll(() => running.stop());

    it('serves the real app shell with no staticRoot configured', async () => {
        const res = await fetch(`${base}/`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/html');
        expect(await res.text()).toContain('<div id="game-container">');
    });

    it('serves a compiled-in asset with the right content type', async () => {
        const res = await fetch(`${base}/favicon.png`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('image/png');
    });

    it('falls back to the shell on an invite route', async () => {
        expect((await fetch(`${base}/join/K7QX2`)).status).toBe(200);
    });

    it('404s a missing asset rather than pretending it is the homepage', async () => {
        expect((await fetch(`${base}/assets/missing.png`)).status).toBe(404);
    });

    it('404s an unknown API path', async () => {
        expect((await fetch(`${base}/api/nope`)).status).toBe(404);
    });

    it('still creates a room', async () => {
        expect((await fetch(`${base}/api/rooms`, { method: 'POST' })).status).toBe(201);
    });
});
```

**Step 2: Run**

```bash
bun test src/server
```
Expected: PASS. (This suite is only meaningful with a built `dist/`; it fails
loudly rather than skipping, because by this point `bun run compile` is the
documented way to produce the binary and it always builds first.)

**Step 3: Commit**

```bash
but commit server/standalone-binary -m "test(server): cover the compiled binary's asset wiring" --changes <ids>
```

---

### Task 9: Compile scripts

**Files:**
- Modify: `package.json`

**Step 1: Add the scripts**

```json
"compile": "bun run build && bun scripts/generateEmbeddedAssets.ts && bun build --compile --bytecode --outfile mules-court src/server/standalone.ts",
"compile:linux-x64": "bun run build && bun scripts/generateEmbeddedAssets.ts && bun build --compile --target=bun-linux-x64 --outfile dist-bin/mules-court-linux-x64 src/server/standalone.ts",
"compile:linux-arm64": "bun run build && bun scripts/generateEmbeddedAssets.ts && bun build --compile --target=bun-linux-arm64 --outfile dist-bin/mules-court-linux-arm64 src/server/standalone.ts",
"compile:darwin-arm64": "bun run build && bun scripts/generateEmbeddedAssets.ts && bun build --compile --target=bun-darwin-arm64 --outfile dist-bin/mules-court-darwin-arm64 src/server/standalone.ts",
"compile:windows-x64": "bun run build && bun scripts/generateEmbeddedAssets.ts && bun build --compile --target=bun-windows-x64 --outfile dist-bin/mules-court-windows-x64.exe src/server/standalone.ts"
```

`--bytecode` is only on the native build: it is a startup optimisation and Bun
does not apply it to every cross-target. Drop it from `compile` if it errors on
your Bun version.

**Step 2: Add `dist-bin/` and the binary to `.gitignore`**

```
# Compiled distributables (bun build --compile)
dist-bin/
mules-court
mules-court.exe
```

**Step 3: Build and verify from an empty directory**

```bash
bun run compile
ls -lh mules-court
mkdir -p /tmp/mules-empty && cd /tmp/mules-empty
MULES_PORT=39121 <repo>/mules-court &
sleep 1
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://localhost:39121/
curl -s http://localhost:39121/assets/index-*.js | wc -c   # compare to dist/
kill %1
```

**Step 4: Commit**

```bash
but commit server/standalone-binary -m "build: compile the game into a single distributable binary" --changes <ids>
```

---

### Task 10: Full verification gate

```bash
bun run test        # engine (Vitest) + server (bun test)
bunx tsc --noEmit   # the only type check this project has
bun run build       # production bundle still builds
bun run compile     # and still compiles
```

Also verify the type gate survives a clone that has never built:

```bash
mv dist /tmp/dist-parked && bunx tsc --noEmit; mv /tmp/dist-parked dist
```
Expected: silent. This is what `@ts-nocheck` on the generated file buys.

---

### Task 11: Documentation

**Files:**
- Modify: `AGENTS.md` (setup-commands table, a short "Distributable binary" section)
- Modify: `README.md` (how to run the downloaded binary)
- Modify: `docs/plans/2026-07-24-uix-implementation-plan.md` (mark D3 closed)

Cover: the four env variables and their defaults; that the database is written
relative to the working directory; that the manifest is generated and committed
and must be regenerated whenever `dist/` changes; and the ~61 MB (macOS ARM) /
~100 MB (Linux) size, which is Bun's runtime rather than the game.

---

## Deferred

**Size.** ~61 MB native, ~100 MB cross-compiled. Unavoidable with `--compile`;
`--bytecode` trims startup, not size.

**Signing and notarisation.** An unsigned macOS binary is quarantined on
download and needs a right-click → Open, or `xattr -d com.apple.quarantine`.
Real distribution wants a Developer ID and a notarised zip; out of scope here.

**Multi-target CI.** The `compile:*` scripts exist but nothing runs them on a
tag. A release workflow that builds four targets and attaches them to a GitHub
release is the natural follow-up.
