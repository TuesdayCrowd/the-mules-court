# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-07-27

The game can now be compiled to a single file. `bun run compile` bundles the Bun
runtime, the server and every client asset into one executable that runs from any
directory with nothing installed and no `dist/` beside it. No binaries are
published — you build it from a checkout, and the `compile:*` scripts are run by
hand.

The rest of the release is legibility. Four canvas labels — the turn banner, the
deck count, the value badge, the revealed-card label — had been rendering at
10px sans-serif since the table was first drawn, for a reason nothing on screen
could suggest.

### Added

#### Distribution

- `bun run compile` produces `./mules-court`, a ~71 MB single-file executable
  holding Bun's runtime, the transport server, and the whole client. Five
  cross-compile scripts cover Linux x64/arm64, macOS arm64/x64, and Windows
  x64, landing in `dist-bin/`.
- `src/server/standalone.ts`, a second entrypoint that serves the client from
  a compiled-in manifest rather than a directory. It prints the resolved
  database path at startup — a binary launched from a downloads folder writes
  its sqlite file there — and closes the store on `SIGINT`/`SIGTERM` rather
  than leaving a write-ahead log behind.
- An embedded-asset manifest generated from `dist/` by
  `scripts/generateEmbeddedAssets.ts`. Bun resolves `with { type: 'file' }`
  imports at bundle time, so the file list cannot be a runtime glob — it has
  to be source. The decisions live in the tested pure module
  `embeddedManifest.ts`; the script adds only the directory read and the
  write. The output is committed, because `standalone.ts` imports it and a
  clone without it fails `bunx tsc --noEmit`.

#### Configuration

- Three more environment variables, joining `MULES_STATIC_ROOT`: `MULES_PORT`,
  `MULES_PUBLIC_BASE_URL`, and `MULES_DB_PATH`. Everything else in
  `TransportConfig` is a design constant and stays one — the reveal window is
  five seconds on every machine because the design says so.
- `MULES_PORT` also moves the default public base URL, which closes deferred
  item **D3**. `joinUrl` is built from that prefix, so a host who changed the
  port and said nothing about the URL would otherwise have handed every guest
  a link to a port nothing was serving. An explicit `MULES_PUBLIC_BASE_URL`
  still wins.
- An unusable `MULES_PORT` refuses to start rather than falling back to 3000.
  A server silently listening somewhere other than where it was told is worse
  than one that does not come up.

#### Testing

- `bun run test:visual` — a Playwright harness that drives a host and a guest
  through isolated browser contexts at eight viewports and writes a screenshot
  each. The isolation is the point: seat tokens live in `localStorage` keyed by
  `matchId`, so two tabs sharing a profile resume the same seat and a second
  player can never sit down. It fails the run on what a machine can judge — a
  page error, a missing canvas, a silent WebGL failure, an empty accessibility
  twin — and writes PNGs for what only eyes can. It exists because two layout
  bugs shipped through a gap the layout suite cannot see: anything drawn past a
  rect is not a rect, so no assertion over a `LayoutSpec` can catch it.
- Uses an already-installed Edge or Chrome by default, so a checkout needs no
  browser download; `MULES_VISUAL_CHANNEL=chromium` selects a pinned one.

### Changed

- Static hosting is now one policy over two swappable byte sources
  (`src/server/staticAssets.ts`). `serveFrom` owns the rules — decode, refuse
  traversal, exact hit, shell fallback for an extensionless path, 404
  otherwise — and only resolution varies between a filesystem directory and
  the compiled-in map. Forking it would have left the SPA-fallback and 404
  rules in two files, and the drift would have shown up as a dead invite link
  from a downloaded binary with nothing in this repo's test run to catch it.
- `bun run build` and `build-nolog` regenerate the embedded manifest. It names
  content-hashed chunks, so any client rebuild invalidates it; previously only
  `compile` regenerated, and a bare `build` left the committed manifest naming
  files that no longer existed.
- **The hand is always centred.** UIX §6.1 spread it to both margins on
  landscape-narrow viewports, reasoning that a phone held in landscape has a
  thumb at each edge. The reasoning is sound and the result was not — a player
  reads their hand as a pair, and a pair split across the width of the screen
  is not a pair. Removed outright rather than narrowed a third time, and
  recorded in the design document as superseding §6.1.
