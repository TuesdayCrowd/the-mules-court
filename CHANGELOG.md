# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-08-01

**You can play alone now.** Any seat left open in the lobby can be filled with a
computer opponent, at one of three strengths, so a game that needed three other
people needs none. The opponents cannot cheat, and not because they were told
not to: a policy is handed the same redacted view a browser receives, and has
nowhere to read a deck from.

**And the game no longer runs on a game engine.** Phaser is gone from the
source, the dependency list and the bundle; the table is ordinary DOM and the
cinematic beats run on the Web Animations API. `package.json` now declares *no
runtime dependencies at all*. What a player downloads fell from 1,470,204 bytes
of JavaScript and CSS to 30,484 gzipped — 97% less.

The rest is a playtest release. Five visual bugs reported from real matches in a
single day were each the renderer and the layout disagreeing about a box, so all
39 elements were audited against the spec that governs them and fifteen fixes
landed.

### Added

#### Computer opponents

- Three opponents a host can seat from the lobby — **Converted**, **Officer**,
  and **Mentalic** — chosen per seat, so one court can hold a hard opponent and
  two soft ones. `src/game/ai/`.
- All three run the same scorer on the same trained weights. What changes is how
  much of the table a seat may remember, and whether it gets to search the
  futures its uncertainty allows. The rule is easy to get backwards and is
  recorded as such: an easy opponent should reason well about less, not badly
  about everything. One that throws away a winning line reads as broken; one
  that forgets a discard from four turns ago reads as a person.
- Cheating is a missing capability rather than a rule. `Policy.decide` takes the
  same `RedactedView` a browser gets, so the deck, the set-aside card, the seed
  and other hands have nowhere to reach it from — and `PolicyDecision` carries
  no `playerId`, so a policy cannot move for a seat it does not hold.
- Weights trained offline by the cross-entropy method (`bun scripts/trainAi.ts`)
  and committed as `weights.generated.ts`, for the same reason the embedded
  asset manifest is: `heuristic.ts` imports it, so a clone without it fails
  `bunx tsc --noEmit`. `selfPlay.ts` and `arena.ts` judge a change to those
  numbers by win rate over seeded matches rather than by inspection.
- A co-evolutionary training run is recorded as a **negative result** rather
  than quietly dropped.
- A computer seat waits 1.2 seconds before playing. That is pacing, not
  thinking — deciding takes well under a millisecond — because three seats
  resolving instantly is a table nobody can read.

#### MCP seat server

- `src/mcp/`, a Model Context Protocol server over stdio that claims two or
  three seats at a live match, so one person can play a four-player game against
  a model. Seven tools, and **no dependency**: MCP is JSON-RPC over stdio and
  `rpc.ts` is the whole protocol layer. `@modelcontextprotocol/sdk` was
  inspected and rejected — 17 transitive packages including an HTTP stack and
  OAuth, none of which a stdio server reaches.
- Isolation is a missing capability, not a rule: each seat gets an opaque
  128-bit handle at claim time and every seat-scoped tool demands one, so an
  agent holding one seat's handle cannot read another's hand. Without it the
  game stops existing — one mind holding three hands makes every Informant guess
  a certainty.
- A seat's own frame is the only authority on that seat's turn. Three sockets
  have no ordering guarantee, so routing from whichever frame arrived first
  hands a seat a turn whose view holds no legal play.
- `scripts/hostSeat.ts` and `scripts/mcpPlay.ts` drive a live match by hand, and
  `bun run compile:mcp` produces a standalone MCP binary.

#### Table and interface

- **The Reference dock** — one surface holding the card reference, how to play,
  and the match log, none of which ends your turn.
- **Card abilities on hover, and on long-press for touch**, so what a card does
  is readable without committing to playing it.
- **An elimination notice that says why you are out**, and can be dismissed.
- The card reference states what each *value* does, not only who holds it —
  guesses name a value, never a character.
- The lobby states how many Devotion Tokens win at this table size.
- Faces on opponent discards. The identity was never missing; it was being
  discarded one layer above the renderer.
- Finished rounds are kept in match state (`src/game/engine/`).

#### Server and distribution

- **The binary lists every address it answers on.** `Bun.serve` is given no
  bind hostname, so it has always listened on every interface — the banner
  printed only `localhost`, which is the one address guaranteed not to work from
  the phone someone is holding. Loopback first, then each external IPv4 labelled
  by its interface, with a Tailscale address named rather than shown as the
  `utun` tunnel it rides on. Link-local and IPv6 are excluded: a laptop reports
  eleven addresses and three are typeable.
- `--port=<n>` on the command line, accepted by the binary and `bun run serve`
  alike, because the port is the one tunable someone learns at the moment of
  starting the server. An unrecognised argument exits 1 rather than being
  silently ignored — `bun run serve --port=5000` previously bound 3000 and
  reported `EADDRINUSE` while appearing to disregard the flag.
- Static responses are compressed.
- `bun run server` and `bun run host` scripts.

### Changed

