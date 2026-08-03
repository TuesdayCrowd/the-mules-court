# Standalone Binary Implementation Plan

> **Status: complete.** Executed 2026-07-27 and merged in
> [#21](https://github.com/TuesdayCrowd/the-mules-court/pull/21) (the binary) and
> [#23](https://github.com/TuesdayCrowd/the-mules-court/pull/23) (two follow-up
> fixes). This document has been revised to match the code that shipped, so the
> blocks below can be read as a record rather than a proposal — every one of them
> compiles and passes as written. Where execution diverged from the original
> plan, [What execution changed](#what-execution-changed) says how and why.

**Goal:** Ship The Mule's Court as a single self-contained executable — server, client bundle and every asset in one file that runs from any directory with no `dist/`, no `bun install`, and no repo checkout.

**Architecture:** `bun build --compile` already handles the server half; the client half is the interesting one. `serveStatic` reads the real filesystem under `MULES_STATIC_ROOT`, and a compiled binary has no `dist/` to point at. Rather than fork the routing rules, this splits static hosting into **policy** (decode → refuse a `..` segment → exact hit → SPA fallback → 404, shared) and **lookup** (filesystem *or* embedded map, swappable). A codegen step walks `dist/` and emits one `with { type: 'file' }` import per file plus a `Map<urlPath, embeddedPath>`; a second entrypoint, `standalone.ts`, wires that map into the same policy. `index.ts` keeps its behaviour, so `bun run serve` and all 23 pre-existing `static.test.ts` cases go on exercising the real filesystem — unedited.

**Tech Stack:** Bun 1.3.14 (`--compile`, `--bytecode`, import attributes, `bun:sqlite`), TypeScript 5.7, Vite 6, `bun test`.

---

## Why these shapes

**Why a second entrypoint rather than a flag on the first.** `index.ts` branches on `config.staticRoot !== null`. Adding an `embedded` mode there would mean the production server carries a manifest of a `dist/` it may not have built, and every server test would boot code holding the whole client. A separate entrypoint keeps the import graph honest: only the thing being compiled imports the compiled-in assets.

**Why the policy is shared and the lookup is not.** Duplicating "extensionless paths fall back to `index.html`, a missing `.png` stays a 404" in two files guarantees they drift, and the drift would be invisible until someone reported a dead invite link from a downloaded binary. Only the *resolution* step genuinely differs — one resolves against a directory and must refuse traversal, the other does a `Map.get` that cannot escape anything.

**Why the manifest is generated and committed.** Bun resolves `with { type: 'file' }` at bundle time, so the import list cannot be a runtime glob — it must be code. And it must be *committed* code: `standalone.ts` imports it, so a fresh clone missing it fails `bunx tsc --noEmit`, which AGENTS.md names as the only type check this project has. The generated file carries `// @ts-nocheck`, which makes its references to a possibly-absent `dist/` harmless (verified: TS2307 is suppressed) while its explicit `export const EMBEDDED: ReadonlyMap<string, string>` annotation still types correctly at every call site.

**Why `@ts-nocheck` at all.** Three of the seven extensions in `dist/` (`css html js md png txt woff2`) do not type-check as file imports. `vite/client` declares `*.png`, `*.css`, `*.woff2` and `*.txt` as `string` — fine. But `@types/bun` declares `*.html` as `HTMLBundle` (correct for Bun's fullstack dev server, wrong for `type: 'file'`), `*.js` resolves to the real JavaScript module, and `*.md` has no declaration at all. There is no ambient declaration that overrides those, so the generated file opts out of checking and the hand-written code around it stays fully checked.

**Why env-configurable tunables are in scope.** A binary someone downloads has different needs from a repo script: port 3000 was hardcoded, `publicBaseUrl` was baked at `http://localhost:3000` (deferred item **D3** in the UIX plan), and the sqlite file lands wherever the binary was launched from. All three are one function in `config.ts`, and doing them here closed D3.

---

## Stage map

| Stage | Deliverable | Tasks |
| ----- | ----------- | ----- |
| 1 | Env-configurable tunables; D3 closed | 1–2 |
| 2 | Static hosting split into policy + lookup | 3 |
| 3 | Embedded-asset manifest (pure module + CLI) | 4–6 |
| 4 | `standalone.ts` entrypoint and compile scripts | 7–9 |
| 5 | End-to-end verification and docs | 10–11 |
| 6 | Post-merge fixes (PR #23) | 12–13 |

---

### Task 1: Read tunables from the environment

**Files:**
- Modify: `src/server/config.ts`
- Test: `src/server/__tests__/config.test.ts`

`makeConfig` stays pure. The new function is also pure — it takes an env *record* rather than reaching for `Bun.env`, so tests never mutate a global and never leak between files.

**Step 1: Write the failing tests**

Append to `src/server/__tests__/config.test.ts`, importing `envOverrides` alongside the existing `DEFAULT_CONFIG, makeConfig`:

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

    it.each([
        ['zero', '0'],
        ['negative', '-1'],
        ['fractional', '80.5'],
        ['words', 'eighty'],
        ['blank', ''],
        ['out of range', '70000']
    ])('throws on a %s port rather than silently falling back to 3000', (_name, value) => {
        expect(() => envOverrides({ MULES_PORT: value })).toThrow(/MULES_PORT/);
    });

    it('feeds makeConfig to produce a complete config', () => {
        expect(makeConfig(envOverrides({ MULES_PORT: '8123' }))).toEqual({
            ...DEFAULT_CONFIG,
            port: 8123,
            publicBaseUrl: 'http://localhost:8123'
        });
    });
});
```

**Step 2: Run to verify it fails**

```bash
bun test src/server/__tests__/config.test.ts
```
Actual: `SyntaxError: Export named 'envOverrides' not found in module … config.ts`.

**Step 3: Implement**

Append to `src/server/config.ts`:

```ts
export function envOverrides(env: Record<string, string | undefined>): Partial<TransportConfig> {
    // `Partial<T>` makes fields optional but keeps them `readonly`, and every
    // field here is readonly by design — so the accumulator drops the modifier
    // and the return type puts it back.
    const overrides: { -readonly [K in keyof TransportConfig]?: TransportConfig[K] } = {};

    if (env.MULES_PORT !== undefined) {
        // `Number('')` is 0 and `Number(' 80 ')` is 80, so the range check does
        // the work an eager `parseInt` would have got wrong in both directions.
        const port = Number(env.MULES_PORT);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error(`MULES_PORT must be an integer from 1 to 65535, got ${JSON.stringify(env.MULES_PORT)}`);
        }
        overrides.port = port;
        // Deferred item D3: `joinUrl` is built from `publicBaseUrl`, so moving
        // the port and saying nothing about the URL has to move the invite link
        // too — otherwise every guest is sent to a port nothing is serving.
        // Overwritten just below if the deployment names a URL of its own.
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

> The `-readonly` mapped type is not decoration. `Partial<TransportConfig>` keeps
> every field read-only, so the plain version fails `tsc` with five TS2540s —
> **after** `bun test` reported all 14 cases green. That gap is exactly the
> gotcha AGENTS.md documents about Bun transpiling without type-checking.

**Step 4: Run to verify it passes**

```bash
bun test src/server/__tests__/config.test.ts   # 14 pass
bunx tsc --noEmit                              # silent
```

---

### Task 2: Wire the environment into the existing entrypoint

**Files:**
- Modify: `src/server/index.ts` (the `import.meta.main` block and the `./config` import)

**Step 1: Implement**

```ts
if (import.meta.main) {
    // Hosting stays opt-in, set by package.json's `serve` script — the only
    // place that knows this repo builds to dist/, one line from the script
    // producing it. Every other tunable a deployment moves (port, database
    // path, invite-link origin) now arrives through the same door; see
    // `envOverrides`.
    startServer(makeConfig(envOverrides(Bun.env)));
}
```

Change the import to `import { envOverrides, makeConfig } from './config';`.

**Step 2: Verify nothing regressed**

```bash
bun test src/server && bunx tsc --noEmit
```
`MULES_STATIC_ROOT=dist` in the `serve` script still works — it now arrives via `envOverrides` instead of a bespoke read.

---

### Task 3: Split static hosting into policy and lookup

**Files:**
- Create: `src/server/staticAssets.ts`
- Modify: `src/server/index.ts` (`serveStatic` becomes a delegating wrapper)
- Test: `src/server/__tests__/staticAssets.test.ts` (new), plus fixtures
- **Regression gate:** `src/server/__tests__/static.test.ts` — 23 cases, must pass **unedited**

That gate is the point of the task, not a formality. See [What execution changed](#what-execution-changed).

**Step 1: Create the fixtures**

```bash
mkdir -p src/server/__tests__/fixtures
printf '<!doctype html><title>court</title>' > src/server/__tests__/fixtures/shell.html
printf 'PNGDATA' > src/server/__tests__/fixtures/card.png
```

**Step 2: Write the failing tests**

`src/server/__tests__/staticAssets.test.ts` covers the seam — that one policy drives two lookups identically. Highlights (see the file for all 14 cases):

```ts
const EMBEDDED = new Map([
    ['/index.html', SHELL],
    ['/assets/card.png', CARD]
]);

describe('embeddedLookup', () => {
    const lookup = embeddedLookup(EMBEDDED);

    it('serves the shell at the root', async () => {
        expect(await (await serveFrom(lookup, '/')).text()).toContain('court');
    });

    it('infers the content type from the extension, with no MIME table of its own', async () => {
        expect((await serveFrom(lookup, '/assets/card.png')).headers.get('content-type')).toContain('image/png');
    });

    it('falls back to the shell for an extensionless client route', async () => {
        expect(await (await serveFrom(lookup, '/join/K7QX2')).text()).toContain('court');
    });

    it('404s an extensionless traversal instead of answering it with the app shell', async () => {
        expect((await serveFrom(lookup, '/../../etc/passwd')).status).toBe(404);
        expect((await serveFrom(lookup, '/join/../../../etc/shadow')).status).toBe(404);
    });

    it('serves a file whose name merely starts with dots', async () => {
        // The refusal tests whole segments, not substrings: '..png' is a name.
        const dotty = embeddedLookup(new Map([['/assets/..png', CARD]]));
        expect((await serveFrom(dotty, '/assets/..png')).status).toBe(200);
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
        // 'mules.court' looked like it had an extension and the homepage 404ed.
        // Every existing test used a dot-free temp directory, so nothing caught it.
    });

    it('404s an extensionless traversal rather than falling back to the shell', async () => {
        // The same regression from the filesystem side, where the disclosure
        // would be real.
    });

    it('still refuses a traversal at the lookup, as defence in depth', async () => {
        const lookup = filesystemLookup(root);
        expect(await lookup('/../mules-guard-evil/secret.txt')).toBeNull();
    });
});
```

**Step 3: Implement `src/server/staticAssets.ts`**

```ts
import { resolve, sep } from 'node:path';

/** Resolves an already-decoded, in-root request path to a file, or null. */
export type Lookup = (pathname: string) => Promise<Bun.BunFile | null>;

export async function serveFrom(lookup: Lookup, pathname: string): Promise<Response> {
    let decoded: string;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        // A malformed percent-escape is not a path worth guessing at.
        return new Response('Not Found', { status: 404 });
    }

    // Refused here rather than in a lookup, because a lookup can only answer
    // "no file", and "no file" is what triggers the shell fallback below. A
    // traversal that reached that fallback would be answered with the app's
    // homepage and a 200 — `/../../etc/passwd` has no extension, so it reads as
    // a client route. Neither source has a legitimate parent-directory segment:
    // one has no directory to leave, the other must never leave it.
    if (decoded.split('/').includes('..')) {
        return new Response('Not Found', { status: 404 });
    }

    const hit = await lookup(decoded);
    if (hit !== null) return new Response(hit);

    const lastSegment = decoded.slice(decoded.lastIndexOf('/') + 1);
    if (!lastSegment.includes('.')) {
        const shell = await lookup(SHELL_PATH);
        if (shell !== null) return new Response(shell);
    }

    return new Response('Not Found', { status: 404 });
}

/** The app shell every client route falls back to. */
export const SHELL_PATH = '/index.html';

export function filesystemLookup(root: string): Lookup {
    const base = resolve(root);

    return async pathname => {
        const target = resolve(base, '.' + pathname);
        if (target !== base && !target.startsWith(base + sep)) return null;

        // `resolve` strips a trailing separator, so a request for '/' lands on
        // the directory itself. `Bun.file(dir).exists()` is false, which is the
        // answer we want — `serveFrom`'s shell fallback handles it from there.
        const file = Bun.file(target);
        return (await file.exists()) ? file : null;
    };
}

export function embeddedLookup(embedded: ReadonlyMap<string, string>): Lookup {
    return async pathname => {
        const target = embedded.get(pathname === '/' ? SHELL_PATH : pathname);
        if (target === undefined) return null;

        // Not ceremonial: run uncompiled, these are real files that a rebuild
        // can rename out from under a stale manifest.
        const file = Bun.file(target);
        return (await file.exists()) ? file : null;
    };
}
```

The full doc comments in the shipped file carry the reasoning; they are not reproduced here.

**Step 4: Reduce `index.ts`'s `serveStatic` to a wrapper**

It keeps its exported signature, because `static.test.ts` imports it:

```ts
export function serveStatic(root: string, pathname: string): Promise<Response> {
    return serveFrom(filesystemLookup(root), pathname);
}
```

Drop `basename, join, resolve, sep` from `index.ts`'s `node:path` import — nothing else there uses them, and `noUnusedLocals` will fail the build otherwise — and add `import { filesystemLookup, serveFrom } from './staticAssets';`.

**Step 5: Run**

```bash
bun test src/server && bunx tsc --noEmit
```
Expected: PASS, including all 23 pre-existing `static.test.ts` cases with no edits to that file.

---

### Task 4: The manifest as a pure module

**Files:**
- Create: `src/server/embeddedManifest.ts`
- Test: `src/server/__tests__/embeddedManifest.test.ts`

The decision — which files to embed and what source text to emit — is pure and belongs in a tested module. `scripts/` gets only the I/O.

**Step 1: Write the failing tests**

Driven from a fixture tree, so the suite is deterministic and passes on a clone that has never built. The tree deliberately contains two `.DS_Store` files.

```ts
describe('collectAssetFiles', () => {
    it('finds every file at every depth, as URL paths', () => { … });

    it('skips dotfiles at every depth, so .DS_Store is never baked into a binary', () => {
        // public/ is copied into dist/ verbatim, and macOS has already put a
        // .DS_Store in there once. A generator without this filter ships it.
    });

    it('sorts, so an unchanged dist/ regenerates an unchanged manifest', () => { … });
    it('throws on a missing root rather than emitting an empty manifest', () => { … });
    it('throws when the root holds no index.html, because the SPA fallback needs one', () => { … });
});

describe('renderManifest', () => {
    it('emits one file import per asset, resolved from src/server/', () => { … });
    it('maps every URL path to its imported binding', () => { … });
    it('annotates the export, so consumers type-check even though the file does not', () => { … });
    it('opts out of type-checking on its first line', () => { … });
    it('says it is generated and how to regenerate it', () => { … });
    it('is deterministic', () => { … });
    it('renders a usable module for an empty file list', () => {
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
```

**Step 2: Implement `src/server/embeddedManifest.ts`**

```ts
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

/** Where the generated module sits relative to `dist/`, as an import prefix. */
const IMPORT_PREFIX = '../../dist';

/** The app shell; a manifest without one has nothing for a client route. */
const SHELL = '/index.html';

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

    if (!files.includes(SHELL)) {
        // An empty or shell-less manifest compiles fine and 404s everything: a
        // binary that starts, serves nothing, and explains nothing.
        throw new Error(`Asset root ${root} has no ${SHELL} — the SPA fallback would have nothing to serve.`);
    }

    return files;
}

export function renderManifest(files: string[]): string {
    const imports = files
        .map((file, i) => `import a${i} from '${IMPORT_PREFIX}${file}' with { type: 'file' };`)
        .join('\n');

    const entries = files.length === 0 ? '' : `\n${files.map((file, i) => `    ['${file}', a${i}]`).join(',\n')}\n`;

    return `// @ts-nocheck
/**
 * GENERATED — do not edit. Run \`bun run compile\` to regenerate.
 * … (header explaining the path-not-bytes semantics and the @ts-nocheck) …
 */
${imports}

export const EMBEDDED: ReadonlyMap<string, string> = new Map([${entries}]);
`;
}
```

`posix.join` builds the URL key while native `join` walks the filesystem — that is what keeps the manifest free of backslashes when generated on Windows.

Note what is **not** filtered: the markdown and text files Vite copies from `public/` are embedded too. Dropping them would be a silent cap on what the binary serves, and `dist/` is the deliverable — if a file should not ship, it should not be in `public/`.

**Step 3: Run**

```bash
bun test src/server/__tests__/embeddedManifest.test.ts
```
Expected: 12 pass, and the `committed manifest` case **failing** until Task 5 generates the file. (It skips only when `dist/` itself is absent.)

---

### Task 5: The generator CLI

**Files:**
- Create: `scripts/generateEmbeddedAssets.ts`

```ts
/**
 * Regenerates `src/server/embeddedAssets.generated.ts` from `dist/`.
 *
 * Thin by design: every decision lives in `src/server/embeddedManifest.ts`,
 * which is tested against a fixture tree. This file adds a read of the real
 * directory and one write, and is meant to be reviewed by reading.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectAssetFiles, renderManifest } from '../src/server/embeddedManifest';

const repoRoot = join(import.meta.dir, '..');
const distRoot = join(repoRoot, 'dist');
const outPath = join(repoRoot, 'src', 'server', 'embeddedAssets.generated.ts');

const files = collectAssetFiles(distRoot);
writeFileSync(outPath, renderManifest(files));

console.log(`Embedded ${files.length} files from dist/ → src/server/embeddedAssets.generated.ts`);
```

**Run it:**

```bash
bun run build && bun run generate:assets
```
Actual: `Embedded 30 files from dist/ → src/server/embeddedAssets.generated.ts` — the count tracks whatever `dist/` holds.

Then `bun test src/server/__tests__/embeddedManifest.test.ts` is 13/13 and `bunx tsc --noEmit` is silent. **Commit the generated file.**

---

### Task 6: (folded into Task 3)

`embeddedLookup` shipped with the policy split and its tests live in
`staticAssets.test.ts`. Kept as a numbered placeholder so later task numbers
match the commit history.

---

### Task 7: The standalone entrypoint

**Files:**
- Create: `src/server/standalone.ts`
- Modify: `src/server/index.ts` (`startServer` takes an optional static handler)

Differences from `index.ts`'s `main` block, all of which exist because someone
downloaded this rather than checking it out: static bytes come from the manifest;
a banner names the URL, the resolved database path and the asset count; and
`SIGINT`/`SIGTERM` close sqlite before exiting.

**Step 1: Make `startServer` accept a static handler**

```ts
/**
 * Answers a request for a static path. `standalone.ts` passes one backed by the
 * compiled-in manifest; everything else leaves it null and gets `config
 * .staticRoot`, or no hosting at all.
 */
export type StaticHandler = (pathname: string) => Promise<Response>;

export function startServer(config: TransportConfig, serveAsset: StaticHandler | null = null): RunningServer {
```

and in `fetch`:

```ts
            // An explicit handler wins over a directory: a binary carries its
            // client inside itself and never sets `staticRoot`, so the two are
            // alternatives rather than layers.
            if (serveAsset !== null) return serveAsset(url.pathname);
            if (config.staticRoot !== null) return serveStatic(config.staticRoot, url.pathname);
```

The default keeps every existing call site unchanged.

**Step 2: Implement `src/server/standalone.ts`**

```ts
import { resolve } from 'node:path';
import { envOverrides, makeConfig } from './config';
import { EMBEDDED } from './embeddedAssets.generated';
import { startServer } from './index';
import { embeddedLookup, serveFrom } from './staticAssets';

const config = makeConfig(envOverrides(Bun.env));
const lookup = embeddedLookup(EMBEDDED);
const running = startServer(config, pathname => serveFrom(lookup, pathname));

// Say where the database went. It is created relative to the working directory,
// so a binary launched by double-click from a downloads folder writes there —
// silently, which is the kind of thing someone finds a week later.
const database = config.dbPath === ':memory:' ? 'in memory (nothing written)' : resolve(config.dbPath);

console.log(
    [
        ``,
        `  The Mule's Court`,
        ``,
        `  Playing at   ${config.publicBaseUrl}`,
        `  Database     ${database}`,
        `  Assets       ${EMBEDDED.size} files compiled in`,
        ``,
        `  MULES_PORT, MULES_DB_PATH and MULES_PUBLIC_BASE_URL change any of the above.`,
        `  Press Ctrl-C to stop.`,
        ``
    ].join('\n')
);

// A hard kill leaves sqlite's write-ahead log behind. `stop()` closes the store
// and force-closes every live socket, which is the teardown path the transport
// tests already exercise.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        console.log('\n  Stopping…');
        running.stop();
        process.exit(0);
    });
}
```

**Step 3: Verify it runs uncompiled**

```bash
MULES_PORT=39119 MULES_DB_PATH=:memory: bun src/server/standalone.ts &
```
Actual: banner printed with `Playing at http://localhost:39119` — D3 visibly closed —
then `/` → `200 text/html`, `/favicon.png` → `200 image/png`, `/join/K7QX2` → `200`,
`/assets/missing.png` → `404`, `POST /api/rooms` → `201`.

