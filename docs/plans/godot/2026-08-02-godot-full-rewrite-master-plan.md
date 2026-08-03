# The Mule's Court — Full Rewrite into GDScript: Master Plan

**Date:** 2026-08-02
**Status:** Plan. §3 records the target; §6 the invariants that must survive the language change; §11 the gates that block each stage.
**Scope:** Rewrite the entire project — engine, AI, transport, and client — from TypeScript into a single Godot 4.7.1 / GDScript project. **Image assets are reused verbatim**; everything else is rebuilt.
**Supersedes (by owner's direction):** `2026-08-01-godot-client-workplan.md`, which recommended a *second client* (Scope A) and rejected the full rewrite (Scope C). This document executes the rewrite the owner has chosen. It does not pretend that document's objections evaporated — §2 reckons with each, and the plan's spine is the machinery that answers them.
**Target:** Godot 4.7.1 (4.7 stable shipped June 2026; 4.7.1 is the maintenance release).

---

## 0. How this suite is organised

A full rewrite spans five subsystems that fail for different reasons, so the plan is nine documents. This one is the spine — decisions, ledger, invariants, staging, gates. Each subsystem has its own implementation plan, written to be executed task-by-task against `superpowers:executing-plans`.

| # | Document | Owns |
| --- | --- | --- |
| 1 | **this file** | The decision, the ledger, the cross-cutting invariants, the stage sequence, the gates |
| 2 | `2026-08-02-gdscript-determinism-and-rng.md` | The mulberry32/FNV-1a port and the stream-equality proof. **The linchpin — nothing downstream is worth writing until this passes** |
| 3 | `2026-08-02-conformance-corpus.md` | The retiring-oracle machinery: recorded matches + per-seat view frames the GDScript engine, AI and client are all held to |
| 4 | `2026-08-02-gdscript-engine-port.md` | The deterministic reducer: state, catalog, effect registry, resolvers, round flow, redaction, replay |
| 5 | `2026-08-02-gdscript-ai-port.md` | The bot *inference* path only (heuristic + PIMC/PUCT search); the trainer stays behind |
| 6 | `2026-08-02-godot-server-and-networking.md` | The authoritative server, the wire protocol, seats, persistence — and the client socket half |
| 7 | `2026-08-02-godot-client-ui.md` | Scenes, state store, the presentation pipeline, the nine beats, the Mule shader, accessibility |
| 8 | `2026-08-02-asset-reuse-and-theme-pipeline.md` | Importing the existing art unchanged; generating the theme from the token source |
| 9 | `2026-08-02-godot-project-structure-and-gates.md` | Project layout, GDScript conventions, the headless test runner, the export matrix, licence discipline |

Read this file, then §2 and §11 decide whether to proceed at all. If yes, the build order is §7.

---

## 1. What "full rewrite" is being asked for, stated precisely

The prior workplan drew three scopes and recommended the smallest. The owner has chosen the largest:

> **C. Full rewrite** — a GDScript engine, a GDScript authoritative server, a Godot client, no TypeScript left in the shipping product.

That is the target this document plans. Two clarifications make it buildable rather than a slogan:

- **"No TypeScript left in the shipping product"** is not "delete `src/` on day one." The TypeScript engine is the only existing proof that the rules are correct, and it becomes the **oracle** the GDScript engine is measured against (§3.2, §6.1). It is retired when the corpus proves parity — not before. During the migration the two coexist, deliberately.
- **"Reuse image assets"** is a hard scope boundary that simplifies one whole subsystem: the 7.3 MB under `public/assets/` is copied into the Godot project unchanged, imported losslessly, and never regenerated. Document 8 is short precisely because of this.

Everything else — 19,418 lines of TypeScript source across engine, AI, server, MCP and client — is rewritten.

---

## 2. Reckoning with the prior verdict

`2026-08-01-godot-client-workplan.md` §4 and §3 argued *against* this rewrite. Those arguments were correct on their facts. Proceeding means answering each with a mechanism, not a dismissal.

| Prior objection | Its force | The answer this plan builds |
| --- | --- | --- |
| "26,346 LOC of tests encode a correctness argument a rewrite discards" | Real. The tests do not port. | The tests pin *behaviour*, and behaviour is portable even when tests aren't. Document 3 records that behaviour as a **conformance corpus** generated from the TS engine, and holds the GDScript engine to it frame-for-frame. The correctness argument is replayed, not rewritten. |
| "The hexagonal seam makes the client cheap and the engine expensive-to-re-prove" | Real. The engine is the crown jewel. | Accepted. This is why the engine port (doc 4) is gated behind the RNG proof (doc 2) and the corpus (doc 3), and why it is sequenced *before* any pixel is drawn. The expensive thing is done first, under the most scrutiny. |
| "`RedactedView` is a standalone type, so leaking hidden state is a compile error" | Real, and lost. GDScript has no such compiler. | Replaced, not abandoned. Document 3's corpus records exactly what each seat may see; a GDScript `view()` that leaks a hand, the deck, the seed or another seat's card **fails a diff**, not a code review. §6.2 makes this an obligation. |
| "Browser + iOS/phone reach is lost with Godot web export" | Real and, for the browser, largely unfixable. | Owned, not hidden. §3.3 makes the product **native-first**; web export is a gated, lower-priority target carrying the SharedArrayBuffer / COOP-COEP / iOS-Safari caveats the research confirmed. §11 gate 1 forces the call before it costs anything. |
| "`axe.test.ts` audits a DOM tree that won't exist" | Real. The automated a11y gate does not transfer. | Weakened but not zero. Godot 4.5+ ships AccessKit (`accessibility_name`/`accessibility_description` on every `Control`); doc 7 ports the existing `aria-label`/`aria-describedby` copy onto it, and doc 9 adds a manual VoiceOver/TalkBack pass to the release gate. This is a genuine regression in *automation*, honestly recorded in §11 gate 2. |

**The reframing that makes the rewrite tractable:** the prior plan treated the TS engine as a thing you either keep or destroy. This plan treats it as a thing you **replay and then retire** — a retiring oracle. That single move converts "re-prove 1,860 lines of rules from scratch" into "make a second implementation agree with a first one that already passes 2,151 tests," which is a bounded, checkable task with a green light you can see.

---

## 3. The target architecture

### 3.1 One project, four layers, no TypeScript in the artifact

```
                    ┌───────────────────────────────────────────┐
                    │   godot/  (one Godot 4.7.1 project)        │
                    │                                            │
                    │   engine/     deterministic reducer  (GD)  │
                    │   ai/         bot inference path     (GD)  │
                    │   server/     rooms, wire, persistence(GD) │
                    │   client/     scenes, store, beats   (GD)  │
                    │   assets/     the existing PNGs (reused)   │
                    └───────────────────────────────────────────┘
                          one export → native app per platform
                          one export → --headless authoritative server
```

The same project builds two things from one codebase, exactly as the current Bun binary does: a **client** app, and a `--headless` **dedicated server** (`OS.has_feature("dedicated_server")` branches startup, per the export research). This is the shape doc 6 details.

### 3.2 The engine stays server-authoritative — the architecture does *not* change, only its language

The single most important design decision, and the one an agent with Godot's multiplayer skills will fight: **do not adopt Godot's high-level `MultiplayerAPI`.** The research is unambiguous — `MultiplayerSynchronizer`/`MultiplayerSpawner`/`@rpc` replicate *a live scene-tree graph* between peers and key authority to a numeric peer id. This project's truth is the opposite and better: the server holds one authoritative `MatchState` mutated only by `reduce()` over an `actionLog`, and each client holds a `RedactedView` — a flat, per-seat-redacted snapshot. Seat authority is a token validated per message, not a node's owner.

Bolting the high-level stack on top would mean two sources of truth and a security model that means the wrong thing. The Godot client stays a `WebSocketPeer` + `HTTPRequest` client speaking the existing JSON protocol verbatim; the Godot server stays a `WebSocketPeer`-accepting authority. **Never construct a `MultiplayerPeer` or set `SceneTree.multiplayer_peer`.** Doc 6 §2 records why, so the reason survives the person who wrote it.

### 3.3 Native-first, web-maybe, offline-always

The prior plan's sharpest finding was that Godot is the right client for native and the wrong one for the browser. A full rewrite cannot keep both halves the way a second client could, so it commits:

- **Native is the product.** macOS, Windows, Linux, Android, iOS — one export matrix. This is the strongest practical reason to do the rewrite at all, and it is the thing the DOM client can never reach.
- **Web is a gated afterthought.** A Godot web export ships a multi-megabyte Wasm runtime, needs COOP/COEP cross-origin-isolation headers for threads, and has a documented history of white-screen failures on iOS/macOS Safari. §11 gate 1 spikes it in an afternoon; if it fails, the README says "native only" in one sentence and nothing else in the plan changes.
- **Offline solo is now free, and it is the prize.** This is the upside the second-client plan could not cleanly buy. Because the engine and AI are now *in-process* GDScript, a phone with no network can host a match against bots by instantiating the server layer locally — no subprocess, no loopback, no second rule implementation. The thing mobile needed is a side effect of the rewrite rather than a Stage-6 special case. Doc 6 §7 covers the in-process server.

### 3.4 MCP seats: out of scope for v1.0, and cheaply so

`src/mcp/` (1,419 LOC) exists so a model can occupy seats over stdio. It is a *client of the wire*, like the browser. Because the wire is preserved byte-for-byte (§6.1), **the existing TypeScript MCP server keeps working against the new GDScript game server unchanged** — it does not need porting to be usable. Reimplementing it in GDScript earns nothing for v1.0 and is explicitly deferred (§10). This is a place where "full rewrite" is honestly narrowed: the *shipping game* is all GDScript; a developer-facing stdio tool that already works is left alone until it doesn't.

---

## 4. The port surface, measured and dispositioned

Line counts are current-tree source (tests excluded). Disposition is under the full rewrite, not the second-client plan.

| Layer | LOC | Disposition |
| --- | --- | --- |
| `src/game/engine/` | 1,860 | **Rewritten in GDScript** (doc 4), gated behind the RNG proof (doc 2) and held to the corpus (doc 3). Retired when parity is proven. |
| `src/game/ai/` | 1,636 | **Inference path rewritten** (doc 5): `policy`, `heuristic`, `census`, `determinize`, `search`, `difficulty`, `rng`. The trainer (`arena`, `cem`, `selfPlay`) **stays in TypeScript** as offline tooling — it never ships. `weights.generated.ts` becomes a 13-float data resource. |
| `src/server/` | 3,331 | **Rewritten in GDScript** (doc 6): protocol, room state machine, seat tokens, dispatch, persistence, rate limiting, config. The single largest risk in the whole plan (§9). |
| `src/mcp/` | 1,419 | **Not ported for v1.0** (§3.4). Keeps working in TS against the new server. |
| `src/client/content/` | 993 | **Rewritten as GDScript pure functions**, held to the corpus so the two eras narrate identically during migration (doc 7 §4). |
| `src/client/tokens/` | 102 | **Becomes a generated `.theme` + a ported contrast check.** The WCAG arithmetic transfers exactly (doc 8 §3). |
| `src/client/store/` | 2,263 | **Ported selectively** (doc 7 §2): socket, diff, presentation queue, targets, motion-policy, the one-message-one-state reducer. `ids.ts` and `clipboard.ts` **evaporate** — Godot has `Crypto` and `DisplayServer.clipboard_set` with no secure-context caveat. |
| `src/client/layout/` | 1,409 | **Decisions kept, pixels discarded** (doc 7 §5). `topology.ts` ports as a rule both eras must agree on; the hand-rolled `Rect` geometry is replaced by `Container` nodes. The capacity fact (§6.4) moves into the corpus. |
| `src/client/ui/` | 5,169 | **Rebuilt as ~21 Godot scenes** (doc 7 §3). Mount/update/destroy → `_ready`/`update(state)`/`queue_free`. |
| `src/client/styles/` | 1,753 | **Rebuilt** as the `.theme` resource plus `.gdshader` files (docs 7–8). |

**The number that should reassure and the one that should worry.** The reassuring one: the AI's trained artifact is 13 floats, not a tensor — the terrifying-looking line is a copy-paste. The worrying one: `src/server/` at 3,331 LOC is the biggest single rewrite and the one with the least behavioural corpus to lean on, because much of it is transport plumbing (reconnection, rate limits, reaper sweeps) rather than pure functions. §9 treats it as the critical path.

---

## 5. What the corpus is, and why it is the first artifact built (doc 3)

This is the same move the repository's own contract tests make: **one set of behavioural facts, generated once, enforced against every implementation.** It is what lets a GDScript engine be *tested* rather than *clicked at*.

- **Generated, never hand-written** (from the retiring TS engine), so it cannot drift from the rules.
- **Records `{seed, actionLog}` plus the full sequence of per-seat `RedactedView` frames**, as canonical JSON — the exact bytes each seat received.
- **Covers, at minimum:** a 2-player match reaching sudden death; a 4-player match; a round ending on deck-out with a discard-total tiebreak; a 2-player shared-win round; a forced First-Speaker discard; a match that reaches the **eight-deep** discard pile; and a protected-target rejection.
- **Every rewritten layer replays it offline and asserts its own derived output** — the GDScript engine asserts frame-for-frame identity; the AI asserts identical decisions from identical `(view, rng)`; the client asserts topology, narration, legality display and the eight-card capacity.

Without the corpus the rewrite has no gate, and this project's entire character is that it has gates. Build it in Stage 0, from the engine that already passes 2,151 tests, before a single line of GDScript rule exists.

---

## 6. The invariants that must survive the language change

These are the load-bearing facts the rewrite can most easily break silently. Each is expanded in a subsystem doc; they are collected here because a violation of any one presents as a bug that looks like something else.

### 6.1 The wire is frozen (doc 6)

The GDScript client and server SHALL speak the exact `ClientMessage`/`ServerMessage` union in `src/server/protocol.ts`, including its strictness: **exact-key validation** (an extra field fails the whole message as `MALFORMED`), `target` constrained to `/^p[1-4]$/`, `guess` an integer 2–8, `cardInstanceId` matching `/^[a-z]+(-[a-z]+)*#\d+$/`, and optional fields **omitted entirely** rather than sent as `null`. The frozen wire is what keeps the TS MCP server (§3.4) working and what the corpus records. A change to the protocol is retroactive across every stored match and regenerates the corpus.

### 6.2 Redaction is a diff obligation, not a type (docs 3, 4)

`RedactedView` in GDScript is a plain `Dictionary` with no compiler to forbid a leak. The corpus is the compiler substitute: a `view()` that exposes `deckOrder`, `setAsideFaceDown`, `rng`, `seed`, `actionLog`, raw `privateKnowledge`, or another seat's `hand` produces a frame that does not match the recorded one. Port the transport's `FORBIDDEN_SUBSTRINGS` guard too — a blunt substring ban on outbound frames catches a raw `MatchState` serialisation that a field-by-field review would miss.

### 6.3 Determinism is 32-bit, in a 64-bit language (doc 2)

`src/game/engine/rng.ts` is mulberry32 seeded by FNV-1a, and its correctness rests on JavaScript's `Math.imul` (true 32×32→32 multiply) and `>>> 0` (coerce-to-uint32). GDScript's `int` is 64-bit signed with neither. Every intermediate must be masked to 32 bits, the multiply must be a half-width `mul32_safe` (because `0xFFFFFFFF²` overflows int64), the seed string must be folded by the same code units, and the match's RNG must **thread continuously across rounds, never re-seeded**. This is the linchpin: doc 2's stream-equality and shuffle-equality tests are the *first* code written, before any rule. If they fail, nothing downstream matters.

### 6.4 The discard reserve is eight (docs 3, 7)

`discardCapacity.test.ts` drives thousands of real matches to prove the deepest single-seat discard pile that can occur is **eight, not the seven the design states** (a 2-player round: 5 own-turn discards + 2 Prince-forced Bayta/Toran discards + 1 elimination reveal). A Godot `VBoxContainer` will not discover this; it will simply overflow on the one match in a thousand that reaches eight. This is a *derived fact about the game* and belongs in the corpus, asserted by the client, not rediscovered by a layout node.

### 6.5 Nothing animates forever, and beats own a transient layer (doc 7)

Both survive the platform change. Godot's `Tween.finished` **never fires for an infinitely-looping tween** — the identical trap the WAAPI rule guards against — so `iterations: Infinity` has a GDScript twin that must be refused. And a beat must never animate a live table node: the table redraws on every state update, and a tween whose target is freed mid-flight hangs with no error. Beats draw into their own transient layer, exactly as `beats.ts` does today.

### 6.6 The client holds no game state (doc 7)

The view is the state. Any GDScript that caches a derived game fact across frames is a bug. This is the invariant that made the DOM client tractable, and it is worth more than any rendering decision in the suite. It ports as a discipline, not as code.

---

## 7. Stage sequence

Sequenced so the work that gates everything else, and the work that is identical regardless of later forks, happens first — the method the renderer research used in its §12.

| Stage | Work | Doc | Blocked by |
| --- | --- | --- | --- |
| **0** | Generate and commit the conformance corpus from the TS engine | 3 | — |
| **1** | Port the RNG; prove stream + shuffle equality against the corpus | 2 | 0 |
| **2** | Project skeleton, `.gdignore`, asset import, headless test runner in CI | 8, 9 | — (parallel with 0–1) |
| **3** | Port the engine; replay the whole corpus frame-for-frame | 4 | 1, 3-corpus |
| **4** | Port the server + wire; two GDScript clients + one TS MCP seat at one table | 6 | 3 |
| **5** | Port the client store + scenes; play a match end-to-end, unstyled | 7 | 4 |
| **6** | Port the AI inference path; hold to the AI-decision corpus | 5 | 3 |
| **7** | Theme, art wiring, the nine beats, the Mule `SubViewport` shader | 7, 8 | 5 |
| **8** | Offline solo (in-process server), export matrix, signing, `SHA256SUMS.txt` | 6, 9 | 4, 7 |

Stage 2 runs alongside 0–1 because it shares no code with them. Stage 6 (AI) depends only on the engine (Stage 3), not on the client, so it can run parallel to 4–5 once the engine is green. The critical path is **0 → 1 → 3 → 4 → 5 → 7 → 8**; the server (4) is the longest single link (§9).

Each stage's implementation doc opens with `superpowers:executing-plans` and breaks into bite-sized TDD tasks. A stage is done when its corpus assertions pass headless in CI — not when it looks right.

---

## 8. What each stage's "done" means

- **Stage 0** — the corpus exists, is regenerable by one command, is byte-stable for a fixed engine version, and deleting a rule from the TS engine breaks a corpus assertion. Commit: `test: conformance corpus for the GDScript rewrite`.
- **Stage 1** — `seed_rng(s)` then *n* draws produces the identical stream to the TS engine for a generated sample of seeds and *n*; `shuffle(deck, seed_rng(s))` produces the identical ordering over a wide sample. Not a handful of examples — a generated sample. **If this is not green, stop.**
- **Stage 3** — replaying every corpus match through the GDScript engine reproduces every recorded per-seat `RedactedView` frame exactly, and no frame contains a forbidden substring.
- **Stage 4** — two Godot instances and one TS MCP seat sit at the same table and the server cannot tell which client is which; a mid-match server restart recovers by replay.
- **Stage 5** — a human plays a full match to a devotion-token win, unstyled, with real focus order and accessible names on every control.
- **Stage 6** — the GDScript AI returns the identical decision to the TS AI for every `(view, rng)` in the AI-decision corpus, per tier.
- **Stage 7** — the nine beats read as designed, the Mule beat warps the live table, and a human confirms the dread reads (gate 3).
- **Stage 8** — offline solo plays a full match with no network; the export matrix builds every target and attaches `SHA256SUMS.txt`.

---

## 9. The server is the critical path — read before Stage 4

`src/server/` is the one rewrite with the least behavioural corpus to lean on. The corpus proves the *engine*; it says nothing about reconnection ordering, the reaper's TTL sweeps, token-bucket refill, the host-race window, or eviction-on-resume. Those are transport facts the TS suite pins with `bun test` and the GDScript port must re-pin by hand.

Three things make it the risk it is, all detailed in doc 6:

- **Reconnection is ordered.** `RESUME_SEAT` re-arms the reveal timer *before* sending the resuming seat its state, unpauses only after that seat sees the position, and resumes bots last. Get the order wrong and a reconnect shows a stale countdown or lets a bot move into a screen the human hasn't seen.
- **Persistence is replay, and replay is determinism.** Rooms store `{seed, actionLog}` and rebuild by replaying through `reduce()` — so the server rewrite inherits doc 2's determinism obligation transitively. A GDScript engine that shuffles differently makes every persisted match unrecoverable, and the failure surfaces three weeks later as "reconnect shows the wrong hand."
- **The strict parser is the security boundary.** `parseClientMessage` never throws and rejects any unexpected key. A lenient GDScript `JSON.parse_string` that shrugs at extra fields quietly widens the attack surface the strictness was closing.

Budget Stage 4 as the longest stage and do not start it until Stage 3 is corpus-green, because every server bug that isn't a transport bug is really an engine bug wearing a socket.

---

## 10. Deliberately not in v1.0

The discipline that got this project to 2,151 tests and a shipping binary is finishing the thin thing against a proven contract and only then deciding whether the rest earns its keep. For v1.0:

- **The GDScript MCP server** — the TS one keeps working against the new wire (§3.4).
- **Controller support** — `InputMap` device bindings are a bounded later addition; the focus system built in Stage 5 is the prerequisite, and it ships in v1.0 for keyboard/accessibility reasons anyway.
- **Steam / store distribution** — the export matrix (Stage 8) produces the binaries; a storefront is a separate project.
- **Retraining the AI in-engine** — the CEM trainer stays in TypeScript. If the weights are ever retrained, it is offline tooling producing 13 new floats, not a GDScript rewrite (doc 5 §5).

Each is a real want. None is v1.0.

---

## 11. Gates

Each is a spike of an hour or two, answered before the stage it blocks — not a research project.

1. **Does Godot's web export expose an accessibility tree, and does the app boot on iOS/macOS Safari?** The research could not confirm AccessKit on web, and confirmed the SharedArrayBuffer/COOP-COEP history on Safari. **Blocks nothing if you accept native-first (§3.3); blocks the web target entirely if it fails.** Spike: export a two-button project to web, open it under VoiceOver in Safari. If it fails, the README says "native only" and the plan is unaffected.
2. **Is the accessibility regression acceptable?** The DOM client's `axe.test.ts` covered every surface automatically. The Godot client replaces that with AccessKit names/descriptions (unenforced by an automated tree in jsdom's sense) plus a manual VoiceOver/TalkBack pass. Confirm the owner accepts trading an automated gate for a manual one before Stage 5 commits the surfaces.
3. **Does the Mule `SubViewport` displacement read as *dread* rather than as *effect*?** The art-direction call the renderer research left open, now answerable by building it. Blocks Stage 7 only.
4. **GUT or gdUnit4 — which, and does it run headless in CI on 4.7.1?** Both support 4.7.x per the research (GUT `godot_4_7` branch; gdUnit4 lists 4.7/4.7.1). Pick one, prove `godot --headless -s …` goes red on failure with a nonzero exit code, before Stage 2's definition of done. Without a headless runner there is no gate, and the gate is the point. Doc 9 §3 carries the decision.
5. **Full GDScript server, or keep the Bun server?** The honest full rewrite re-implements the authoritative server in GDScript (§4, doc 6). The pragmatic alternative — keep the proven Bun server, rewrite only client + engine-for-offline — is a smaller, safer project that leaves TypeScript in the deployment. The owner should make this call explicitly before Stage 4, because it is the difference between "one language" and "one language in the app, another on the host." This plan's default is the full GDScript server; doc 6 §1 records the alternative so choosing it costs a decision, not a rewrite of the plan.