- Discard pips scale with viewport height instead of a flat 14px cap, so a pile
  legible on a 390px phone is no longer the same size on a 1080p monitor.
- Seat nicknames and the own-status row size from their rects rather than fixed
  pixels, so they grow with the panel they sit in.
- The README documents self-hosting from a binary, the macOS quarantine flag,
  and all four environment variables.

### Fixed

- **Every display-face label rendered at 10px sans-serif.** Phaser builds a CSS
  font shorthand from `fontSize` and `fontFamily` and assigns it to
  `ctx.font`; a family name containing a space is only valid there when
  quoted, and the canvas spec says an invalid assignment is silently ignored —
  the context keeps the default `10px sans-serif`. So `'Exo 2, sans-serif'`
  rendered neither Exo 2 nor the fallback at the requested size, and Exo 2 had
  never once appeared on the canvas. The stacks now live in
  `src/client/tokens/fonts.ts` with a test holding them to being parseable.
- **Topology was classified by aspect ratio, so a 4:3 desktop window drew a
  rotated phone's table** — hand cards flush against opposite margins, a
  cramped centre, a small deck, and the burn panel stacked below it. Height
  separates the two devices, so height now decides the landscape split
  outright; aspect still picks portrait, where it genuinely describes the
  composition.
- The burn panel's caption drew past the card it captioned and beneath the
  value badge, rendering "Removed from play" as "…ved from play" at roughly
  twice the card's width. It takes the band beside the badge, reads "Removed",
  and is dropped entirely below a legible floor rather than smeared. The
  accessibility twin still announces the full "Removed from play: ⟨name⟩,
  value ⟨n⟩".
- The turn banner, seat nicknames and discard values sat on bare nebula. Each
  gets a scrim sized to its own content, not to its band — a two-player table
  gives one opponent the full width of the screen, and a full-width scrim
  there is a black bar rather than an aid.
- `drawSeat` reinvented pip packing with its own hardcoded step, discarding the
  size `fitPips` had proved would fit. It takes the fitted geometry now.
- A static root whose directory name contained a dot 404'd the homepage: the
  extension test read the resolved path, so a request for `/` took the root
  directory's own name as the filename.

### Security

- **`/../../etc/passwd` answered 200 with the app shell.** Splitting static
  hosting exposed it: a lookup can only report "no file", and "no file" is
  what triggers the SPA fallback, so a traversal path with no extension read
  as a client route. Refusing a `..` segment in the shared policy fixes it for
  both byte sources and closes the same hole on the embedded side, which never
  had a guard at all. The resolve-and-prefix check stays as defence in depth,
  and `__tests__/static.test.ts` — which caught this — passes unedited.

### Docs

- `docs/plans/2026-07-27-standalone-binary-plan.md`, written before
  implementation and then corrected against the code that actually shipped:
  the traversal regression, a `Partial<TransportConfig>` block that did not
  compile, and four tasks whose planned shapes differed from the built ones.

## [1.0.0] - 2026-07-27

First tagged release. The Mule's Court is a *Love Letter*-style deduction and
elimination card game, reskinned into Isaac Asimov's Foundation universe, for
2-4 players over a real network connection. A match is playable end to end in
a browser: host a room, share a link, play a hand, win Devotion Tokens.

### Added

#### Game engine

- A deterministic, headless rules engine (`src/game/engine/`) covering the
  full 16-card deck: Informant, Han Pritcher, Bail Channis, Ebling Mis,
  Magnifico Giganticus, Shielded Mind, Bayta Darell, Toran Darell, Mayor
  Indbur, The First Speaker, and The Mule, with every card's value, count,
  and ability from the rules.
- Match and round setup, including the removal-card table for 2, 3, and
  4-player games.
- Legality rules for forced play (holding Mayor Indbur or a Darell forces The
  First Speaker's discard) and targeting (no targeting eliminated or
  protected players).
- Resolvers for all eight distinct card effects: guess-and-eliminate,
  look-at-hand, compare-and-eliminate, protection, forced discard-and-draw,
  hand swap, forced self-discard, and elimination-on-discard.
- A seeded RNG with a determinism guard, so a given seed always replays to
  the same match.
- Sudden death and the round-end tiebreak (highest card value, then discard
  pile total) when the deck runs out.
- A redacted view builder: each player's client sees only what that seat is
  allowed to see, never the full engine state.
