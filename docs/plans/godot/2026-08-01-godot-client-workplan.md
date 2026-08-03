# The Mule's Court — Godot Client Workplan

> **Superseded (2026-08-02) by `2026-08-02-godot-full-rewrite-master-plan.md`.** This document
> recommended a *second client* (Scope A) and rejected the full rewrite (Scope C). The owner
> has since chosen the full rewrite. This file is retained for its reasoning — the master plan's
> §2 answers each objection below rather than dismissing it, so this remains the record of *why
> the rewrite is hard*, which is exactly the thing the rewrite plan is built to survive.

**Date:** 2026-08-01
**Status:** Superseded. §3 recorded the second-client shape; §10 lists the gates. See the master plan for the current direction.
**Scope:** What "redesign the game in Godot 4.7.1" should mean, and the staged work to get there.
**Depends on:** `docs/plans/typescript/2026-07-30-renderer-architecture-research.md` — whose findings this
either inherits or must explicitly overturn.
**Target:** Godot 4.7.1 (4.7 stable shipped June 2026; 4.7.1 is the maintenance release).

---

## 1. The question, stated precisely

"Redesign the game in Godot" hides three different projects behind one sentence, and they
differ by an order of magnitude in cost and in what they put at risk:

| Scope | What it means | Cost | What it risks |
| --- | --- | --- | --- |
| **A. Second client** | Godot speaks the existing WebSocket protocol. Server, engine, AI, MCP seats, persistence all unchanged | ~6-8k LOC GDScript | The client half only |
| **B. Client + GDScript engine, same server** | Two engines in two languages, one authoritative | A + ~3.5k LOC + a determinism proof | Divergence between two rule implementations |
| **C. Full rewrite** | GDScript engine, Godot `MultiplayerAPI`, headless Godot server | Effectively a new project | 26,346 LOC of tests, and the correctness argument they encode |

This document recommends **A**, with **B** as a later, optional stage gated on a specific
need (offline solo where a subprocess is impossible — i.e. mobile). **C** is rejected, and
§4 says why in terms of what would actually be lost.

---

## 2. The uncomfortable prior

Three days ago this project concluded a two-pass research effort and decided to **remove**
a game engine. The reasoning in `2026-07-30-renderer-architecture-research.md` §4 was not
"Phaser is bad." It was structural, and most of it is about canvas, not about Phaser:

- Canvas has no accessibility tree. PixiJS — the library whose entire purpose is canvas —
  ships an accessibility system that works by overlaying real DOM. The ecosystem already
  answered this question.
- This game's whole payload is text and numbers. There is no non-textual fallback.
- `axe.test.ts` audits the DOM tree. Every surface on a canvas silently exits the project's
  sole automated accessibility gate.
- §4.5 named, by name, "**Godot's web export**" as one of the two "all-engine" analogues
  that "needed years of bolted-on and still-incomplete text-input and accessibility
  infrastructure."

Adopting Godot re-acquires most of that, in the browser. That is not a reason to refuse —
it is a reason to make the decision explicitly rather than by momentum, and to be honest
about which of those findings Godot answers and which it does not.

**What Godot genuinely answers that Phaser did not:**

- *Accessibility.* Godot 4.5+ integrates AccessKit, giving `Control` nodes real screen-reader
  support with OS-native adapters. This is a categorical difference from Phaser's `tabIndex`
  property documented as "reserved for future use… not implemented." It is still marked
  experimental by upstream, and **its status on web export is unverified** — see §10, gate 1.
- *Text input.* `LineEdit` exists. Phaser had zero. The nickname field is not a research problem.
- *Focus order.* Godot has a real focus system with `focus_neighbor_*` and
  `focus_behavior_recursive` (4.5+). Phaser had none.
- *The Mule beat.* See §4.

**What Godot does not answer:**

- Bundle size on web. Current shipped client is 104 KB of JS+CSS over ~7.4 MB of art. A Godot
  web export is a WebAssembly runtime plus a PCK — tens of megabytes before art. This is the
  one regression with no engineering answer.