- **The renderer is DOM.** `src/client/ui/table.ts` draws the table from the
  same `LayoutSpec` and `RenderPlan` the pure layer already produced, and
  `src/client/ui/beats.ts` runs the beats on `element.animate().finished`. The
  research behind the decision is in
  `docs/plans/2026-07-30-renderer-architecture-research.md`: `Court.ts` was ~900
  lines of draw glue over rects already computed, and zero lines that needed a
  canvas. Of the four GPU effects the design catalogued, one was real.
- **The between-round reveal is ten seconds, not five.**
- Accessibility no longer needs a parallel tree. Seat chips and hand cards are
  real `<button>`s with accessible names, and a card a rule forbids carries
  `aria-disabled` with its reason wired by `aria-describedby`.
- The README shows the game — nine screenshots — and documents the computer
  opponents, which had shipped undocumented.
- `.agents/skills/` holds nine skills describing *this* codebase: the surface
  contract, the purity gate, table layout, WAAPI motion, the test gates, the
  wire, and three on building visual effects with no dependencies.

### Fixed

- **Fifteen fixes from one audit of all 39 table elements**, each proved by
  reverting it and watching its test fail. Among them: the own-row value plate
  grew downward out of its row, overflowing by 7.8–10.4px on every viewport
  tested; the devotion medallion painted at 71% width because
  `devotion_token.png` is 512×720 and the spec treats it as an edge length; a
  transform does not change layout width, so a scaled nickname kept its full
  unscaled scrim and ran over the neighbouring seat; and borders were consuming
  layout, since `box-sizing: border-box` shrinks the padding box, so both state
  rings are outlines at `outline-offset: -2px`.
- **From turn ten the match log rendered `L0.`, `L1.`** — `list-style-position:
  outside` paints the marker inside the list's left padding, and a flat 1.5rem
  budget holds one digit. Now `max(var(--space-6), 3.5ch)`, tracking the font
  rather than a pixel guess, plus `tabular-nums`.
- **A screen taller than the viewport could not be reached.** `place-content:
  center` overflows in *both* directions, and the half past the start edge is
  unreachable because centring pushes it above the scroll origin. `safe center`
  exists for exactly this; the unprefixed declaration stays first as the
  fallback. Latent since the beginning — the lobby is simply the first screen to
  outgrow a viewport, which the difficulty fieldset is what did.
- The hand portrait rendered at its native pixel size.
- The discard block escaped its chip, and the state caption drew through an
  opponent's discards.
- The seat chip is budgeted, so devotion tokens stop hiding under the nickname.
- An open action sheet re-renders when the turn arrives, and a sole legal target
  is chosen for you.
- Each of the three reasons a card will not play gets its own words.
- A new match no longer inherits the previous one's open Reference.
- **Close is pinned above the scroll**, so a long match log cannot bury it.
- Long-press could never fire, and the dock sat on top of the action sheet.
- The deck's warning pulse repeated forever, holding the render loop open.
- MCP stopped shipping dead history, and says why a play was refused.
- `tableContract.test.ts` asserted `includes("." + field)`, which passes on any
  longer identifier — so `BannerPlan.text` was satisfied by an unrelated match.

### Removed

- **Phaser**, and with it `Court.ts`, `beats.ts`, `Boot.ts`, `Preloader.ts`,
  `game/main.ts`, and three modules that existed only to pay for the engine:
  `renderPolicy.ts` (a pump stopping a loop that rendered unconditionally — the
  compositor has a dirty check), `inputPolicy.ts` (`windowEvents: false`, so a
  tap on the DOM layer stopped also hit-testing the canvas beneath it), and
  `a11yTwin.ts` (an offscreen shadow of focusable proxies for canvas cards; the
  cards are real buttons now, so the proxy and the thing it proxied are one
  object).
- **`log.js`**, which pinged a third party with the Phaser version on every dev
  and build, and the `phasermsg` Vite plugin, which printed an invitation to
  email the engine's vendor after every production build. The `dev-nolog` and
  `build-nolog` scripts went with it, being duplicates once the ping was gone.
- The 28 Phaser API skills in `.agents/skills/`. Documentation describing
  something absent is worse than none, because the tooling surfaces it and it
  reads as evidence.
- Two assets nothing drew — `card_front_3.png` (295 KB) and
  `ui_panel_metal.png` (497 KB) — moved to `art/`, tracked but never built. The
  embedded manifest falls from 30 files to 27 and `dist/assets` from 8.1 MB to
  7.4 MB.

### Docs

- `docs/plans/2026-07-28-mcp-seat-design.md`,
  `2026-07-30-computer-opponent-design.md`, and
  `2026-07-30-renderer-architecture-research.md`, each written before the code
  and corrected against what shipped.
- The record of a real phone pass, including the two ways the harness lied
  first, and of the render-loop investigation — whose 80% GPU report turned out
  to be Edge's transparency setting rather than this game. The pump was kept
  anyway, on arithmetic rather than the hypothesis that prompted it, and is now
  gone with the renderer that needed it.

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

[1.2.0]: https://github.com/TuesdayCrowd/the-mules-court/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/TuesdayCrowd/the-mules-court/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/TuesdayCrowd/the-mules-court/releases/tag/v1.0.0
