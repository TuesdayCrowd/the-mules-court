# The Mule's Court — UIX Design

**Date:** 2026-07-23
**Status:** Approved design. This is a design plan, not an implementation plan.
**Reads with:** `README.md` (rules), `docs/plans/2026-07-22-transport-design.md` (protocol), `VISUAL_SHOWCASE.md` (the interaction baseline this document absorbs and extends).

This document defines the complete client experience: menu, hosting and joining, lobby, the match table, card play, reveals, round and match end, pause and reconnection, and every error a player can meet. It supersedes `VISUAL_SHOWCASE.md`'s fixed 1024×768 layout system while keeping its interaction design — the labelled-button action panel, the show-ineligible-with-reason principle, value-first card labels, the quick reference, and its palette.

## 1. Decisions

These were settled with the project owner before design began:

| Decision | Choice |
| --- | --- |
| Platform | Fully responsive: phone portrait through desktop, touch-first, nothing depends on hover |
| Tone | Readable first; cinematic effects only at key beats (eliminations, The Mule, round end, match end) |
| Scope | Full client flow — menu, host/join, lobby, table, results, reconnection and error states |
| Prior design | `VISUAL_SHOWCASE.md` is the interaction baseline; its fixed-canvas layout metrics are superseded |
| Portraits | One curated portrait per character; the other three variants ship unused |
| Architecture | DOM + canvas hybrid (unanimous across an architecture panel and roundtable review) |

## 2. Architecture: one canvas, one DOM layer

The Phaser canvas renders the living table. The DOM renders everything made of words. Both are projections of one client store; neither owns game state.

| Surface | Layer | Why |
| --- | --- | --- |
| Seats, cards, deck, all animation, cinematic beats | Phaser canvas | Tweens, Filters, particles — the work Phaser exists for |
| Menu, host/join, lobby | DOM | Text inputs need IME, autocorrect, and clipboard; canvas fakes all three badly |
| Action panel, quick reference, seat dossier | DOM | Real `<button disabled>` with reasons, native focus order, free reflow |
| Overlays: round over, match over, paused, errors | DOM | Text-heavy, needs `aria-live`, no animation beyond fades |
| Toast narration of the public log | DOM | It is an `aria-live` region by definition |

The DOM chrome lives in a sibling overlay (`#ui-root`, fixed position above the canvas), not in `Phaser.GameObjects.DOMElement`. Every DOM surface anchors to the **viewport** — bottom sheets, edge panels, centered modals — never to a canvas coordinate, so the two layers share no positioning math. `DOMElement` was considered and rejected: it exists to sync DOM into camera transforms, a problem this design deliberately does not have, and it costs a single-nesting-level constraint the lobby and quick reference would fight. The root overlay sets `pointer-events: none`; interactive children restore `auto`. Canvas taps and DOM taps therefore never compete for the same pixel.

### 2.1 The client store and the single reconciler

A plain TypeScript store (no framework) holds the latest `STATE_UPDATE` — the `RedactedView` plus the transport fields beside it (`nicknames`, `phase`, `paused`, `missingSeats`, `revealDeadline`, `serverTime`) — and the connection lifecycle. The WebSocket client, localStorage token handling, and message dispatch live here, importable and testable without Phaser.

**One function, `renderView(view)`, positions the table.** It runs on every `STATE_UPDATE` and on every resize. Reconnect, phone rotation, and window drag are one code path that rebuilds from server truth — never three paths that drift apart. Resizes are debounced (~100 ms) and ignored while a text input has focus, which survives iOS Safari's keyboard and toolbar resize storms.

Animation derives from diffing: new `publicLog` entries queue their canvas animations and toasts in order; `revealed[]` set changes trigger peek reveals and expiries. The store applies snapshots immediately; the animation queue presents them.

### 2.2 Scale and layout

- `Scale.RESIZE`: the canvas fills the viewport 1:1. No design resolution, no letterboxing. Phaser's ScaleManager tracks the parent element itself; nothing calls resize functions manually.
- **Table layout is data**: pure functions `(playerCount, w, h) → LayoutSpec` return every canvas position and size. They import nothing from Phaser, so Vitest tests them without a Scene — matching the engine's test culture.
- Three **topology classes**, picked by aspect ratio: `portrait` (aspect < 0.9), `landscape-narrow` (0.9–1.45), `wide` (> 1.45). Compositions differ between classes; within a class every position is a fraction of the live viewport, fully fluid. Class boundaries are the only discrete jumps.
- DOM chrome ignores all of this: CSS handles it with `clamp()`, grid, and container queries.