- Web export on Apple platforms. Godot 4's HTML5 export has long-standing `SharedArrayBuffer`
  and WebGL 2.0 problems on macOS and iOS Safari. The current client explicitly supports
  phone play (README, *Playing from a phone*). A Godot web export would not.
- `axe.test.ts`. It audits a DOM tree. There isn't one.

The resolution those three points force is the shape of the whole plan: **Godot is the right
client for native targets and the wrong client for the browser.** The architecture already
lets you have both.

---

## 3. Verdict: a second client, not a rewrite

The engine's own module docstring settles this more cleanly than any argument could:

> *A headless, server-authoritative, deterministic reducer. No Phaser, no I/O, no ambient
> randomness: this module runs unchanged in a browser or a plain Node process, which is what
> lets the authoritative copy live on a server.*

And the README:

> *The interface holds no game state. The server pushes a `RedactedView` — one player's
> redacted picture of the match — and the client sends back a single `PLAY_CARD` message.
> Anything the interface appears to decide, it read from that view.*

That is not merely a clean seam; it is a *port*, in the hexagonal sense, and the client is
an adapter. A Godot client is a second adapter against the same port. Nothing above it moves.

The wire has also already survived two independent client implementations — the browser
client and `src/mcp/`, which claims a seat over the same socket and plays through the same
`PLAY_CARD`. Godot would be the third. A protocol that has been implemented twice against
one server is a protocol with the abstraction leaks already found.

**The end state:**

```
                    ┌──────────────────────────────────┐
                    │  src/game/engine  (authoritative) │
                    │  src/game/ai      (bot seats)     │
                    │  src/server       (rooms, wire)   │
                    └───────────────┬──────────────────┘
                                    │  one JSON protocol
             ┌──────────────────────┼──────────────────────┐
             │                      │                      │
      ┌──────┴──────┐        ┌──────┴──────┐        ┌──────┴──────┐
      │  DOM client │        │ Godot client│        │ MCP seat    │
      │  (browser)  │        │  (native)   │        │ (agents)    │
      └─────────────┘        └─────────────┘        └─────────────┘
```

One authoritative engine, one wire contract, three clients with different reaches. That is a
better systems story than either client alone, and it is the story a reviewer can read off
the repository in thirty seconds.

---

## 4. What Godot buys, honestly ledgered

**It closes the one open decision gate the renderer research left standing.** §13.1 of that
document asks whether the Mule beat survives as "a portrait-warp plus table shudder" — a
downgrade accepted because a DOM table cannot hand a canvas an image of itself. Godot owns
both the content and the compositing surface. Render the table into a `SubViewport`, put a
displacement shader on the `SubViewportContainer`, and the original design — *warp the
actual table* — is a shader file and an animated uniform. §8 of that research is not a
constraint here; it is a feature of the platform.

**Native distribution.** One export matrix for macOS, Windows, Linux, Android, iOS. Today the
project ships five compiled binaries that each serve a browser. A Godot build *is* the app.
This is the strongest practical argument and probably the real motive.

**Gamepad and controller.** `InputMap` with device bindings, free. A card game is a fine
couch game and the current client has no path to that.

**4.7 specifically.** Control offset transforms — new in 4.7 — let you translate, rotate and
scale a `Control` without the parent container re-sorting and snapping it back, and the
transform is visual-only by default so a button does not lose hover state while it animates.
That is *precisely* the problem a card interface has, and it is the single best reason to
target 4.7 rather than 4.5. Your `beats.ts` choreography maps onto it directly.

**Costs, restated as a ledger rather than a warning:**

