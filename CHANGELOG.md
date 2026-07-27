# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.0]: https://github.com/TuesdayCrowd/the-mules-court/releases/tag/v1.0.0