---

## 12. The licence discipline (carried forward, still binding)

`GD-Agentic-Skills` is **LGPLv3** and contains hundreds of GDScript production scripts. Every project here is **UNLICENSE**. Using the skills as *reference* to build your own implementation is fine and is what the DIA loop's Ingestion step is for; **copying any file from them into `godot/` makes that file LGPLv3 inside an UNLICENSE repository and the licence statement false.** Install skills into the agent's plugin directory (outside the tree), read the pattern, write your own code. Doc 9 §5 carries the specifics, including which micro-skills per stage and which two multiplayer skills to deliberately *not* install (they teach the architecture §3.2 forbids).

---

## 13. Naming

The prior workplan proposed *Theatrum*/*Speculum* for the Godot **client**, and rejected *Aula* ("the hall, a prince's court") because it named the whole game rather than one view. The full rewrite **inverts that logic**: the Godot project is no longer a view — it *is* the whole game. So the whole-game name is now the correct one, and the game already has it.

Keep the directory `godot/`, the client binary `mules-court` (continuity with the retiring Bun binary), and the dedicated-server build `mules-court-server`. Release artifacts follow the existing scheme: `mules-court-darwin-arm64`, `…-windows-x64`, and so on, each with its line in `SHA256SUMS.txt`. No new name is needed; the rewrite is the same court, rebuilt.

---

## 14. What v1.0 means

The rewrite is done, and stops, when:

- The GDScript engine replays the entire conformance corpus frame-for-frame, headless in CI, and no frame leaks a hidden field.
- The RNG produces byte-identical streams and shuffles to the retiring TS engine over a generated sample.
- Two Godot instances and one TS MCP seat sit at one table and the server cannot distinguish them; a mid-match restart recovers by replay.
- A match is playable to a devotion-token win, with the nine beats and the live-table Mule warp.
- Offline solo plays a full match against bots with no network.
- Every surface has real focus order and accessible names, and a VoiceOver pass has been run on hardware by a person.
- The discard area is *proven* to hold eight.
- The export matrix builds every native target and attaches `SHA256SUMS.txt`, and the README says which build is for which target in one sentence near the top.

Not on that list: the GDScript MCP server, controller support, Steam, in-engine retraining. Finish the whole game against the corpus the old engine leaves behind, and only then decide whether the rest earns its keep.