- Guessing is by value, not by character name, since several values (2, 3,
  5) are shared by two characters; the Informant is blocked from guessing
  its own value of 1.

#### Multiplayer server

- A `Bun.serve` WebSocket server (`src/server/`) that wraps the engine, with
  a documented message protocol, an ordered validation/dispatch pipeline,
  and rate limiting on incoming actions.
- Room lifecycle: lobby, seat table, eviction, start, pause and resume,
  round advancement with a reveal timer, and end of match.
- Seat tokens for reconnection: a disconnected player can resume the same
  seat rather than losing it to another connection.
- Crash recovery without state snapshots — each room persists only
  `{seed, actionLog}` to `bun:sqlite` and rebuilds its state lazily by
  replaying actions through the engine's own reducer.
- A room registry with a reaper sweep for abandoned rooms.
- `POST /api/rooms` to create a room over HTTP, and static hosting of the
  built client with an SPA fallback for direct links to `/join/:matchId`.
- An abuse-suite of tests exercising closed exploits as live attacks against
  the running protocol.

#### Client & UI

- A full Phaser 4 game scene (`Court`) that draws the table from a pure,
  pre-computed `LayoutSpec`. Layout is responsive across three viewport
  topologies — portrait, landscape-narrow, and wide — which are the only
  discrete jumps; within a class every position scales as a fraction of the
  live viewport, and seating adapts to 2, 3, or 4 players.
- Cinematic beats for dealing, playing, and resolving cards, and a single
  reconciler that turns each server state diff into a queued, motion-aware
  presentation.
- A DOM screen layer above the canvas for menu, join, lobby, action sheet,
  quick reference, seat dossier, overlays, toasts, connection status, and a
  fatal-error screen — each a self-contained factory with `mount` / `update`
  / `destroy`.
- Card copy, a quick-reference panel, and narrated action log text for every
  card and outcome in the game.
- Designed, non-generic failure copy for every protocol error code.
- Room creation and joining from the menu, nickname validation, a shareable
  invite link built from `location.origin` (so it works on whatever address
  the device is actually using), and a lobby Copy button.
- A server-owned countdown and end-of-round/end-of-match overlays.
- Self-hosted fonts (Exo 2, Inter), a full icon set, and portrait art for
  every character card, each with four thematic variants.
- Reconnection with backoff on the client, paired with the server's seat
  tokens, so a dropped connection or a server restart mid-match recovers
  without losing the seat.

#### Accessibility

- An offscreen accessibility twin that mirrors on-screen game state as real
  DOM text for screen readers, since the table itself is a canvas.
- Every card removal, peek, and reveal is announced in text, naming the
  specific card involved rather than a generic "something happened".
- A WCAG contrast check run against the design token palette as a test, not
  just a visual check.
- An axe-core accessibility audit run against every DOM surface in the UI.

#### Developer experience

- `AGENTS.md` as the single source of truth for coding-agent and human
  contributor guidance, following the cross-tool AGENTS.md convention:
  `CLAUDE.md` is one line that expands to it, and `.claude/` is a symlink to
  `.agents/` so shared skills load without forking the guidance.
- Two test runners split by what each layer needs: Vitest for the engine and
  the client's pure/DOM code, Bun's own test runner for the server (which
  depends on `bun:sqlite` and Bun-only globals that Vitest's Node workers
  cannot load).
- A purity test that fails the build if `layout/`, `content/`, `store/`, or
  `tokens/` import Phaser, touch a DOM global, or import server runtime code.
- A discard-capacity test that drives thousands of real matches through the
  engine to confirm the layout reserves room for the deepest discard pile
  that can actually occur.
- `bun run dev:server` running under `bun --watch`, so the client (hot
  reloaded by Vite) and the server can never drift onto different versions
  of the shared engine code during development.
- `bun run dev:host` for testing a real match from a phone or second device
  on the same network, with guarded fallbacks for `crypto.randomUUID` and
  `navigator.clipboard` in the non-secure context that implies.
- Design and implementation plan documents in `docs/plans/` for the engine,
  the transport layer, and the client UI, kept as the historical record of
  each stage's decisions.

[1.1.0]: https://github.com/TuesdayCrowd/the-mules-court/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/TuesdayCrowd/the-mules-court/releases/tag/v1.0.0
