# AGENTS.md

Guidance for coding agents working in this repository. Human contributors are welcome to read it too — everything here is equally true for people.

## Project overview

**The Mule's Court** is a _Love Letter_-style deduction/elimination card game reskinned into Isaac Asimov's Foundation universe (2–4 players, first to N Devotion Tokens wins). The complete game design — rules, turn structure, and all 11 card types with values/counts/abilities — lives in `README.md`. Treat that file as the gameplay spec.

**Status:** the headless game engine is **built and tested** (`src/game/engine/`, under Vitest), and the WebSocket transport that wraps it is **built and tested** (`src/server/`, under `bun test`). What remains unbuilt is the Phaser **client** that speaks to that transport: everything under `src/game/scenes/` is still the unmodified Phaser "template-bun" starter (the `Game` scene just renders "Make something fun!"). The rich art assets in `public/assets/` and the design docs are the raw material for that client; it must be built from the README spec. This started life as the Phaser "template-bun" starter (some scene code and `logo.png`/`bg.png` are still theirs), but `package.json` metadata has been reclaimed for the game (`name: the-mules-court`).

## Setup commands

Requires [Bun](https://bun.sh).

| Command                                     | Description                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `bun install`                               | Install dependencies                                                      |
| `bun run dev`                               | Dev server with hot reload at `http://localhost:8080`                     |
| `bun run build`                             | Production build to `dist/`                                               |
| `bun run dev-nolog` / `bun run build-nolog` | Same, but skip the `log.js` telemetry ping                                |
| `bunx tsc --noEmit`                         | Type-check (see gotcha below — this is the only way to catch type errors) |

### About `log.js`

The `dev`/`build` scripts first run `bun log.js <mode>`, which makes one silent, anonymous ping to Phaser Studio's `gryzor.co` (template name / dev-vs-prod / Phaser version — no personal or project data). Use the `-nolog` variants to skip it, or delete `log.js` and its calls in `package.json`.

## Testing instructions

Two test runners, split by what each layer needs. Engine tests run under **Vitest** (`bun run test:engine`, config in `vitest.config.ts`, scoped to `src/game/**/*.test.ts`). Server/transport tests run under **Bun's own test runner** (`bun run test:server`, i.e. `bun test src/server`). The split isn't stylistic: Vitest's workers run under Node, which can load neither `bun:sqlite` nor the Bun globals the transport depends on, so `src/server/` has to run on `bun test` instead. `bun run test` runs both in sequence. There is still **no linter** configured.

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

When implementing gameplay, keep this Scene chain as the skeleton and add the game logic inside (and alongside) the `Game` scene.

### Build config

Two Vite configs in `vite/`, selected per script:

- `config.dev.mjs` — dev server on port 8080.
- `config.prod.mjs` — Terser minification (2 passes, comments stripped) + a `phasermsg` plugin that prints a build banner.

Both use `base: './'` (relative asset paths, so the `dist/` bundle can be hosted from any subpath) and split Phaser into its own `phaser` chunk via `manualChunks`.

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