### 2.3 Design tokens

One token source feeds both layers: CSS custom properties in `tokens.css`, mirrored by a generated TypeScript module for canvas draw calls. The palette is `VISUAL_SHOWCASE.md`'s, unchanged:

| Group | Tokens |
| --- | --- |
| Base | background `#000000`, nebula red `#ef4444`, nebula purple `#a855f7` |
| Seat states | current turn `#ef4444`, other `#6b7280`, protected `#22d3ee`, eliminated `#9ca3af`, disconnected `#6b7280` dashed |
| Game states | your turn `#c084fc`, waiting `#9ca3af`, round over `#4ade80`, paused `#fbbf24`, match over `#fbbf24` |
| Deck | full `#9333ea`, low `#b45309`, empty `#991b1b` |

### 2.4 Typography

Two self-hosted OFL fonts, bundled as woff2: a display face for titles and card values, a UI face for everything else. Working proposal: **Exo 2** (display) and **Inter** (UI); the curation pass makes the final call. The client awaits `document.fonts` before creating any Phaser text, so canvas text never renders in a fallback font and re-renders in the real one.

### 2.5 Scene chain

```
Boot → Preloader → Court
```

`Court` is the only gameplay scene. Between matches it idles as the ambient nebula behind the DOM screens; during a match it renders the table. The starter `MainMenu`, `Game`, and `GameOver` scenes are deleted — **a deliberate deviation from AGENTS.md's "keep the scene chain" guidance**, recorded here: menu and game-over are DOM surfaces now, and an empty Phaser scene under each would be dead weight. AGENTS.md should be updated when implementation lands.

### 2.6 Routing

- `/` — menu.
- `/join/:matchId` — the join flow. This is the server's `joinUrl` shape (`config.publicBaseUrl + '/join/' + matchId` — note: **not** the `/m/` path VISUAL_SHOWCASE's mockup shows).

With a stored seat token for the match, the client's first socket message is always `RESUME_SEAT`; otherwise the join flow runs `CLAIM_SEAT`.

## 3. Menu, hosting, joining

**Menu** (DOM): the title, then two actions.

- **Host a game** → `POST /api/rooms`. The client persists the returned `hostSeatToken` to localStorage under `mules-court:${matchId}` *immediately* — it never arrives over the socket and there is no other copy — then routes to `/join/:matchId`, where the token makes it resume as `p1`. An HTTP 429 shows "creating your court — trying again shortly" with automatic backoff, never an error page.
- **Join a game**: a paste-a-link field for links received out of band. Opening a join link directly skips the menu.

**Join flow** at `/join/:matchId`, no stored token: one inline step — a nickname field and a **Take a seat** button. The field trims, enforces 1–24 characters, and rejects control characters client-side, so `MALFORMED` never round-trips. `CLAIM_SEAT` goes out; `SEAT_CLAIMED` comes back once, and the client persists `{seat, seatToken}` the instant it arrives. The server assigns the lowest open seat; there is deliberately no seat-picking UI.

## 4. Lobby

DOM screen; the canvas idles as nebula behind it.

```
┌───────────────────────────────────────┐
│           THE MULE'S COURT            │
│                                       │
│  Share this link to invite players:   │
│  ┌─────────────────────────────────┐  │
│  │ …/join/K7QX2            [Copy]  │  │
│  └─────────────────────────────────┘  │
│                                       │
│  Seat 1  Cornelius  ⭐ host (you)     │
│  Seat 2  Ana                          │
│  Seat 3  (open)                       │
│  Seat 4  (open)                       │
│                                       │
│         ┌───────────────┐             │
│         │  Start Match  │  host only  │
│         └───────────────┘             │
│   Waiting for 2–4 players,            │
│   all connected                       │
└───────────────────────────────────────┘
```