| Cost | Size | Mitigation |
| --- | --- | --- |
| Browser reach | Real, unfixable | Keep the DOM client. It is already built, tested and shipping |
| iOS/macOS web | Real, unfixable | Same |
| `axe.test.ts` coverage | Loses the Godot half | AccessKit + manual VoiceOver/TalkBack pass. Weaker; not nothing |
| ~9.7k LOC of client tests | Do not transfer | The engine/server/MCP suites (~16k LOC) are untouched |
| Duplicate copy and layout logic | Drift risk | §5 and §6 — data files plus a conformance corpus |

Everything in the left column is confined to the client. That containment is the argument.

---

## 5. The port surface, measured

Line counts are from the current tree, source only, tests excluded.

| Layer | LOC | Disposition under a Godot client |
| --- | --- | --- |
| `src/game/engine/` | 1,860 | **Untouched.** Stays authoritative on the server |
| `src/game/ai/` | 1,636 | **Untouched.** Bots are server-side; `ADD_BOT` is a protocol message |
| `src/server/` | 3,331 | **Untouched** |
| `src/mcp/` | 1,419 | **Untouched** |
| `src/client/content/` | 993 | **Becomes data.** See below |
| `src/client/tokens/` | 102 | **Ports to a `.theme` resource.** The contrast arithmetic ports exactly |
| `src/client/store/` | 2,263 | **Ports selectively.** Socket, diff, presentation queue, targets, motion port. `ids.ts` and `clipboard.ts` evaporate — Godot has `Crypto` and `DisplayServer.clipboard_set` unconditionally, with no secure-context caveat |
| `src/client/layout/` | 1,409 | **Split.** See below |
| `src/client/ui/` | 5,169 | **Rebuilt.** ~21 surfaces as scenes |
| `src/client/styles/` | 1,753 | **Rebuilt** as a theme + shaders |

Two judgments in that table are load-bearing and deserve their reasoning.

### 5.1 Layout: keep the decisions, discard the pixels

`renderPlan.ts` and `tableLayout.ts` compute absolute `Rect`s because canvas has no layout
engine. Godot has one — `Control` anchors, `Container` subclasses, and in 4.7 offset
transforms on top. Porting 1,400 lines of hand-rolled geometry into an engine that ships a
layout system would be importing a workaround for a problem the platform solved.

But two things in that folder are not geometry, and they must survive:

- **`topology.ts`** — who sits where relative to *you*. That is a rule about seating, not
  about pixels, and both clients must agree or the same match reads differently in two places.
- **The capacity facts.** `discardCapacity.test.ts` drives thousands of real engine matches
  to prove the deepest discard pile that can actually occur is **eight, not the seven the
  design assumed**. A Godot `VBoxContainer` will not discover that for you; it will simply
  overflow on the one match in a thousand that reaches eight. That test is a *derived fact
  about the game*, and it belongs in the shared corpus (§6), not in either client.

**Rule:** port the decision layer, let Containers own the rectangles, and move every derived
fact into the corpus where both clients are held to it.

### 5.2 Content: two clients must not narrate differently

`src/client/content/` is 993 lines of pure functions from view to prose — `narration.ts`,
`matchLog.ts`, `elimination.ts`, `announce.ts`, `rules.ts`, `quickReference.ts`. If this is
hand-ported to GDScript, the two clients will drift, and they will drift *silently*, because
nothing fails when a log line is worded differently in two places.

Do not port it twice. Extract the strings into JSON under a shared path, leave a thin
evaluator in each language, and pin the outputs in the conformance corpus. This also buys
localisation nearly free, which the current client has no path to.

---

## 6. The wire is the contract, and the corpus is how you hold it

This is the most important new artifact in the plan, and it is the same move as the
repository contract test in the ledger work: **one shared set of behavioural facts, run
against every implementation.**

**Obligations.**

- **R6.1** The protocol SHALL remain the single source of truth for client/server exchange.
  Neither client SHALL depend on a behaviour not expressible in `ClientMessage` /
  `ServerMessage`.
- **R6.2** A **conformance corpus** SHALL be checked in: a set of matches recorded as
  `{seed, actionLog}` together with the full sequence of `RedactedView` frames each seat
  receives, as canonical JSON.
