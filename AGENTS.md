# AGENTS.md

Guidance for coding agents working in this repository. Human contributors are welcome to read it too — everything here is equally true for people.

## Project overview

**The Mule's Court** is a _Love Letter_-style deduction/elimination card game reskinned into Isaac Asimov's Foundation universe (2–4 players, first to N Devotion Tokens wins). The complete game design — rules, turn structure, and all 11 card types with values/counts/abilities — lives in `README.md`. Treat that file as the gameplay spec.

**Status:** three of the four layers are **built and tested**. The headless game engine (`src/game/engine/`, Vitest), the WebSocket transport that wraps it (`src/server/`, `bun test`), and now the client's browser-independent half (`src/client/`, Vitest) — its pure layer of geometry, copy, state and palette, plus the whole DOM chrome, all testable under Node and jsdom with no WebGL context and no socket.

**What remains unbuilt is the Phaser layer that draws the table.** Everything under `src/game/scenes/` is still the unmodified "template-bun" starter (the `Game` scene renders "Make something fun!"), and `src/main.ts` still boots it rather than the client — so **nothing in `src/client/` runs in a browser yet.** That wiring is Stage 6 of `docs/plans/2026-07-24-uix-implementation-plan.md`; Stages 1–5 and 7 are complete.

The rich art assets in `public/assets/` and the design docs are the raw material for that last layer. This started life as the Phaser "template-bun" starter (some scene code and `logo.png`/`bg.png` are still theirs), but `package.json` metadata has been reclaimed for the game (`name: the-mules-court`).

## Setup commands

Requires [Bun](https://bun.sh).

| Command                                     | Description                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `bun install`                               | Install dependencies                                                      |
| `bun run dev`                               | Client dev server at `http://localhost:8080` — **needs `dev:server` too** |
| `bun run dev:server`                        | The API and WebSocket half, on `:3000`. Run it in a second terminal        |
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

`index.html` loads `src/main.ts` → calls `StartGame('game-container')` in `src/game/main.ts`, which builds the `Phaser.Types.Core.GameConfig` (AUTO renderer, 1024×768, mounts into `#game-container`) and registers scenes **in order**:

```
Boot → Preloader → MainMenu → Game → GameOver
```

- `Boot` loads the minimal assets the preloader itself needs (the background), then starts `Preloader`.
- `Preloader` shows the progress bar, loads game assets via `this.load.setPath('assets')` (relative to `public/assets/`), then starts `MainMenu`.
- `MainMenu` / `Game` / `GameOver` advance on `pointerdown` — pure placeholders to be replaced with real menu, gameplay, and results scenes.

**This chain is accurate today and is scheduled to change.** *UIX §2.5* replaces it with `Boot → Preloader → Court`: `MainMenu` and `GameOver` become DOM surfaces (they already exist, in `src/client/ui/`), and an empty Phaser scene behind each would be dead weight. `Court` is the only gameplay scene — between matches it idles as the ambient nebula behind the DOM screens.

That is a **deliberate deviation** from this file's previous "keep the Scene chain as the skeleton" guidance, and it is recorded in *UIX §2.5* rather than decided ad hoc. Stage 6 of the implementation plan makes the change; **this section should be rewritten then, not before** — describing scenes that do not exist would be worse than describing the starter ones that do.

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

Portrait art lives in **character-slug directories** under `public/assets/`, one per card, each with four thematic variants `portrait_0.png`..`portrait_3.png`:

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