---

### Task 8: Cover the standalone wiring with a test

**Files:**
- Test: `src/server/__tests__/standalone.test.ts`

Booting `standalone.ts` from a test would bind a port and install signal handlers,
so the test drives the same wiring: `startServer` with an embedded handler and no
`staticRoot`. Unlike `static.test.ts`, it runs against the **real committed
manifest**, so it fails if a rebuild renamed a hashed chunk and nobody regenerated.

**Nothing here may name a file in the manifest** — see Task 13, which is where
that rule came from.

```ts
/**
 * Any manifest entry with the given extension.
 *
 * The manifest is regenerated from dist/ on every build, so nothing here may
 * name one of its files: the hashed chunks move, and the rest are only whatever
 * `public/` happened to hold that day. `/index.html` is the one exception, and
 * it is a contract rather than content: `collectAssetFiles` refuses to emit a
 * manifest without it.
 */
function anyAssetEndingIn(extension: string): string {
    const hit = [...EMBEDDED.keys()].find(path => path.endsWith(extension));
    if (hit === undefined) throw new Error(`No ${extension} file in the manifest to probe with`);
    return hit;
}

it('serves every asset the shell references, which is what proves the client can boot', async () => {
    // Derived from the shell rather than named here — and the stronger claim:
    // not "a JavaScript file is reachable" but "every URL the app requests to
    // boot is served by the binary".
    const shell = await (await fetch(`${base}/`)).text();
    const referenced = [...shell.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map(match => match[1]);
    expect(referenced.length).toBeGreaterThan(0);

    const served = await Promise.all(
        referenced.map(async path => `${path} → ${(await fetch(`${base}${path}`)).status}`)
    );
    expect(served).toEqual(referenced.map(path => `${path} → 200`));
});

it('404s a missing asset rather than pretending it is the homepage', async () => {
    // Checked rather than assumed: the whole point of the case is that the path
    // is absent from the manifest, and the manifest is regenerated from dist/.
    const absent = '/assets/definitely-not-in-the-manifest.png';
    expect(EMBEDDED.has(absent)).toBe(false);
    expect((await fetch(`${base}${absent}`)).status).toBe(404);
});
```

