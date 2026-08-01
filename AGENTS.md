# AGENTS.md

Guidance for coding agents working in this repository. Human contributors are welcome to read it too — everything here is equally true for people.

## Project overview

**The Mule's Court** is a _Love Letter_-style deduction/elimination card game reskinned into Isaac Asimov's Foundation universe (2–4 players, first to N Devotion Tokens wins). The complete game design — rules, turn structure, and all 11 card types with values/counts/abilities — lives in `README.md`. Treat that file as the gameplay spec.

**Status:** three of the four layers are **built and tested**. The headless game engine (`src/game/engine/`, Vitest), the WebSocket transport that wraps it (`src/server/`, `bun test`), and now the client's browser-independent half (`src/client/`, Vitest) — its pure layer of geometry, copy, state and palette, plus the whole DOM chrome, all testable under Node and jsdom with no socket.

The table is DOM too: `src/client/ui/table.ts` draws it, `src/client/ui/beats.ts` runs the cinematic beats on the Web Animations API, and `src/main.ts` is the composition root that wires store, socket and surfaces together. **A match is playable in a browser.** Every stage of `docs/plans/2026-07-24-uix-implementation-plan.md` is complete bar the real-device QA pass (Task 34), which needs hardware and a person — see `docs/plans/2026-07-24-uix-qa-checklist.md`.

