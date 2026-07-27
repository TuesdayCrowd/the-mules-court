# AGENTS.md

Guidance for coding agents working in this repository. Human contributors are welcome to read it too — everything here is equally true for people.

## Project overview

**The Mule's Court** is a _Love Letter_-style deduction/elimination card game reskinned into Isaac Asimov's Foundation universe (2–4 players, first to N Devotion Tokens wins). The complete game design — rules, turn structure, and all 11 card types with values/counts/abilities — lives in `README.md`. Treat that file as the gameplay spec.

**Status:** three of the four layers are **built and tested**. The headless game engine (`src/game/engine/`, Vitest), the WebSocket transport that wraps it (`src/server/`, `bun test`), and now the client's browser-independent half (`src/client/`, Vitest) — its pure layer of geometry, copy, state and palette, plus the whole DOM chrome, all testable under Node and jsdom with no WebGL context and no socket.

The Phaser layer now exists too: `src/game/scenes/Court.ts` draws the table, `src/game/scenes/beats.ts` runs the cinematic beats, and `src/main.ts` is the composition root that wires store, socket, DOM and canvas together. **A match is playable in a browser.** Every stage of `docs/plans/2026-07-24-uix-implementation-plan.md` is complete bar the real-device QA pass (Task 34), which needs hardware and a person — see `docs/plans/2026-07-24-uix-qa-checklist.md`.

This started life as the Phaser "template-bun" starter (some scene code and `logo.png`/`bg.png` are still theirs), but `package.json` metadata has been reclaimed for the game (`name: the-mules-court`).

## Setup commands

Requires [Bun](https://bun.sh).

| Command                                     | Description                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `bun install`                               | Install dependencies                                                      |
| `bun run dev`                               | Client dev server at `http://localhost:8080` — **needs `dev:server` too** |
| `bun run dev:server`                        | The API and WebSocket half, on `:3000`. Run it in a second terminal        |
| `bun run dev:host`                          | Like `dev`, but reachable from other devices on the network               |
| `bun run build`                             | Production build to `dist/`                                               |
| `bun run dev-nolog` / `bun run build-nolog` | Same, but skip the `log.js` telemetry ping                                |
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
in the only handler that opens the action sheet, silent because a throw in a
Phaser pointer handler goes nowhere a player can see) and then as a *rule* being
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

### About `log.js`

The `dev`/`build` scripts first run `bun log.js <mode>`, which makes one silent, anonymous ping to Phaser Studio's `gryzor.co` (template name / dev-vs-prod / Phaser version — no personal or project data). Use the `-nolog` variants to skip it, or delete `log.js` and its calls in `package.json`.

## Testing instructions

Two test runners, split by what each layer needs. Engine **and client** tests run under **Vitest** (`bun run test:engine` — the name predates the client; `vitest.config.ts` collects `src/game/**/*.test.ts` and `src/client/**/*.test.ts`). Server/transport tests run under **Bun's own test runner** (`bun run test:server`, i.e. `bun test src/server`). The split isn't stylistic: Vitest's workers run under Node, which can load neither `bun:sqlite` nor the Bun globals the transport depends on, so `src/server/` has to run on `bun test` instead. `bun run test` runs both in sequence. There is still **no linter** configured.

Client tests default to the **Node** environment; a file needing a DOM opts in with a `// @vitest-environment jsdom` docblock on its first line. Vitest 4 removed `environmentMatchGlobs`, and the docblock keeps that choice beside the code that needs it.

Three gates worth knowing about, because they fail for reasons that are not obvious:

- **`src/client/__tests__/purity.test.ts`** — `layout/`, `content/`, `store/` and `tokens/` may not import Phaser, reach a DOM global, or import server *runtime* (one documented exception: `content/nickname.ts` takes the nickname limit from `src/server/config.ts`, which has zero imports). It reads raw file text, so a *comment* naming a banned global fails too.
- **`src/client/__tests__/axe.test.ts`** — axe-core over every DOM surface. `color-contrast` is the only disabled rule, because jsdom has no layout; contrast is covered arithmetically in `src/client/tokens/contrast.test.ts` instead.
- **`src/client/layout/discardCapacity.test.ts`** — drives thousands of real matches through the engine to prove the layout reserves room for the deepest discard pile that can actually occur (eight, not the seven the design states).

The verification gate before considering any change done is:

```bash
bun run test        # engine tests (Vitest) + server tests (bun test)
bunx tsc --noEmit    # neither vite build nor the dev server type-checks; this is the only type check
bun run build        # confirm the production bundle still builds
```

## Architecture

### Tech stack