Plus: the shell serves with `text/html`, `anyAssetEndingIn('.png')` returns
`image/png`, an invite route falls back to the shell, an unknown `/api/` path
404s, `POST /api/rooms` returns 201 with `hostSeat: 'p1'`, and a WebSocket still
upgrades. Eight cases.

---

### Task 9: Compile scripts

**Files:**
- Modify: `package.json`, `.gitignore`

```json
"build": "bun log.js build && bunx --bun vite build --config vite/config.prod.mjs && bun run generate:assets",
"build-nolog": "bunx --bun vite build --config vite/config.prod.mjs && bun run generate:assets",
"generate:assets": "bun scripts/generateEmbeddedAssets.ts",
"compile": "bun run build && bun build --compile --bytecode --outfile mules-court src/server/standalone.ts",
"compile:darwin-arm64": "bun run build && bun build --compile --target=bun-darwin-arm64 --outfile dist-bin/mules-court-darwin-arm64 src/server/standalone.ts",
"compile:darwin-x64":   "bun run build && bun build --compile --target=bun-darwin-x64   --outfile dist-bin/mules-court-darwin-x64   src/server/standalone.ts",
"compile:linux-x64":    "bun run build && bun build --compile --target=bun-linux-x64    --outfile dist-bin/mules-court-linux-x64    src/server/standalone.ts",
"compile:linux-arm64":  "bun run build && bun build --compile --target=bun-linux-arm64  --outfile dist-bin/mules-court-linux-arm64  src/server/standalone.ts",
"compile:windows-x64":  "bun run build && bun build --compile --target=bun-windows-x64  --outfile dist-bin/mules-court-windows-x64.exe src/server/standalone.ts"
```