- The invite box copies via `navigator.clipboard` — free, because this is real DOM.
- Seat rows render `LOBBY_UPDATE.seats[]`: nickname, host marker, and status — *open*, *occupied*, or *reconnecting…* for a dropped claim. A dropped non-host seat visibly reopens when the 60-second lobby grace expires.
- Only the host sees **Start Match**, enabled exactly when `canStart` is true. While disabled, a caption states why ("waiting for 2–4 players, all connected") — the show-reasons principle applies to buttons, not just targets.
- The host seat never reopens. If the host stays gone past the lobby grace, every remaining player's screen offers **Dissolve lobby** (`END_MATCH`).
- A lobby that never starts expires after 15 minutes (`lobbyTtlMs`); players see the abandoned-match screen (§10).

## 5. Failure surfaces

Every error a player can meet has designed copy. None fall through to a generic message.

| Signal | Experience |
| --- | --- |
| `FATAL BAD_TOKEN` | Drop the stored token silently; retry as a fresh join. The retry's outcome picks the message — the server makes "wrong link" and "expired room" indistinguishable on purpose, so the copy never claims to know which. |
| `FATAL SEAT_TAKEN` | Full-screen "This match is open in another window." A **Take over here** button reconnects, deterministically evicting the other tab back. |
| `ROOM_NOT_FOUND` | "That court has dissolved — the link may be old or mistyped." Back to menu. |
| `ROOM_FULL` | "The court is full." Back to menu. |
| `MATCH_OVER` | "This match has ended." Back to menu. |
| `RATE_LIMITED` | Toast with automatic backoff. Never fatal; the client also self-throttles sends. |
| HTTP 429 (host/join) | Inline "trying again shortly" with backoff. |
| Engine `ERROR` + `refId` | The pending card snaps back; a toast names the violated rule (the engine forwards rule names, never card contents). |
| Socket drop | Connection dot goes amber; automatic reconnect walks `RESUME_SEAT`. |

A small connection dot lives in a screen corner on every surface. On `visibilitychange` back to visible, the client sends `REQUEST_RESYNC` rather than trusting a stale view.

## 6. The table

### 6.1 Composition by topology class

All canvas, positioned by the `LayoutSpec` functions.

**Portrait** (phone, ~390×844 reference):

```
┌─────────────────────────────┐
│ ●        Round 3       [?]  │  status strip + quick-ref tab
│ ┌───────┐┌───────┐┌───────┐ │
│ │ ANA   ││ BAYTA ││ TORAN │ │  opponent chips (1–3)
│ │🂠 👁×2 ││🂠 👁×1 ││ 💀    │ │
│ │▪1▪3▪5 ││▪2▪4   ││▪1▪8   │ │  discard pips — never truncated
│ └───────┘└───────┘└───────┘ │
│         ┌──────┐            │
│         │ DECK │  Removed:  │  2p only: removed card
│         │  11  │  (stacks   │  panel stacks BELOW deck
│         └──────┘   below)   │
│        Waiting for Ana      │  turn banner
│                             │
│    (toast narration zone)   │
│                             │
│  👁👁  ▪2 ▪4                │  own tokens + discards
│   ┌─────────┐ ┌─────────┐   │
│   │ 1|Infor-│ │ 4|Shiel-│   │  own hand, full size
│   │  mant   │ │ ded Mind│   │
│   └─────────┘ └─────────┘   │
│ ═══════ action dock ══════  │  sheet rises from here
└─────────────────────────────┘
```

Three opponent chips fit 390 px at ~120 px each; the layout functions prove it and Vitest holds them to it.

**Landscape-narrow** (rotated phone, small tablet): opponents spread into a shallow arc across the top; the deck centers with real side margins; the hand compresses vertically but keeps full width.

**Wide** (desktop, large tablet): the VISUAL_SHOWCASE compositions, fluidly scaled — generous seat panels with full portrait art, deck and removed-card panel side by side, large hand cards.

### 6.2 Seat chips

Each chip carries: nickname · devotion tokens · a card-back marker while holding a card · the discard pile.