A fifth layer now sits beside those four: `src/mcp/` supplies the opponents. It is a Model Context Protocol server that seats a model at two or three chairs of a live table, so a person can play a four-player match alone — see [MCP seat server](#mcp-seat-server-srcmcp).

## Setup commands

Requires [Bun](https://bun.sh).

| Command                                     | Description                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `bun install`                               | Install dependencies                                                      |
| `bun run dev`                               | Client dev server at `http://localhost:8080` — **needs `dev:server` too** |
| `bun run dev:server`                        | The API and WebSocket half, on `:3000`. Run it in a second terminal        |
| `bun run dev:host`                          | Like `dev`, but reachable from other devices on the network               |
| `bun run build`                             | Production build to `dist/`                                               |
| `bun run compile`                           | Single-file executable → `./mules-court` (see below)                      |
| `bun run mcp`                               | The MCP seat server on stdio. Needs a game server running                 |
| `bun run compile:mcp`                       | Single-file MCP executable → `./mules-court-mcp`                          |
| `bunx tsc --noEmit`                         | Type-check (see gotcha below — this is the only way to catch type errors) |

### Running in dev takes two processes

The client calls `POST /api/rooms` and opens a WebSocket, so `bun run dev` alone
gives an `ECONNREFUSED` on the first click of *Host a game*. Run both:

```bash
bun run dev:server   # :3000 — API and WebSocket
bun run dev          # :8080 — client, proxying /api and /ws to :3000
```

`dev:server` deliberately sets no `MULES_STATIC_ROOT`: Vite serves the client in
dev, so the backend only answers `/api/rooms` and the socket upgrade. `bun run
serve` is the production shape — one process serving the built `dist/` as well.

**`dev:server` runs under `bun --watch`, and that is load-bearing.** The two
processes share `src/game/engine/`: Vite hot-reloads the client the instant an
engine file changes, while a plain `bun src/server/index.ts` keeps running the
engine it booted with. The halves then disagree about the shape of a
`RedactedView`, and the symptoms do not look like a version skew at all — one
added field presented first as "cards stopped being clickable" (a `TypeError`
in the only handler that opens the action sheet) and then as a *rule* being
misreported, with an unprotected opponent announced as protected. Restarting
the backend was the cure for both. `--watch` means it never needs diagnosing.

A restart is safe mid-match by design: rooms persist `{seed, actionLog}` rather
than a state snapshot and are rebuilt lazily by `roomRegistry`, while the client
reconnects with backoff and `RESUME_SEAT`. `bun run serve` stays unwatched —
it is the production shape.

### Testing on a phone

`bun run dev:host` binds Vite to the network and prints the address to open.
Only Vite needs it — the backend stays on `localhost`, because the proxy reaches
it from the dev machine rather than from the device.

**Everything served this way is a non-secure context**, and two browser APIs
simply do not exist there:

- `crypto.randomUUID` — used for `clientMsgId`. Guarded in
  `src/client/store/ids.ts`, which prefers it and falls back when it is absent.
  Calling it bare took the whole Play path down once already.
- `navigator.clipboard` — the lobby's **Copy** button. `src/client/ui/clipboard.ts`
  prefers it and falls back to a `document.execCommand('copy')` selection copy,
  which still works in a non-secure context. **Copy therefore works on a phone.**
  The fallback runs synchronously inside the click, because browsers only honour
  `execCommand` during a user gesture — awaiting anything first would put it
  outside the gesture and fail for a second, subtler reason.

The invite link the lobby displays is built from `location.origin`, so it points
at the address the device is actually using and can be shared with a second
device. The server's own `joinUrl` field still says `localhost:3000` (deferred
item D3) — the client never reads it, but do not copy it out of a log and expect
it to work.

**The dev script does not use `--bun`, and that is load-bearing.** Vite's
WebSocket proxy silently fails under Bun: `/api` proxies fine, the socket upgrade
hangs with no error in any log, and the client sits on *Connecting* forever.
Verified both ways — the same config that times out under `bunx --bun vite`
connects immediately under `bunx vite`. `build` still uses `--bun`, which is
fine: nothing is proxied during a build.

## Testing instructions

Two test runners and three suites. Engine **and client** tests run under **Vitest** (`bun run test:engine` — the name predates the client; `vitest.config.ts` collects `src/game/**/*.test.ts` and `src/client/**/*.test.ts`). Server/transport tests run under **Bun's own test runner** (`bun run test:server`, i.e. `bun test src/server`), and so do the MCP tests (`bun run test:mcp`). The split isn't stylistic: Vitest's workers run under Node, which can load neither `bun:sqlite` nor the Bun globals the transport depends on, so `src/server/` has to run on `bun test` instead — and `src/mcp/` inherits that, since it opens real WebSockets and spawns its own server as a subprocess. `bun run test` runs all three in sequence. There is still **no linter** configured.

**`vitest.config.ts` enumerates globs while the two `bun test` scripts name directories**, so a new top-level directory under `src/` is type-checked automatically (`tsconfig.json` includes `src` wholesale) but is **silently untested** until a script names it. That asymmetry is how a suite rots; `test:mcp` exists because of it.

Client tests default to the **Node** environment; a file needing a DOM opts in with a `// @vitest-environment jsdom` docblock on its first line. Vitest 4 removed `environmentMatchGlobs`, and the docblock keeps that choice beside the code that needs it.

Three gates worth knowing about, because they fail for reasons that are not obvious:

- **`src/client/__tests__/purity.test.ts`** — `layout/`, `content/`, `store/` and `tokens/` may not reach a DOM global or import server *runtime* (one documented exception: `content/nickname.ts` takes the nickname limit from `src/server/config.ts`, which has zero imports). It reads raw file text, so a *comment* naming a banned global fails too.
- **`src/client/__tests__/axe.test.ts`** — axe-core over every DOM surface, the table included. `color-contrast` is the only disabled rule, because jsdom has no layout; contrast is covered arithmetically in `src/client/tokens/contrast.test.ts` instead.
- **`src/client/layout/discardCapacity.test.ts`** — drives thousands of real matches through the engine to prove the layout reserves room for the deepest discard pile that can actually occur (eight, not the seven the design states).

The verification gate before considering any change done is:

```bash
bun run test        # engine/client (Vitest) + server + MCP (bun test)
bunx tsc --noEmit    # neither vite build nor the dev server type-checks; this is the only type check
bun run build        # confirm the production bundle still builds
```

## Architecture

### Tech stack

Vite 6 · TypeScript 5.7 · Bun, and **no runtime dependencies at all** — `package.json` declares none. The client ships as a static bundle; a small Bun backend (`src/server/`) now exists to host multiplayer matches over WebSocket — see [Server (transport layer)](#server-transport-layer) below.

### Bootstrap

`index.html` loads `src/main.ts`, which is the composition root: it constructs
the store, the socket, the chrome, the table and the beat runner, and wires them
together.

The table is DOM. `src/client/ui/table.ts` mounts into `#game-container` —
absolutely-positioned elements placed at the rects `computeLayout` and
`buildRenderPlan` return — with `src/client/ui/beats.ts` drawing the cinematic
beats into a transient layer above it on the Web Animations API. `#ui-root`
sits over both and holds the chrome (menu, lobby, action sheet, overlays).

Two rules about the table read as arbitrary and are not:

**Asset paths are absolute (`/assets/…`), and that is load-bearing.** A relative
path resolves against `/join/:matchId`, which the SPA fallback answers with
`index.html` and a **200** — so nothing 404s; the browser decodes HTML as an
image and silently renders nothing. `assetUrl()` in `table.ts` is the single
definition, exported so the beats share it. Same reason Vite's `base` is `/`.

**Geometry is data, and the renderer only obeys it.** `computeLayout` and
`buildRenderPlan` decide every position and size; `table.ts` may not re-derive,
pad, or round any of it. Every visual bug this table has shipped was that rule
being broken, and they rhyme: an unsized `<img>` rendering at its natural size,
a text line box overrunning a band budgeted in pixels, a scrim inventing its own
padding, an element anchored twice, and a global `object-fit` that was wrong for
one box's meaning. When adding to the table, put the *decision* in a pure module
and let the renderer walk the result.

**`src/client/ui/tableContract.test.ts` guards the first half of that** by
reading `table.ts` as text and asserting every field the pure layer publishes is
named. It cannot prove a field is *obeyed* — the nickname scrim read
`nameBandH` and then let text metrics decide its height, which passed — so its
`NOT_DRAWN` allowlist is only as strong as the scrutiny applied to each entry's
reason. "`fit-content` needs no explicit height" was mechanically true and
substantively wrong, and hid a real overlap.

### Build config

Two Vite configs in `vite/`, selected per script:

- `config.dev.mjs` — dev server on port 8080.
- `config.prod.mjs` — Terser minification (2 passes, comments stripped) + a small `buildBanner` plugin.

Both use `base: '/'` (absolute asset paths); neither splits chunks, the whole client being ~86 KB of JS. The base is **not** relative, and deliberately so: the client owns the `/join/:matchId` route (*UIX §2.6*), and a relative base resolves `./assets/index-abc.js` against `/join/` on a real invite link, so the app never boots. The dev config also proxies `/api` and `/ws` to the server on :3000, which is what lets `socketUrl()` derive one same-origin URL for dev and production alike.

### Client (`src/client/`)

Everything the client can decide without a browser, so Vitest can hold it to the
design in a plain Node process. Full design: `docs/plans/2026-07-23-uix-design.md`.

**The pure layer** — no DOM, no ambient globals, enforced by
`__tests__/purity.test.ts`:

- `tokens/` — the palette as integers, mirroring `styles/tokens.css`, with a drift test and a WCAG contrast check. `hex()` converts one to the `#rrggbb` string every style declaration wants.
- `content/` — every string a player reads: card copy, quick reference, log narration, failure copy, nickname rules, the countdown.
- `layout/` — table geometry as data. `computeLayout(input) → LayoutSpec` across three topology classes, plus `tableMetrics.ts`'s fractions and floors; `ui/table.ts` consumes a spec rather than computing one.
- `store/` — the WebSocket, the seat token, route parsing, room creation, and one immutable `ClientState` that never derives a game rule.

**The DOM layer** — `ui/`, one factory per surface with `mount`/`update`/`destroy`.
Menu, join, lobby, action sheet, quick reference, seat dossier, overlays, fatal
screen, toasts, connection dot, and the table itself. No surface reads the
store; `update(state)` is pushed by a single subscriber.

**Styles** — `styles/fonts.css` (self-hosted Exo 2 and Inter), `tokens.css`
(authoritative palette), `ui.css` (the two-layer shell plus component styling).
The pointer-events discipline lives in `ui.css` and is tested against the real
file, not a stub.

### The single-file binary

`bun run compile` produces `./mules-court` — Bun's runtime, the server and every
client asset in one ~71 MB executable that runs from any directory with nothing
installed. Cross-compile with `compile:linux-x64` and friends, which land in
`dist-bin/`.

Three things about it are load-bearing:

**Static hosting is one policy over two lookups** (`src/server/staticAssets.ts`).
`serveFrom` owns the rules — decode, refuse a `..` segment, exact hit, shell
fallback for an extensionless path, 404 otherwise. `filesystemLookup` resolves
against a directory and refuses traversal; `embeddedLookup` reads the compiled-in
manifest. `index.ts` keeps the filesystem path and is what `serve` and every
transport test exercise; `standalone.ts` is the same server with the other
lookup. **Do not fork the policy.** Drift there shows up as a dead invite link
from a downloaded binary, with nothing in this repo's test run to catch it — and
it nearly did: collapsing "refused" and "not found" into one `null` made
`/../../etc/passwd` fall through to the shell and answer **200**, because it has
no extension and reads as a client route. `__tests__/static.test.ts` caught it,
which is why that file must keep passing **unedited** through any change here.

**`src/server/embeddedAssets.generated.ts` is generated but committed.** Bun
resolves `with { type: 'file' }` at bundle time, so the file list cannot be a
runtime glob — it must be source, emitted by `scripts/generateEmbeddedAssets.ts`
from the tested pure module `embeddedManifest.ts`. It is committed because
`standalone.ts` imports it and a clone without it fails `bunx tsc --noEmit`. It
carries `// @ts-nocheck`, which is not laziness: `@types/bun` types `*.html` as
`HTMLBundle` (right for its fullstack dev server, wrong for `type: 'file'`),
`*.js` resolves to the real module, and `*.md` has no declaration at all. The
opt-out is also what makes its references to an unbuilt `dist/` harmless. The
annotated `export const EMBEDDED: ReadonlyMap<string, string>` keeps every call
site checked. **Regenerate rather than edit**, and regenerate after any client
build — the content-hashed chunk names move, and a stale manifest 404s the app's
own JavaScript.

**A `type: 'file'` import evaluates to a path, not to bytes** — an absolute
filesystem path under `bun`, an embedded-VFS path inside a binary, and `Bun.file`
takes both. So `bun src/server/standalone.ts` runs the binary's exact wiring with
no compile step, which is what `__tests__/standalone.test.ts` drives.

Four environment variables configure a deployment (`envOverrides` in
`config.ts`): `MULES_PORT`, `MULES_PUBLIC_BASE_URL`, `MULES_DB_PATH`,
`MULES_STATIC_ROOT`. `MULES_PORT` also moves the default base URL, since
`joinUrl` is built from it — that closed deferred item **D3**. Everything else in
`TransportConfig` is a design constant and stays one.

**The port also has a flag: `--port=5000` or `--port 5000`**, accepted by the
binary and by `bun run serve` alike (`parseFlags`, composed with the environment
by `deploymentOverrides`, both in `config.ts`; `configFromLaunch` in `index.ts`
is the one place that touches `Bun.argv`). It is the only flag, because the port
is the only one of the four whose value someone learns *at the moment of
starting the server* — :3000 turns out to be busy, and there is nowhere to put an
environment variable in that sentence. A flag beats `MULES_PORT`, and moves the
derived invite link with it; an explicitly named `MULES_PUBLIC_BASE_URL` still
outranks both, because a proxy or a domain is a deployment fact that changing the
listen port does not invalidate.

**An unrecognized argument exits 1 rather than being ignored.** Silent
acceptance is the failure the flag was added to fix: `bun run serve
--port=5000` appended the argument, nothing read it, and the server bound :3000
and reported `EADDRINUSE` while appearing to disregard the port asked for.
`--prot=5000` would be the same failure wearing a typo.

`__tests__/launch.test.ts` is the only test here that spawns the entrypoint as a
process. It exists because `import.meta.main` is where that bug lived and no
test that calls `startServer` with its own config can reach it.

### MCP seat server (`src/mcp/`)

A person cannot play this game alone. `src/mcp/` is a **Model Context Protocol
server over stdio** that claims two or three seats at a live match, so one human
can play a four-player game against a model. Design:
`docs/plans/2026-07-28-mcp-seat-design.md`; the build is
`docs/plans/2026-07-28-mcp-seat-implementation-plan.md`.

It is a **client of the transport**, not part of it. It connects over WebSocket
like the browser does, and imports `../server/protocol` and `../game/engine`
rather than restating either — which is what makes wire drift a compile error
instead of the failure this file already documents elsewhere.

**No dependency.** MCP is JSON-RPC over stdio, and `rpc.ts` is the whole
protocol layer. `@modelcontextprotocol/sdk` was considered and rejected on
inspection: 17 transitive packages including `express`, `hono`, `cors`,
`express-rate-limit` and `jose` — an HTTP stack and OAuth, none of which a
stdio server reaches. Taking it later costs one `bun add` and a rewrite of that
one file.

Four things are load-bearing:

- **Isolation is a missing capability, not a rule.** Each seat gets an opaque
  128-bit handle at claim time and every seat-scoped tool demands one, so an
  agent holding p3's handle *cannot* read p2's hand. Without this the game stops
  existing — one mind holding three hands makes every Informant guess a
  certainty. The handle half is enforced in code; the design's other half, *one
  agent context per seat*, is the caller's job and is not enforced here.
- **stdout carries protocol frames and nothing else.** A stray `console.log` in
  `main.ts` desynchronises the client and presents as tools that silently stop
  working. Diagnostics go to stderr.
- **A seat's own frame is the only authority on that seat's turn.** Three
  sockets have no ordering guarantee, so routing from whichever frame arrived
  first hands a seat a turn whose view has no legal plays in it. For the same
  reason `playCard` confirms on a *condition* (the view advanced), never on an
  *event* (a push arrived) — a queued frame satisfies the latter.
- **`main.ts` wraps its stdin loop in `async main()`** because
  `bun build --compile --bytecode` emits CommonJS, which cannot represent
  top-level `await`. Bun reports that as a parse error pointing at the first
  `await`, which reads like a syntax mistake rather than a module-format
  constraint.

Registered through `.mcp.json`, which points at `src/mcp/main.ts` directly. Two
scripts drive a live match by hand: `scripts/hostSeat.ts` owns the game server
and seat p1, leaving the rest to arrive over MCP, and `scripts/mcpPlay.ts`
plays a whole match through a spawned server.

### Server (transport layer)

`src/server/` is a `Bun.serve` WebSocket server that wraps the engine. One process holds rooms (`Map<matchId, Room>`) in memory; each room persists to `bun:sqlite`, storing `{seed, actionLog}` rather than a state snapshot, so recovery replays actions through `reduce()` instead of needing a migration-prone snapshot format. Run it with `bun run serve`. Full design (message protocol, seat identity, reconnection, the validation pipeline) lives in `docs/plans/2026-07-22-transport-design.md`; the code is `index.ts` (Bun.serve entrypoint), `protocol.ts` (message unions + type guards), `room.ts` (Room state machine), `roomRegistry.ts` (room map + reaper sweep), `seatTokens.ts` (minting/hashing/lookup), `dispatch.ts` (the validation pipeline), `persistence.ts` (sqlite store + replay), `rateLimiter.ts` (token buckets), `config.ts` (tunables), and `__tests__/`.

## Code style

### TypeScript gotchas

`tsconfig.json` sets `strict: true` **but** `strictPropertyInitialization: false`. Nothing in the codebase needs the exemption — no class declares a field it fills in later — so treat the flag as off and do not write code that relies on it.

`noUnusedLocals` and `noUnusedParameters` are on, so dead code fails type-checking. But `noEmit: true` and **neither `vite build` nor the dev server type-checks** — Vite transpiles without checking. Run `bunx tsc --noEmit` yourself to catch type errors before considering work done.

### Asset organization (important convention)

Portrait art lives in **character-slug directories** under `public/assets/`, one per card. Four thematic variants `portrait_0.png`..`portrait_3.png` exist per character, but **only the chosen one sits under `public/assets/`** — Vite copies `public/` verbatim, so the other three live in `art/portraits/<slug>/`, tracked but never built. Choosing a different variant means moving the file into `public/assets/<slug>/` *and* editing `src/client/content/portraits.ts`; `portraits.test.ts` fails if only one of the two happens. The variants are:

- `portrait_0` — base, `portrait_1` — alien/evolved, `portrait_2` — ethnic diversity, `portrait_3` — gender-diverse presentation (see `public/assets/PORTRAIT_PROMPTS.md` for the exact ComfyUI prompt behind every image and the per-character color scheme).

The slug does **not** always match the card's display name. Mapping (README card → asset dir → value):

| Card                 | Asset dir        | Value |
| -------------------- | ---------------- | ----- |
| Informant            | `informant/`     | 1     |
| Han Pritcher         | `han-pritcher/`  | 2     |
| Bail Channis         | `bail-channis/`  | 2     |
| Ebling Mis           | `ebling-mis/`    | 3     |
| Magnifico Giganticus | `magnifico/`     | 3     |
| Shielded Mind        | `shielded-mind/` | 4     |
| Bayta Darell         | `bayta-darell/`  | 5     |
| Toran Darell         | `toran-darell/`  | 5     |
| Mayor Indbur         | `mayor-indbur/`  | 6     |
| The First Speaker    | `first-speaker/` | 7     |
| The Mule             | `mule/`          | 8     |

Other asset dirs: `card-back/` (the deck and face-down cards), `shaders/` (`rainbow_gradient.png` for the devotion-token shimmer, `sparkle_pattern.png` for the victory burst), and `misc/` (the playfield background and the devotion token badge). Catalogued in `VISUAL_SHOWCASE.md`.

## Skills

`.agents/skills/` holds nine, in two groups.

**Where a change belongs** — these divide along the seams this file already
describes, not by file type:

| Skill | Reach for it when |
| --- | --- |
| `adding-to-the-pure-layer` | Editing `layout/`, `content/`, `store/` or `tokens/`, or when `purity.test.ts` fails |
| `laying-out-the-table` | Changing table geometry, or adding a field to `LayoutSpec`, `RenderPlan`, `SeatPlan` or `ChipSpec` |
| `writing-a-dom-surface` | Adding or changing anything in `src/client/ui/` |
| `changing-the-wire` | Touching `RedactedView`, protocol messages, engine types or room state |
| `running-the-test-gates` | Before claiming any change is done, or when a failure does not match what you edited |

The split is not filing. A change that spans two of them is usually a change
that should have been one: geometry belongs in `layout/`, the renderer obeys it,
and a surface that computes its own position has taken a decision away from a
layer that can be tested without a browser.

Two exist because of failures this repo has actually had. `changing-the-wire`
covers the version skew that presents as anything but — "cards stopped
responding" and a rule being misreported were one added field, not two bugs.
`running-the-test-gates` exists because `vitest.config.ts` enumerates globs while
the `bun test` scripts name directories, so a new top-level directory under
`src/` is type-checked automatically and **silently untested** until a script
names it.

**How it should look and move** — the visual half, which has no compiler to
answer to and therefore needs its judgement written down:

| Skill | Reach for it when |
| --- | --- |
| `designing-an-effect` | Deciding whether an effect belongs at all, or when the table starts to feel noisy |
| `easing-and-choreography` | Motion feels cheap, linear, floaty or simultaneous |
| `svg-filters-and-gradients` | Building glow, bloom, warp, shimmer or grain — or tempted to add a graphics library to get them |

That last one is the standing answer to a recurring question. This client has no
runtime dependencies, and the visual budget it spends is spent through the
platform: CSS, SVG filters and the Web Animations API.

## Agent configuration files

This repo follows the cross-tool [AGENTS.md](https://agents.md) convention: **this file is the single source of truth.**

- `CLAUDE.md` contains one line — `@AGENTS.md` — which Claude Code expands into this file's contents during preprocessing, before the model sees it. See [Write an effective CLAUDE.md](https://code.claude.com/docs/en/best-practices#write-an-effective-claude-md).
- `.claude/` is a symlink to `.agents/`, which holds shared skills (`.agents/skills/`).

The symlink is load-bearing and deliberate. Claude Code discovers skills only under a `.claude/skills/` path: `--add-dir` looks for `.claude/skills/` *inside* the added directory, `permissions.additionalDirectories` in `settings.json` grants file access but explicitly does not load skills, and skills-directory plugins are themselves found only under `.claude/skills/`. There is no supported way to point Claude Code at a bare `.agents/skills/`, so removing the symlink silently hides every skill. (Windows checkouts need `core.symlinks=true`.)

When updating project guidance, edit `AGENTS.md` — never fork the content into a tool-specific copy.