- **R6.3** The corpus SHALL be **generated** from the engine by a script, never hand-written,
  so it cannot fall out of step with the rules.
- **R6.4** The corpus SHALL include, at minimum: a two-player match reaching sudden death; a
  four-player match; a round ending on deck exhaustion with a discard-total tiebreak; a
  shared round; a forced First Speaker discard; a match containing the eight-deep discard pile;
  and a protected-target rejection.
- **R6.5** Every client SHALL have a test that replays the corpus offline — no server process —
  and asserts its own derived output (seat topology, log narration, legality display, capacity)
  against the recorded expectations.
- **R6.6** A change to `src/server/protocol.ts` SHALL regenerate the corpus and SHALL fail CI
  for any client that has not been updated. The existing `.agents/skills/changing-the-wire`
  skill governs this and needs one added step, not a rewrite.

R6.5 is what makes the Godot client testable at all. Without it you are reduced to launching
a server and clicking, which is not a test suite and will not hold under an evening's work
every few days.

---

## 7. The determinism hazard — read this before Stage 6

This applies only if you later port the engine (Scope B). It is recorded now because it is
the kind of thing that is cheap to design for and expensive to discover.

`src/game/engine/rng.ts` is mulberry32 seeded by FNV-1a, and it is the sole source of
randomness. Its correctness rests on **32-bit unsigned arithmetic**:

```js
hash = Math.imul(hash, FNV_PRIME);
const s = (rng.s + 0x6d2b79f5) >>> 0;
t = Math.imul(t ^ (t >>> 15), t | 1);
```

GDScript integers are **64-bit signed**. There is no `Math.imul`, `>>>` is not `>>` on a
64-bit signed value, and `t | 1` on a negative number does not do what the JavaScript does.
A naive transcription compiles, runs, produces plausible-looking shuffles, and silently
produces a *different deck from the same seed*. Every persisted `{seed, actionLog}` in
`mules-court.sqlite` then replays into a different match, and the failure surfaces as
"reconnect shows me the wrong hand" three weeks later.

- **R7.1** A GDScript port of the RNG SHALL mask every intermediate to 32 bits
  (`& 0xFFFFFFFF`) and SHALL implement a 32-bit multiply helper rather than using `*`.
- **R7.2** A cross-language conformance test SHALL assert that `seedRng(s)` followed by *n*
  `nextRng` draws produces the identical stream in both implementations, for a generated
  sample of seeds and *n* — not a handful of examples.
- **R7.3** A cross-language test SHALL assert `shuffle(CARD_CATALOG_DECK, seedRng(s))`
  produces the identical ordering in both implementations, over a wide sample of seeds.

R7.2 and R7.3 are the *first* tests written in any engine port, before a single rule. If they
do not pass, nothing downstream is worth writing.

---

## 8. Staged plan

Sequenced so that work which is identical under both futures happens first, per the method
the renderer research used in its §12.

| Stage | Work | Wasted if the decision reverses? |
| --- | --- | --- |
| 0 | Generate and commit the conformance corpus (§6) | **No** — it hardens the DOM client too |
| 1 | Extract `content/` strings to shared JSON; DOM client reads them | **No** — removes hardcoded prose either way |
| 2 | Godot project skeleton; connect, claim a seat, print the raw view | Yes |
| 3 | Lobby and menu surfaces | Yes |
| 4 | The table; play a match end to end, unstyled | Yes |
| 5 | Theme, art pipeline, the nine beats, the Mule shader | Yes |
| 6 | *Optional:* GDScript engine + AI for offline solo | Yes |
| 7 | Export matrix, CI, signing, release | Yes |

### Stage 0 — Conformance corpus

- **R0.1** A script SHALL emit corpus files from the engine, covering R6.4.
- **R0.2** The DOM client SHALL gain a test replaying the corpus and asserting its topology,
  narration and capacity output — proving the corpus is sufficient to hold a client before a
  second one depends on it.