- **Discard pips never truncate.** Every played value stays visible at all times, as value pips with a running total (`▪1 ▪3 ▪5 = 9`), wrapping to more rows as the pile grows. The layout functions reserve room for the worst case (a two-player round can reach 7 discards on one seat — verified against the engine by simulation). Pips shrink toward a legible floor before anything else in the chip does. This is deduction data; hiding any of it mid-inference is a design failure.
- **Tokens collapse; discards don't.** Token medallions wrap at four and collapse to `👁 ×5` under width pressure — a count of identical items loses nothing as a numeral. Discard values are heterogeneous and never collapse.
- **Tapping a chip opens the seat dossier** (DOM sheet): the full discard pile in play order with card names, the value total, token count, status, and — as its second tab — the complete match log. Supplementary detail, never required to see values.

### 6.3 Seat states

Unchanged from the baseline:

| State | Treatment |
| --- | --- |
| Current turn | Red border, slow scale pulse (1.0 → 1.03), banner names the player |
| Protected | Pulsing cyan strip: "Protected — cannot be targeted"; clears on the update that begins their turn |
| Eliminated | Grayscale Filter, 50% dim, skull badge — and their held card revealed face-up atop their discard pile. That reveal is core deduction data; the seat hides nothing. |
| Disconnected | Dashed gray border, "Reconnecting…"; cards stay, the seat is held |

### 6.4 Deck and turn banner

The deck shows a card back and `view.deckCount`: purple normally, orange with a subtle pulse at ≤ 3, dark red with a strong pulse at empty — a genuine warning that the showdown is one play away. The banner beneath it states the game state in words: *Your turn* (purple) / *Waiting for Ana* (gray) / *Round over* (green) / *Paused* (amber).

### 6.5 Narration

Each new `publicLog` entry renders a short toast — "Ana played Informant — guessed 5 — missed" — in a DOM `aria-live="polite"` region above the hand zone. Toasts are sequenced *after* their canvas animation lands (§8.4), and the full log persists in the seat dossier.

## 7. Playing a card

### 7.1 Hand states

On your turn, cards named in `view.own.legalPlays` show the purple playable border; anything absent dims to 40%. The dim state is real, not decorative: holding The First Speaker beside Mayor Indbur or a Darell dims the other card, captioned *"must play The First Speaker."* The client never computes this rule — `legalPlays` says so.

Tapping a playable card raises it (8 px, bright border, glow) and opens the action sheet. Off-turn, tapping your own card opens a read-only detail view — full portrait, effect text — so you can always study your hand; you just cannot act.

### 7.2 The action sheet

DOM, always **viewport-anchored, never card-anchored**: a bottom sheet over the dimmed table on narrow layouts, a right-edge panel on wide ones. Which edge it takes is a live geometry test on available width — never a device sniff — so a resized window or an unfolding phone simply re-evaluates on the next open. One panel system everywhere; no coordinate sync with the canvas, ever.

Anatomy, top to bottom:

```
┌──────────────────────────────────┐
│  1 · Informant                   │
│  Guess a value from 2 to 8. If   │
│  they hold it, they are out.     │
├──────────────────────────────────┤
│  Choose a target                 │
│  [👤 Ana]  [👤 Bayta]            │
│  [👤 Toran — protected]  ✕       │
├──────────────────────────────────┤
│  Guess a value                   │
│  [2] [3] [4] [5]                 │
│  [6] [7] [8]                     │
│  Tap a value to see its cards    │
├──────────────────────────────────┤
│         [ Cancel ]  [ Play ]     │
└──────────────────────────────────┘
```

- **Targets**: every opponent as a real `<button>` — portrait thumbnail plus nickname — with ineligible ones rendered `disabled` and their reason attached via `aria-describedby` ("protected", "eliminated"). Hiding them would hide the rules.
- **Guess** (Informant only): seven buttons, 2–8. Value 1 is absent because the Informant may never guess itself — a rule, not a missing option. Each value expands to show which characters share it: value 5 covers both Darells, and knowing that is the whole game.
- **No legal target**: the target section is replaced by a plain statement — "Every other player is protected or eliminated. This card will be discarded with no effect." A legal move stated calmly, not an error.
- **No target needed** (Shielded Mind, The First Speaker, The Mule): effect text and Play alone.
- **Footer**: Cancel / Play pinned to the sheet's bottom edge, thumb-reachable without scrolling past the grids. All buttons ≥ 48 px tall.