`build` ends with `generate:assets` — see Task 12 for why that is not optional.
That is also why no `compile:*` script regenerates: `build` already did.

`--bytecode` is verified working on the native target with Bun 1.3.14. It trims
startup, not size.

`.gitignore` additions:

```
# Compiled distributables (`bun run compile`). ~71 MB native, ~100 MB
# cross-compiled — Bun's runtime, not the game. The *manifest* they embed
# (src/server/embeddedAssets.generated.ts) is generated but deliberately
# committed: standalone.ts imports it, so a clone without it fails tsc.
mules-court
mules-court.exe
dist-bin/

# Interrupted `bun build --compile` leaves these behind
.*.bun-build
```

**On Windows.** `bun run compile` there produces `mules-court.exe`: Bun appends
`.exe` whenever the target is Windows, even though `--outfile` says
`mules-court`. Verified by cross-compiling with `--target=bun-windows-x64` and an
extensionless `--outfile`, which wrote `mules-court.exe`, a PE32+ console
executable. (Verified that way, not on Windows hardware — a native compile
resolves the host as the target and takes the same naming path.) Both names are
gitignored. Two further Windows hazards do not apply: `bun run` executes
package.json scripts through Bun's own cross-platform shell, so the `&&` chains
and `serve`'s `MULES_STATIC_ROOT=dist …` prefix work there.

