# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

**The Mule's Court** is a _Love Letter_-style deduction/elimination card game reskinned into Isaac Asimov's Foundation universe (2–4 players, first to N Devotion Tokens wins). The complete game design — rules, turn structure, and all 11 card types with values/counts/abilities — lives in `README.md`. Treat that file as the gameplay spec.

**Critical:** the game is **designed but not yet implemented.** Everything under `src/game/scenes/` is still the unmodified Phaser "template-bun" starter (the `Game` scene just renders "Make something fun!"). There is no card data, no game-state model, and no gameplay UI yet. The rich art assets in `public/assets/` and the design docs are the raw material; the actual game must be built from the README spec. This started life as the Phaser "template-bun" starter (some scene code and `logo.png`/`bg.png` are still theirs), but `package.json` metadata has been reclaimed for the game (`name: the-mules-court`).

## Commands

Requires [Bun](https://bun.sh).

| Command                                     | Description                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `bun install`                               | Install dependencies                                                      |
| `bun run dev`                               | Dev server with hot reload at `http://localhost:8080`                     |
| `bun run build`                             | Production build to `dist/`                                               |
| `bun run dev-nolog` / `bun run build-nolog` | Same, but skip the `log.js` telemetry ping                                |
| `bunx tsc --noEmit`                         | Type-check (see gotcha below — this is the only way to catch type errors) |

There is **no test framework and no linter** configured yet. If you add tests, wire the runner into `package.json` scripts.

### About `log.js`

The `dev`/`build` scripts first run `bun log.js <mode>`, which makes one silent, anonymous ping to Phaser Studio's `gryzor.co` (template name / dev-vs-prod / Phaser version — no personal or project data). Use the `-nolog` variants to skip it, or delete `log.js` and its calls in `package.json`.

## Architecture

### Tech stack

Phaser **4.2.1** · Vite 6 · TypeScript 5.7 · Bun. No backend; ships as a static bundle.

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

## Version control

This repo uses **GitButler**, not raw git, for all commits/branches/PRs. The workflow (never `git commit`/`checkout`/`rebase`/`merge`; use the `gitbutler` skill and `but` CLI; never push `gitbutler/workspace` directly) is covered in the global `~/.claude/CLAUDE.md` — follow it.

**Default to branches and pull requests.** Record work on a virtual branch, push it, and open a PR (`but pr new`, or `gh` when GitButler's forge auth isn't configured). Never commit straight to `main`. Do **not** use `but land` — which pushes directly onto `origin/main`, skipping PR review and CI — **unless the user explicitly asks you to land.** When in doubt, open a PR.