**The Mule** gets no extra modal — raising the card and opening the sheet is already deliberate — but its Play button turns red and states the consequence exactly: **"Discard The Mule — you are eliminated."**

### 7.3 Submission

Honest, not optimistic. `PLAY_CARD` goes out with a `clientMsgId`; the played card enters a shimmer-pending state and input locks. The next `STATE_UPDATE` resolves it, or an `ERROR` with matching `refId` snaps the card back and a toast names the violated rule. No local state mutates before the server speaks.

## 8. Reveals and cinematic beats

The cinematic budget is spent exactly where the tone decision put it. Everything else resolves in ≤ 300 ms.

### 8.1 Private peeks

Han Pritcher, Bail Channis — and both comparison cards, whose participants learn each other's hands the same way. The client diffs `view.revealed[]`: a newly appearing `{subjectId, cardTypeId}` triggers the private reveal — the card face shown large, marked *"Only you see this"* — then persists as a small known-card marker on that seat chip, visible only to this viewer. When the peek expires server-side (the card was played, traded, or redrawn), the entry vanishes from `revealed[]` and the marker fades. The engine owns validity; the UI mirrors it.

### 8.2 Eliminations

Banner fades in (200 ms) → seat desaturates and dims (500 ms, grayscale Filter) → the victim's held card flips face-up onto their discard pile. The flip is the information, so it stages last and biggest. ~1 s total, non-blocking.

### 8.3 The Mule

The flagship beat, reserved for the Mule alone, identical for voluntary and forced discards: a table-wide displacement ripple driven by `shaders/distortion_map.png`, the Mule's portrait looming center-stage ~1.2 s, then the elimination sequence. The dread is the point.

### 8.4 Sequencing rule

The `aria-live` narration and any DOM result text hold until the matching canvas animation resolves. The accessible channel must never announce a result the visible table has not shown.

### 8.5 Shader map assignments

| Map | Owner |
| --- | --- |
| `distortion_map.png` | The Mule beat (displacement Filter) |
| `sparkle_pattern.png` | Match victory particles |
| `rainbow_gradient.png` | Devotion-token award shimmer |

`prefers-reduced-motion` collapses every beat to plain fades; countdowns and pips are unaffected.

## 9. Round end, match end, paused

### 9.1 Round over (DOM overlay, table visible beneath)