---

### Task 10: Full verification gate

```bash
bun run test        # engine + client (Vitest), then server (bun test)
bunx tsc --noEmit   # the only type check this project has
bun run build
bun run compile
```

Result: the whole Vitest suite plus **255 `bun test` cases across 18 files**, 0
failures; `tsc` silent; a 71 MB binary. This work added three of those server
files — `staticAssets` (14), `embeddedManifest` (13), `standalone` (8) — while
`static.test.ts` stayed at its pre-existing 23, unedited. The Vitest total is
deliberately not quoted: other workstreams move it, and a number here would go
stale without anything being wrong.

Also verify the type gate survives a clone that has never built:

```bash
mv dist /tmp/dist-parked && bunx tsc --noEmit; mv /tmp/dist-parked dist
```
Actual: silent. This is what `@ts-nocheck` on the generated file buys.

**And the acceptance test the rest of the gate cannot give you** — copy the
binary into an empty directory and run it there:

| Probe | Result |
| --- | --- |
| `/`, `/join/K7QX2` | `200 text/html` |
| bundle, CSS, font, portrait, favicon | `200`, correct type per extension |
| Byte counts vs `dist/` | identical, for the bundle and a portrait |
| `/assets/nope.png`, `/api/nope` | `404` |
| `POST /api/rooms` | `201`, real matchId + seat token |
| `joinUrl` under `MULES_PORT=39123` | `http://localhost:39123/join/…` |
| Files written to the launch directory | `mules-court.sqlite` only |
| SIGINT | clean stop, no `-wal`/`-shm` left |