Phaser **4.2.1** · Vite 6 · TypeScript 5.7 · Bun. The client ships as a static bundle; a small Bun backend (`src/server/`) now exists to host multiplayer matches over WebSocket — see [Server (transport layer)](#server-transport-layer) below.

### Bootstrap & scene flow

`index.html` loads `src/main.ts` → calls `StartGame('game-container')` in `src/game/main.ts`, which builds the `Phaser.Types.Core.GameConfig` (AUTO renderer, `Scale.RESIZE` at `100%` × `100%` so the canvas fills the viewport 1:1 with no design resolution, mounts into `#game-container`) and registers scenes **in order**:

```
Boot → Preloader → Court
```

- `Boot` loads the one asset the preloader itself needs (the playfield background), then starts `Preloader`.
- `Preloader` shows the progress bar and loads the real assets — every portrait derived from `CARD_CATALOG`, the card faces, the devotion token, the three shader maps — then **awaits `document.fonts.ready`** before starting `Court`. Canvas text is painted pixels: created before the face loads it renders in a fallback and never re-renders itself the way DOM text does.
- `Court` is the only gameplay scene. Between matches it idles as the ambient nebula behind the DOM screens; during one it draws the table from a `LayoutSpec`.

**Loader paths are absolute (`/assets`), and that is load-bearing.** A relative path resolves against `/join/:matchId`, which the SPA fallback answers with `index.html` and a **200** — so the loader never sees a 404, decodes HTML as an image, and silently substitutes a missing texture. Same reason Vite's `base` is `/`.

**`input.windowEvents` is off** (`src/game/inputPolicy.ts`), also load-bearing. With Phaser's default, `MouseManager` binds `mousedown` to `window.top` and processes it precisely when `event.target !== canvas` — so a tap on the DOM layer hit-tests the table beneath it, and every tap on the action sheet also selected the card under it.

`MainMenu`, `Game`, and `GameOver` were **deleted**, not replaced — a deliberate deviation from this file's former "keep the Scene chain as the skeleton" guidance, recorded in *UIX §2.5* rather than decided ad hoc. Menu and game-over are DOM surfaces now (`src/client/ui/menuScreen.ts`, `overlays.ts`), and an empty Phaser scene behind each would be dead weight.

When adding gameplay, put the *decision* in a pure module and let `Court` walk the result. `buildRenderPlan` and `computeLayout` are both tested without a WebGL context; the scene is glue thin enough to review by reading, and that is the property to preserve.

### Build config

Two Vite configs in `vite/`, selected per script:

- `config.dev.mjs` — dev server on port 8080.
- `config.prod.mjs` — Terser minification (2 passes, comments stripped) + a `phasermsg` plugin that prints a build banner.

Both use `base: '/'` (absolute asset paths) and split Phaser into its own `phaser` chunk via `manualChunks`. The base is **not** relative, and deliberately so: the client owns the `/join/:matchId` route (*UIX §2.6*), and a relative base resolves `./assets/index-abc.js` against `/join/` on a real invite link, so the app never boots. The dev config also proxies `/api` and `/ws` to the server on :3000, which is what lets `socketUrl()` derive one same-origin URL for dev and production alike.

### Client (`src/client/`)

Everything the client can decide without a browser, so Vitest can hold it to the
design without booting a WebGL context. Full design: `docs/plans/2026-07-23-uix-design.md`.

**The pure layer** — no Phaser, no DOM, no ambient globals, enforced by
`__tests__/purity.test.ts`:

- `tokens/` — the palette as numbers for canvas draw calls, mirroring `styles/tokens.css`, with a drift test and a WCAG contrast check.
- `content/` — every string a player reads: card copy, quick reference, log narration, failure copy, nickname rules, the countdown.
- `layout/` — table geometry as data. `computeLayout(input) → LayoutSpec` across three topology classes; the `Court` scene will consume a spec rather than compute one.
- `store/` — the WebSocket, the seat token, route parsing, room creation, and one immutable `ClientState` that never derives a game rule.

**The DOM layer** — `ui/`, one factory per surface with `mount`/`update`/`destroy`.
Menu, join, lobby, action sheet, quick reference, seat dossier, overlays, fatal
screen, toasts, connection dot, and the offscreen accessibility twin. No surface
reads the store; `update(state)` is pushed by a single subscriber.

**Styles** — `styles/fonts.css` (self-hosted Exo 2 and Inter), `tokens.css`
(authoritative palette), `ui.css` (the two-layer shell plus component styling).
The pointer-events discipline lives in `ui.css` and is tested against the real
file, not a stub.

### Server (transport layer)

`src/server/` is a `Bun.serve` WebSocket server that wraps the engine. One process holds rooms (`Map<matchId, Room>`) in memory; each room persists to `bun:sqlite`, storing `{seed, actionLog}` rather than a state snapshot, so recovery replays actions through `reduce()` instead of needing a migration-prone snapshot format. Run it with `bun run serve`. Full design (message protocol, seat identity, reconnection, the validation pipeline) lives in `docs/plans/2026-07-22-transport-design.md`; the code is `index.ts` (Bun.serve entrypoint), `protocol.ts` (message unions + type guards), `room.ts` (Room state machine), `roomRegistry.ts` (room map + reaper sweep), `seatTokens.ts` (minting/hashing/lookup), `dispatch.ts` (the validation pipeline), `persistence.ts` (sqlite store + replay), `rateLimiter.ts` (token buckets), `config.ts` (tunables), and `__tests__/`.

## Code style

### TypeScript gotchas

`tsconfig.json` sets `strict: true` **but** `strictPropertyInitialization: false`. This is deliberate for Phaser: scenes declare game objects as class fields without initializers (e.g. `camera: Phaser.Cameras.Scene2D.Camera;`) and assign them in `create()`. Follow that pattern rather than fighting it with `!` or constructors.

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

Other asset dirs: `card-back/`, `card-front/`, `shaders/` (distortion/sparkle/rainbow maps for effects), `misc/` (playfield background, devotion token badge, UI panel textures — catalogued in `VISUAL_SHOWCASE.md`).

## Phaser 4 skills — use them

`.agents/skills/` holds 28 reference skills covering the Phaser 4.2.1 API, surfaced to Claude Code through the `.claude` symlink and invoked as `/scenes`, `/tweens`, and so on. Each skill's own description lists what triggers it, and agent tools load that list automatically — so the rules below are about **when to invoke**, not what each skill contains.

**Invoke the matching skill _before_ writing Phaser code, not after the code misbehaves.** These skills are the API reference for this project; guessing at the API and correcting later wastes a cycle and tends to produce Phaser 3 idioms.

**The version trap — this is the one that bites.** This project is Phaser **4**. Nearly every Phaser example in the wild, and most recalled API knowledge, is Phaser **3**, and the two differ substantially: pipelines became render nodes, FX and masks became filters, tint and camera-matrix behavior changed, and some game objects were removed outright. If you are about to write Phaser code from memory, or you are adapting a snippet found online, consult `/v3-to-v4-migration` first. `/v4-new-features` covers what v4 added (Filters, RenderNodes, SpriteGPULayer, Gradient, Noise).

Rough routing for this game, since a card game exercises an unusual slice of the engine:

| Working on                                              | Start with                                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------------- |
| Scene chain, transitions, per-round state               | `/scenes`, `/game-setup-and-config`                                         |
| Cards on screen — dealing, flipping, hovering, layout   | `/sprites-and-images`, `/tweens`, `/groups-and-containers`                  |
| Clicking cards, targeting opponents, drag               | `/input-keyboard-mouse-touch`                                               |
| Card text, player names, Devotion Token counts          | `/text-and-bitmaptext`                                                      |
| Loading the portrait/card art in `Preloader`            | `/loading-assets`                                                           |
| Effects from `public/assets/shaders/`                   | `/filters-and-postfx`, `/particles`                                         |
| Game state, turn order, event plumbing between scenes   | `/data-manager`, `/events-system`                                           |
| Turn timers, deal/reveal delays                         | `/time-and-timers`                                                          |
| Fitting 1024×768 to real browser windows                | `/scale-and-responsive`, `/cameras`                                         |

`/physics-arcade`, `/physics-matter`, and `/tilemaps` are almost certainly irrelevant here — this game has no physics simulation and no tile grid. Reach for them only if the design changes.

## Agent configuration files

This repo follows the cross-tool [AGENTS.md](https://agents.md) convention: **this file is the single source of truth.**

- `CLAUDE.md` contains one line — `@AGENTS.md` — which Claude Code expands into this file's contents during preprocessing, before the model sees it. See [Write an effective CLAUDE.md](https://code.claude.com/docs/en/best-practices#write-an-effective-claude-md).
- `.claude/` is a symlink to `.agents/`, which holds shared skills (`.agents/skills/`).

The symlink is load-bearing and deliberate. Claude Code discovers skills only under a `.claude/skills/` path: `--add-dir` looks for `.claude/skills/` *inside* the added directory, `permissions.additionalDirectories` in `settings.json` grants file access but explicitly does not load skills, and skills-directory plugins are themselves found only under `.claude/skills/`. There is no supported way to point Claude Code at a bare `.agents/skills/`, so removing the symlink silently hides all 28 skills. (Windows checkouts need `core.symlinks=true`.)

When updating project guidance, edit `AGENTS.md` — never fork the content into a tool-specific copy.