Deck-out showdown: surviving hands flip face-up staggered 150 ms (from `roundResult.revealedHands` — the only legal source of another player's hand), the reason line states the rule ("Deck ran out — highest card wins"), and tie-breaks point at the discard totals already visible on every chip. The token award follows: a medallion pip drifts onto the winner's seat with the rainbow shimmer.

The five-second countdown renders from `revealDeadline` and decides nothing. After any disconnect it restarts at a full five seconds — the transport never resumes a partial window, so the UI never shows one.

A round won by elimination skips the comparison and crowns the survivor — the eliminations were already narrated as they happened. A round that also wins the match skips this overlay entirely.

### 9.2 Match over

DOM overlay; `sparkle_pattern` particles burst on the canvas beneath. Winner, gold pulse, final token tallies (`tokensToWin` states the target: 7/5/4 by player count), **Back to menu**. The `abandoned` variant (`MATCH_ENDED.reason`) is deliberately quiet: one line, no celebration chrome.

### 9.3 Paused

The table dims beneath a DOM overlay: "Waiting for Ana to reconnect… the match resumes automatically." No card can be played (`PAUSED` guards server-side too). The host always sees **End match**; every other seat gains it once any seat has been missing past the active grace, estimated locally from the `serverTime` at which the seat entered `missingSeats` — an estimate only, since the server alone enforces it.

**Correction to the baseline:** VISUAL_SHOWCASE says End match appears "after 10 min"; `config.ts` sets `activeGraceMs` to **2 minutes** (the 10-minute figure is `zeroConnTtlMs`, the everyone-gone reaper). The design follows the code.

## 10. Quick reference

A persistent floating tab (bottom corner, layered above the action sheet) opening a DOM modal — near-fullscreen and scrollable on phones, a side drawer on wide screens. Reachable at every moment, including other players' turns, because deduction depends on knowing what is still out there.

The table is value-ordered 8 → 1 with the **count-per-value** column front and center; characters sharing a value share a row, since the game never distinguishes them. The panel answers the Informant's actual question: value 5 covers both Darells, value 1 is five of sixteen cards.

## 11. Accessibility

- All chrome is native DOM: real focus order, real `disabled` with `aria-describedby` reasons, real inputs with IME and autocorrect. Non-Latin nicknames work for free (the server accepts any non-control characters up to 24).
- The canvas table gets one offscreen DOM twin: a per-seat status list re-rendered each `STATE_UPDATE`, plus focusable proxies for the viewer's 1–2 hand cards — positioned from the same `LayoutSpec` that placed the cards. These proxies are the only shadow elements in the app.
- The sequencing rule (§8.4) governs all announcements.
- **axe-core runs against the DOM chrome inside the `bun run test` gate.** Accessibility is a property that regresses; it gets regression tests.
- Touch targets ≥ 48 px. Palette contrast verified during implementation against WCAG AA for text-bearing pairs.
- `prefers-reduced-motion` respected throughout (§8.5).

## 12. Asset production list

Work this design requires beyond what exists in `public/assets/`:

| Task | Detail |
| --- | --- |
| Portrait curation pass | Pick one of four variants per character (project owner's aesthetic call); record the picks |
| Card front | Recommend `card_front_3.png` (512×720 — portraits drop in at exactly 1:1); `card_front_1` (768×1024) needs a crop window instead |
| Card back | Pick one of the three designs; `card_back_2`/`card_back_3` are already card aspect (768×1024), `card_back_1` (1024×1024) would need a crop |
| Fonts | Two OFL woff2 files (proposal: Exo 2 + Inter), self-hosted |
| Icons | Small SVG set to retire the emoji placeholders: shield, skull, hourglass, crown, eye/token |
| Buttons & panels | CSS `border-image` from `ui_panel_metal.png` in DOM; native `this.add.nineslice()` on canvas |
| Target thumbnails | Runtime crop via CSS `object-fit` — no pregeneration |
| Background | `playfield_background_space.png` is 512×720; verify it survives cover-scaling on wide desktops, else render a larger seamless version |

## 13. Open questions and follow-ups

1. **Host nickname (transport gap, blocks the lobby design).** The host seat is minted over HTTP with no nickname; `claimSeat` is the only setter and `RESUME_SEAT` carries no nickname field, so every lobby shows a blank host. Recommend a small transport addition: an optional `nickname` on `RESUME_SEAT`, applied only when the seat has none and the phase is `lobby`. Until then the client falls back to "Host".
2. **Real-device QA pass** before implementation sign-off: iOS Safari keyboard/toolbar resize storms, devicePixelRatio crispness, and the DOM/canvas touch seam. Devtools emulation does not reproduce Safari's viewport behavior.
3. **Manual VoiceOver/TalkBack pass** — axe-core catches structure, not experience.
4. **VISUAL_SHOWCASE.md** carries superseded metrics and the stale 10-minute figure; it gains a pointer note to this document (done alongside this design) and should be pruned or absorbed when the client ships.
5. **AGENTS.md** describes the five-scene starter chain; update it when the scene change (§2.5) lands.

## 14. Interface rules

The baseline's five rules survive; the hybrid adds four:

1. **Render the view; decide nothing.** Turn order, legality, and timing arrive from the server.
2. **Never depend on hover.** Touch is a first-class input.
3. **Show ineligible choices with their reason.** Hiding them hides the rules.
4. **Never show another player's hand** except from `revealed[]` (your own peeks) and `roundResult.revealedHands` (the showdown).
5. **The server owns every clock.** Countdowns render `revealDeadline`; nothing expires locally.
6. **One reconciler positions the table.** `STATE_UPDATE` and resize share `renderView(view)`; no other code moves a table element.
7. **Discard values never truncate.** Tokens may collapse to a numeral; deduction data may not.
8. **The accessible channel never runs ahead of the visible one.** Announcements wait for their animation.
9. **DOM anchors to the viewport, never to a canvas coordinate.** The layers share design tokens, not geometry.