- **R0.3** The corpus SHALL be regenerable by one command and its output SHALL be
  byte-stable for a fixed engine version.

**Done when** the DOM client's corpus test passes and deleting a rule from the engine
breaks it. Commit: `test: conformance corpus for client implementations`.

### Stage 1 — Content as data

- **R1.1** Every user-visible string in `src/client/content/` SHALL move to JSON keyed by a
  stable identifier.
- **R1.2** The DOM client SHALL render from those files with no behavioural change — the
  existing content tests SHALL pass unmodified.
- **R1.3** The corpus SHALL pin the *rendered* output, not the keys, so a wording change in
  one client and not the other fails.

**Done when** `bun run test` is green with zero prose left in `.ts` files.

### Stage 2 — Skeleton and first frame

- **R2.1** A Godot 4.7.1 project SHALL live at `godot/` in this repository. Same repo, because
  the killer risk in a two-client system is wire drift and same-repo CI is how you catch it.
- **R2.2** `art/` SHALL carry a `.gdignore` so Godot's importer does not ingest the 14 MB of
  unshipped portrait variants.
- **R2.3** The client SHALL create a room over `POST /api/rooms` (`HTTPRequest`) and hold a
  seat over `WebSocketPeer`, speaking the existing protocol verbatim.
- **R2.4** Every inbound frame SHALL pass a single parse boundary before anything else
  touches it, mirroring `parseClientMessage`. A hand-written match, not a schema addon.
- **R2.5** Reconnect SHALL use `RESUME_SEAT` with backoff, matching the DOM client's semantics.
- **R2.6** The client SHALL hold **no game state**. The view is the state. Any GDScript that
  caches a derived fact across frames is a bug — this is the invariant that made the DOM
  client tractable and it is worth more than any rendering decision in this document.

**Done when** two Godot instances and one browser can sit at the same table and the server
cannot tell which is which.

### Stage 3 — Lobby and menu

- **R3.1** Menu, join and lobby surfaces SHALL be built from `Control` nodes with real focus
  order, not custom hit-testing.
- **R3.2** Every interactive node SHALL carry an accessible name and description, using the
  same copy the DOM client's `aria-label` and `aria-describedby` carry.
- **R3.3** A card a rule forbids SHALL be disabled *with its reason attached*, not merely
  greyed — the current client's `aria-disabled` + `aria-describedby` pairing, ported.
- **R3.4** The invite link SHALL be copyable via `DisplayServer.clipboard_set`.

### Stage 4 — The table

- **R4.1** Seat topology SHALL come from the ported `topology` decision layer, asserted
  against the corpus.
- **R4.2** Layout SHALL use `Container` nodes. No absolute-rect plan.
- **R4.3** The discard area SHALL be proven to hold **eight** cards, by a test driving corpus
  matches — not by inspection.
- **R4.4** The action sheet SHALL present only decisions the player actually has, deriving
  legality from the view exactly as the DOM client does.
- **R4.5** Informant guesses SHALL name a **value**, and the sheet SHALL spell out which card
  that value catches. Getting this wrong is a rules bug, not a copy bug.

### Stage 5 — Theme, art, motion

- **R5.1** The palette SHALL be a `.theme` resource generated from the same token source the
  CSS uses, so the two clients cannot drift in colour.
- **R5.2** Contrast ratios SHALL be asserted arithmetically, porting `tokens/contrast.ts`.
  This transfers exactly — it is pure math and owes nothing to either renderer.
- **R5.3** The nine beats SHALL port to `Tween` and `AnimationPlayer`, preserving the
  sequencing contract (`await tween.finished` for `await element.animate(...).finished`).
- **R5.4** The Mule beat SHALL warp the live table via a `SubViewport` and a displacement
  shader — the original design intent, recovered.
- **R5.5** Nothing SHALL animate forever. The invariant survives the platform change; only
  its cost changes.

### Stage 6 — *Optional:* offline engine