---

### Task 11: Documentation

- `AGENTS.md` — `compile` in the setup table, and a **The single-file binary** section covering the three load-bearing facts (one policy over two lookups; the manifest is generated-but-committed and why `@ts-nocheck`; a `type: 'file'` import is a path, not bytes).
- `README.md` — the four environment variables as a table, an **As a single binary** subsection, and a corrected Status block.
- `docs/plans/typescript/2026-07-24-uix-implementation-plan.md` — **D3 marked closed**, with the reason it became urgent: the default is baked into a binary handed to someone who did not compile it.

---

### Task 12: Make `build` regenerate the manifest — PR #23

**Files:** `package.json`

The manifest names content-hashed chunks, so any client rebuild invalidates it.
Only `bun run compile` regenerated, which meant a bare `bun run build` left the
committed manifest naming files that no longer exist — and the next `bun run
test` failed on Task 4's coverage gate, for a reason unrelated to whatever the
person was working on.

Not hypothetical. It happened within fifteen minutes of #21 merging: the
visual-harness workstream rebuilt `dist/`, and a later compile died with
`Could not resolve "../../dist/assets/index-BClNheiK.js"`. The gate did its job;
the trigger was someone else's ordinary build.

The manifest is a function of `dist/`, so whatever produces `dist/` now produces
it: `build` and `build-nolog` end with `generate:assets`, and the five
`compile:*` scripts drop the now-redundant step. Verified: a bare `bun run build`
leaves the gate green at 13/13.