Do not start this until a target demands it. It exists for mobile, where you cannot spawn the
compiled server as a child process. On desktop, ship `mules-court` alongside the app and
launch it on loopback — parity for free, including bots and MCP seats, and no second rule
implementation to keep honest.

- **R6.1** §7's RNG conformance tests SHALL pass before any rule is ported.
- **R6.2** The GDScript engine SHALL be validated by replaying the entire corpus and
  asserting frame-for-frame identity with the recorded views.
- **R6.3** Any divergence SHALL be resolved in favour of the TypeScript engine. It is the
  authority; the port is a mirror.

### Stage 7 — Ship

- **R7.1** CI SHALL run the Godot tests headless (`--headless --script`) on every push.
- **R7.2** The export matrix SHALL mirror the existing binary release workflow, attaching a
  `SHA256SUMS.txt`.
- **R7.3** The README SHALL state plainly which client is for which target, so nobody
  downloads a 40 MB native app to play in a browser tab.

---

## 9. The agent skills — and one licence problem

### 9.1 The licence problem, first

`GD-Agentic-Skills` is **LGPLv3**. It contains **982 GDScript production scripts**. Every
project you own is **UNLICENSE**, and you have held that line consistently.

The repository's own README is explicit that you may *use* the skills to build games you keep
closed or commercial. That covers the agentic use. It does **not** make the GDScript in
`skills/*/scripts/` public domain. Copy a script into `godot/` and that file is LGPLv3 sitting
inside an UNLICENSE repository, and your licence statement becomes false.

- **R9.1** No file from `GD-Agentic-Skills` SHALL be copied into this repository.
- **R9.2** Skills SHALL be used as **reference and review** — read the pattern, understand the
  API nuance, write your own implementation. This is the DIA loop's *Ingestion* step doing
  exactly what it is for.
- **R9.3** Install via `npx skills add` into the agent's plugin directory, which lives outside
  the repository, rather than cloning into the tree.

This is not pedantry given how much of your work rests on that dedication being true. It is
also cheap: the value of these skills is the knowledge delta, not the boilerplate.

### 9.2 Which skills, when

The repository warns loudly against installing everything — 96 skills is ~15k tokens of
metadata before any work happens, and it calls this a "Context Storm." Its **Power of One**
rule: use `godot-master` *or* micro-skills, not both.

**Stage 2 (scaffolding, architecture):** `godot-master`. This is exactly its stated use case —
new project, architectural decisions, folder structure, anti-patterns.

```
npx skills add thedivergentai/gd-agentic-skills/skills/godot-master
```

**Stages 3-7 (surgical):** drop `godot-master`, add micro-skills per stage:

| Stage | Skills |
| --- | --- |
| 3 | `godot-ui-containers`, `godot-ui-theming`, `godot-input-handling` |
| 4 | `godot-genre-card-game`, `godot-signal-architecture`, `godot-resource-data-patterns` |
| 5 | `godot-tweening`, `godot-shaders-basics`, `godot-audio-systems`, `godot-ui-rich-text` |
| 6 | `godot-testing-patterns` |
| 7 | `godot-export-builds`, `godot-platform-desktop`, `godot-platform-mobile` |

Deliberately **not** installed: `godot-multiplayer-networking` and
`godot-adapt-single-to-multiplayer`. They teach `MultiplayerSynchronizer`, RPCs and client
prediction — Godot's high-level multiplayer stack, which this design does not use and must
not drift toward. You are a WebSocket client to an existing authoritative server. An agent
holding those skills will keep proposing the wrong architecture.

### 9.3 The version lag

The skills target **Godot 4.5+**. Godot 4.7's headline UI feature — Control offset transforms
— postdates them, and it is the single most relevant 4.7 change to a card interface. Expect
`godot-master` to propose pre-4.7 workarounds for animating Controls inside Containers.