---

### Task 13: Stop the tests hardcoding manifest contents — PR #23

**Files:** `src/server/__tests__/standalone.test.ts`

The manifest's contents are ephemeral, so a test may not name them.
`standalone.test.ts` named two: `/assets/index-` (Vite's chunk-naming
convention) and `/favicon.png` (a `public/` file). Either would fail on a rename
that broke nothing — the wrong signal from the file guarding the binary's wiring.

Every probe is derived now; see Task 8 for the shape. `/index.html` stays named
because it is a contract, not content.

Verified by mutation rather than by passing: dropping the stylesheet's map entry
from the manifest fails exactly the boot test, with

```
-   "/assets/index-B6TlxzVp.css → 200",
+   "/assets/index-B6TlxzVp.css → 404",
```

and it passes again when restored.

---

## What execution changed

Recorded because the tasks above were revised to match the code, and a reader
comparing them to the original commits deserves the difference rather than a
puzzle.

**Traversal became a policy rule, not a lookup concern (Task 3).** The original
`serveFrom` let a lookup answer only "file" or `null`, and `null` is what
triggers the shell fallback — so `/../../etc/passwd` was refused by
`filesystemLookup`, fell through to the fallback, and came back **200** with the
homepage, because `passwd` has no extension and reads as a client route. Three
`static.test.ts` cases failed immediately. `serveFrom` now refuses any decoded
path with a `..` segment before it looks anything up, which fixes both sources at
once and closes the same hole on the embedded side, which had no guard at all.
The `resolve`-and-prefix check stays as defence in depth. **This is the whole
reason the plan insisted `static.test.ts` pass unedited** — adjusting those three
assertions to match the new behaviour would have shipped the hole.

**`envOverrides` needed a mutable accumulator (Task 1).** `Partial<T>` makes
fields optional but keeps them `readonly`. `bun test` passed while `tsc` failed
with five TS2540s, which is the gotcha AGENTS.md documents.

**The `static.test.ts` case count was wrong throughout.** The original plan,
several commit messages and PR #21 all said "13 existing static tests". The file
has **23**, and always did. Corrected here; the claim it supported — that the
file passes unedited — was and is true.

**Two follow-ups landed after #21 merged**, as Tasks 12 and 13: `build` now
regenerates the manifest, and the standalone tests no longer name manifest
contents.

**Sizes were quoted from a pre-embedding spike.** "~61 MB" described the server
binary *before* the client was compiled in, and it reached three shipped source
comments and `.gitignore` before being corrected. Measured values are in
[Deferred](#deferred).

**Windows output naming was an open question, now answered** — see Task 9.

**Smaller deviations.** Task 6 folded into Task 3 as planned, and `SHELL_PATH`
ended up used by `serveFrom` and `embeddedLookup` rather than by the generator.
`renderManifest` special-cases the empty list so it emits `new Map([])` rather
than a literal with a blank line in it. `standalone.ts` resolves the database
path with `node:path`'s `resolve` rather than `Bun.pathToFileURL`, and its banner
carries no version string — there is no single source for one to read.

---

## Deferred

**Size.** Measured with Bun 1.3.14, this `dist/` (30 files), `ls -lh`:

| Target | Size |
| --- | --- |
| macOS ARM native, `--bytecode` | 71 MB |
| `bun-linux-arm64` | 99 MB |
| `bun-linux-x64` | 100 MB |
| `bun-windows-x64` | 104 MB |

That is Bun's runtime, not the game, and unavoidable with `--compile`.
`--bytecode` trims startup, not size.

**Signing and notarisation.** An unsigned macOS binary is quarantined on
download and needs a right-click → Open, or `xattr -d com.apple.quarantine`.
Real distribution wants a Developer ID and a notarised zip; out of scope here.

**Multi-target CI.** The five `compile:*` scripts exist but nothing runs them on
a tag. A release workflow that builds them and attaches the results to a GitHub
release is the natural follow-up.

**Whether the manifest should be committed as a stub.** Its contents are
ephemeral — the file exists so `standalone.ts` type-checks on a clone that has
never built, and any build overwrites it — so the committed values are arbitrary
and churn whenever someone commits after a build. A stub (empty map, no imports,
still type-checks) would remove the churn at the cost of a committed file that is
never accurate, and would change what a fresh clone's `bun test` sees before its
first build. Raised on PR #23; not decided.

**Only `bun-darwin-arm64` and the host have been run.** The Linux and Windows
binaries in the size table were compiled and inspected, not executed.