- **R9.4** Where a skill and the Godot 4.7 release notes disagree, the release notes win, and
  the divergence SHALL be recorded in this repository's own skill notes.

### 9.4 Your own skills need Godot counterparts

`.agents/skills/` currently holds nine, and they split cleanly:

| Skill | Fate |
| --- | --- |
| `changing-the-wire` | **Survives**, plus one step: regenerate the corpus |
| `running-the-test-gates` | **Survives**, plus the Godot headless suite |
| `adding-to-the-pure-layer` | **Survives** — purity is a discipline, not a platform |
| `designing-an-effect` | **Survives** — it is about the rules |
| `easing-and-choreography` | **Adapts** — `Tween` for WAAPI |
| `laying-out-the-table` | **Rewritten** — Containers, not rects |
| `writing-a-dom-surface` | **Godot twin needed** — `writing-a-godot-surface` |
| `animating-with-waapi` | **Godot twin needed** |
| `svg-filters-and-gradients` | **Godot twin needed** — `.gdshader` |

Write the three twins during Stage 5, not before. Skills written ahead of the code they
describe encode guesses.

---

## 10. Gates

Things that must be answered before the stage they block. Each is a spike of an hour or two,
not a research project.

1. **Does AccessKit work in Godot's web export?** Blocks nothing if you accept §3's split
   (Godot native, DOM browser). Blocks *everything* if the plan is to replace the browser
   client. Spike: export a two-button Godot 4.7.1 project to web, open it under VoiceOver.
   If the answer is no, the DOM client is permanent, and that is fine — say so in the README.
2. **Does GUT (or gdUnit4) support 4.7.1, and does it run headless in CI?** Blocks Stage 2's
   definition of done. Without a headless runner you have no gate, and this project's whole
   character is that it has gates.
3. **Does the Mule shader read as *dread* rather than as *effect*?** The art-direction call
   §13.1 of the renderer research left open. Blocks Stage 5 only, and it is now a question you
   can answer by building it in an afternoon rather than by argument.
4. **Desktop-only or mobile too?** This is the single input that decides whether Stage 6
   happens. Answer it before Stage 2, because it changes nothing about Stages 0-5 and
   everything about how much work is left after them.

---

## 11. Naming

The Godot client is a *view* — it holds no state, renders a redacted picture, and sends one
message back. Three candidates, all neuter second-declension, all working as a directory,
a binary name and a window title:

- **Theatrum** — the place of seeing (< Gk. θέατρον, but fully naturalised in Latin). The
  match happens on the server; the theatrum is where it is watched. Best semantic fit.
- **Speculum** — a mirror (< *speciō*, "I look at"). Captures "the client mirrors the view"
  precisely, and the instrumental sense is right: it is the thing *by means of which* you see.
- **Aula** — the hall, and specifically a prince's court (f., 1st decl.). The most on-theme,
  but it names the whole game rather than one client, and the game already has that name.

`Theatrum` reads best in a path: `godot/`, binary `theatrum`, and the release artifact
`mules-court-theatrum-darwin-arm64`. Yours to override — but *aula* is the one I would avoid,
for the reason above rather than for any grammatical one.

---

## 12. What v0.1.0 means

The Godot client is done, and stops, when:

- Two Godot instances and a browser sit at one table and the server cannot distinguish them.
- The conformance corpus test passes headless in CI.
- Every surface has real focus order and accessible names, and a VoiceOver pass has been run
  on hardware by a person — the same debt `2026-07-24-uix-qa-checklist.md` still carries for
  the DOM client, and worth clearing for both at once.
- The discard area is *proven* to hold eight.
- The export matrix builds and attaches `SHA256SUMS.txt`.
- The README says which client is for which target, in one sentence, near the top.

Not on that list: the GDScript engine, offline solo, controller support, Steam. Each is a
real want and none of them is v0.1.0. The discipline that got this project to 2,151 tests and
a shipping binary is the same one that applies here — finish the thin client against the
existing server, and only then decide whether the rest earns its keep.
