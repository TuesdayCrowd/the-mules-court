# The Conformance Corpus — Stage 0 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: use `superpowers:executing-plans` to implement this plan task-by-task.
> This is **Stage 0** of `2026-08-02-godot-full-rewrite-master-plan.md` — the single most important new artifact in the whole rewrite, and the first thing built. Nothing downstream (doc 2's RNG proof, doc 4's engine port, doc 5's AI port, doc 7's client) has anything to replay against until this exists.

**Goal:** Generate, from the retiring TypeScript engine, a committed, byte-stable corpus of recorded matches — `{seed, actionLog}` plus the exact sequence of per-seat `RedactedView` frames each seat actually received — and prove it is *sufficient*: a rule deleted from the TS engine must break a corpus assertion before a second implementation is allowed to depend on it.

**Architecture:** One TypeScript generator script (`scripts/gen-corpus.ts`, run under Bun, importing the real engine — never restating it) emits canonical JSON files under `godot/test/corpus/`. Every rewritten layer (engine, AI, client) loads those files read-only and asserts against them. The corpus is *data*, not code; it has no opinions about GDScript.

---

## Background — why this is Stage 0 and not a nice-to-have

Master plan §2 records the prior workplan's sharpest objection: *"26,346 LOC of tests encode a correctness argument a rewrite discards."* That argument does not survive a language change — a Vitest `expect()` has no GDScript equivalent, and porting 2,151 assertions by hand would just be writing the bugs twice. What survives is **behaviour**: for a given seed and a given sequence of plays, the engine produces an exact, checkable set of facts. This document is where "behaviour" becomes a file you can diff.

It also replaces something GDScript cannot give back. `RedactedView` is declared standalone in `types.ts:6-13` specifically so a field leaking a hand, the deck order, or the seed is a **compile error** — TypeScript's structural typing makes "this object literal has an extra key" fail to typecheck. GDScript's `Dictionary` has no such thing; a `view()` function that accidentally includes `deckOrder` compiles, runs, and ships. Master plan §6.2 states the replacement plainly: **redaction becomes a diff obligation.** The corpus is the mechanism that obligation runs on — a GDScript `view()` that leaks anything produces a frame that does not match the one recorded here, and *that* is what a CI job can fail on. This document is where §6.2 stops being a sentence and becomes a file.

---

## R1 — What the corpus records, and why the frames are the point

**R1.1** For each recorded match, the corpus SHALL store three things together, keyed by a match id:
- the **seed** (the 128-bit hex string `seedRng` folds — `mintSeed()`'s shape, per `seatTokens.ts:16-33`, though the generator does not need real CSPRNG entropy, see R3.4);
- the **actionLog** (`readonly PlayCardAction[]`, exactly what `replayMatch` at `persistence.ts:230-249` replays — `PLAY_CARD` entries only, round boundaries never logged because `startNextRound` is deterministic from state alone);
- the **full ordered sequence of per-seat `RedactedView` frames** — every frame every seat received over the course of the match, in wall order.

**R1.2** The per-seat frames are not optional set-dressing on top of `{seed, actionLog}` — they are the artifact's reason to exist. `{seed, actionLog}` alone regenerates the *authoritative* `MatchState`, but the authoritative state was never the thing at risk. The thing at risk is `view()` — the function with no compiler behind it in the new language. Recording only `{seed, actionLog}` would let a GDScript engine replay a match, produce a structurally-plausible `MatchState`, and then leak `deckOrder` straight into a `STATE_UPDATE` with nothing catching it, because nothing in `{seed, actionLog}` says what a seat is *allowed to see*. Recording every frame turns "does `view()` redact correctly" from a code-review question into `assert_eq(actual_frame, recorded_frame)`.

**R1.3** A frame SHALL be captured **once per seat per `reduce()`/`startNextRound()` call that changes `MatchState`** — i.e. exactly the cadence at which the real `Room.commitMatchState` (room.ts:1107-1126) calls `broadcastViews`. This is deliberate: the corpus is a record of *what a seat's socket actually received*, not an arbitrary re-sampling. A GDScript client replaying the corpus and reconstructing the identical `STATE_UPDATE` sequence is the client-side half of R1.2 — see R4.3.

**R1.4** Each stored frame SHALL carry:
```json
{ "afterActionIndex": 4, "viewerId": "p2", "view": { ...RedactedView... } }
```
`afterActionIndex` is the index into `actionLog` after which this frame was produced (`-1` for the frame each seat receives at match creation, before any action). This lets a consumer replay `actionLog[0..afterActionIndex]` through its own engine, call its own `view()`, and diff against `view`.

**R1.5** Every field `view()` produces at `view.ts:33-104` SHALL be present verbatim, including the fields whose entire purpose is to prove nothing leaked: `deckCount` (an integer, never a padded array — "a padded array would leak deck positions", view.ts:60-61), `setAsideFaceUp` (a `CardTypeId` or `null`, never the instance id), `removedFaceDownCount` (a count, deliberately **not** named with the `setAsideFaceDown` substring — see R2.2). The corpus format does not summarize or trim `RedactedView`; it stores exactly what `broadcastViews` would have put on the wire.

---

## R2 — Generated, never hand-written; byte-stable for a fixed engine version

**R2.1** The corpus SHALL be produced exclusively by `scripts/gen-corpus.ts`, which SHALL import `reduce`, `view`, `broadcastViews`, `createMatch`, `startNextRound` (and `computeLegalPlays`/`computeLegalTargets` where a scenario needs to steer play) from `src/game/engine` — the public barrel at `src/game/engine/index.ts:22-25` — never reimplement any rule, never hand-author a frame. A corpus file with even one hand-edited byte is worse than no corpus: it asserts a fact nobody checked.

**R2.2** The generator SHALL port the transport's `FORBIDDEN_SUBSTRINGS` list — **copy the exact array from its definition in `src/server/__tests__/` at generation time rather than trusting the transcription below**, which is indicative of its shape but was reconstructed, not verified line-for-line:
```ts
// indicative — read the authoritative list from the transport test source
const FORBIDDEN_SUBSTRINGS = [
    'deckOrder', 'setAsideFaceDown', '"rng"', '"seed"',
    'actionLog', 'privateKnowledge', 'tokenHash'
];
```
Run it against every serialized frame before it is written. If any recorded frame's JSON text contains one of these, the generator SHALL fail loudly rather than write the file. This is a second, independent line of defense on top of `RedactedView`'s own type shape — belt-and-braces because the corpus is the compiler substitute (§6.2) and a compiler substitute that could itself be silently wrong is not one.

**R2.3** Output SHALL be **canonical JSON**: object keys sorted lexicographically at every nesting level, arrays left in encounter order (order is semantic — `discardPile`, `publicLog`, `roundHistory`), no trailing whitespace variance, `JSON.stringify(value, null, 2)` applied to a value already built with sorted keys (a plain `JSON.stringify` replacer cannot reorder — sort before stringifying, e.g. via a recursive `sortKeys()` pass). This is what makes `git diff` on a regenerated corpus meaningful: an unrelated formatting change must never show up as a diff, and a real behavioural change must always show up as one.

**R2.4** Regenerating the corpus from an **unchanged** engine SHALL produce byte-identical files. This is testable directly: run the generator twice, diff the output directories, expect empty. CI enforces R2.4 the same way `embeddedAssets.generated.ts` enforces its own committed-but-generated discipline (AGENTS.md, "Build config" / compiled-binary section) — generate into a scratch directory and diff against the committed one.

**R2.5** The corpus SHALL be **committed to the repository**, under `godot/test/corpus/` (R5 gives the exact layout) — not regenerated at CI time by default. A GDScript test suite that regenerates its own oracle on every run is not testing against anything; it is testing against whatever the TS engine currently does, silently, which defeats the entire "retiring oracle" premise of master plan §2. Regeneration is a deliberate, logged act (R6), not an ambient CI step.

---

## R3 — The mandatory coverage set (master §5)

The master plan's §5 names seven scenarios as the floor. Each below is stated as a concrete generator task with the exact engine calls that produce it, so a scenario is buildable directly from this section without re-deriving the rule.

**R3.1 — 2-player match reaching sudden death.** Play two seats to a tie at `tokensToWin` (`SETUP_TABLE['2'].tokensToWin = 7`, setup.ts). This requires **more than one player crossing the token threshold in the same round settlement** — per `concludeRound` (reduce.ts:75-116), only a *simultaneous* multi-winner round-end (the deck-out shared-win case, R3.4) can produce that in a 2-player match, since a `last-survivor` round-end has exactly one winner. Drive rounds via `reduce`/`startNextRound` until `match.mode === 'sudden-death'` (reduce.ts:98, 112) is observed, then continue driving until `matchWinnerId` resolves the sudden-death round outright (a single winner in `sudden-death` mode ends the match regardless of token totals — reduce.ts:98-101). Assert the recorded corpus captures **both** the transition frame (`mode` flips to `'sudden-death'`, `suddenDeathPlayers` populated) and the final frame (`matchWinnerId` set).

**R3.2 — 4-player match, start to finish.** `SETUP_TABLE['4'] = {faceUp: 0, faceDown: 0, tokensToWin: 4}` — no face-up burn, no face-down set-aside, so this scenario also exercises the empty-hand Prince fallback (`RoundPlayerState.hand` documented as "0, 1, or 2 cards. Zero only via the 4-player empty-deck Prince fallback", types.ts:187-198) if the driven match reaches it; if the chosen seed/play sequence does not naturally reach it, R3.7 covers the forced-discard shape separately, so this scenario does not need to force it.

**R3.3 — Round ending on deck-out with a discard-total tiebreak.** Drive a round until `deckOrder.length === 0` and every remaining draw is skipped (`advanceTurn`, roundFlow.ts:15-32 — draws nothing when the deck is empty). `checkRoundEnd` (roundFlow.ts:50-74) then reveals all survivors' hands, ranks by hand value (`EMPTY_HAND_RANK = -1`), and breaks the best-rank subset further by `discardValueTotal`. The generator SHALL choose a seed/play sequence where the best-rank subset has **more than one member before the discard-total break**, so the recorded `roundResult.winnerIds` is a single id decided by `discardValueTotal`, not by hand value alone — otherwise the scenario is indistinguishable from an ordinary deck-out and proves nothing about the tiebreak specifically. Assert `roundResult.revealedHands` is present and every survivor's hand is in it (deck-out is the one round-end path that reveals hidden hands to every viewer).

**R3.4 — 2-player shared-win round.** A deck-out (R3.3's mechanism) where the tie survives **both** the hand-value rank **and** the `discardValueTotal` break, so `winnerIds` has two entries and both players receive a token in the same `concludeRound` call (reduce.ts:75-116 loops "for every id in `outcome.winnerIds`"). This is also the mechanism that feeds R3.1 (simultaneous sudden-death entry needs a shared crossing of the token threshold), so the generator MAY reuse this scenario's tail as the setup for R3.1 rather than deriving it twice — but both SHALL still be recorded as independently named corpus entries with their own assertions, since a consumer replaying only `sudden-death-2p.json` should not have to know it depends on `shared-win-2p.json`'s internal mechanics.

**R3.5 — Forced First-Speaker discard.** The First Speaker (`effectType: COUNTESS`, `forcedPlayTriggers: ['KING', 'PRINCE']`, effectRegistry.ts) must be played if the actor's hand also holds a `KING`- or `PRINCE`-effect card (Mayor Indbur, Bayta Darell, or Toran Darell). `computeLegalPlays` (legality.ts:26-38) restricts the hand to `[firstSpeakerInstanceId]` alone in that case. The generator SHALL construct a turn where the actor is dealt (or drawn into) exactly that pairing, call `computeLegalPlays` to confirm the constraint actually bites (legal-play set has size 1 and it's the First Speaker), then play it. Assert the recorded frame's `own.legalPlays` for that seat, at that turn, is `[firstSpeakerInstanceId]` and nothing else — this is the client-facing proof (doc 7 asserts the *client* renders only that card as playable).

**R3.6 — A match reaching the eight-deep discard pile.** Master §6.4 and `discardCapacity.test.ts` (`src/client/layout/discardCapacity.test.ts`) establish `MAX_DISCARDS = 8` (`tableLayout.ts:119`) as the true worst case — not the seven the design doc states. The decomposition, confirmed by the test's own docstring and the sweep mechanics: **5 own-turn discards + 2 Prince-forced discards (a Bayta Darell/Toran Darell PRINCE effect targeting that seat) + 1 elimination reveal**, all landing on one seat in a single 2-player round. `discardCapacity.test.ts` finds this by sweeping the *choice index* passed to `autoAction` across thousands of seeded matches (`autoAction(match, choice)`, sweeping `choice % legal.length` and `choice % targets.length` rather than always taking the first legal play, discardCapacity.test.ts:17-42) rather than hand-scripting one path. The generator SHALL do the same: reuse (import, not reimplement) the sweep's search strategy — vary `choice` across a wide range for a fixed seed/player-count until `worstPileInMatch` (discardCapacity.test.ts's own helper) reports `8` for some seat, then re-run *that exact* `(seed, choice)` pair once more, capturing every frame this time, and record it as the corpus entry. Assert the recorded match has some seat's `discardPile.length === 8` at some frame, and no seat ever exceeds `8` at any frame (both halves of the test this scenario exists to make redundant across languages — see R6.4 for why the tight bound must survive as a client assertion, not just an engine one).

**R3.7 — A protected-target rejection.** Shielded Mind (`HANDMAID`) sets `protected = true` on the actor (`resolveHandmaid`, handmaid.ts); `computeLegalTargets` (legality.ts:52-67) excludes a protected opponent from the legal-target set entirely — a client following `own.legalTargets` never *offers* the protected seat, so producing a genuine `TARGET_NOT_LEGAL` rejection requires calling `reduce` directly with an action whose `target` is a protected seat, bypassing the legality hint the same way a malicious or buggy client would. The generator SHALL: play Shielded Mind on seat A; on the next live turn, construct a `PlayCardAction` from a different seat naming A as `target` for a card that requires one; call `reduce` directly (not through `dispatch`/`Room` — this is an engine-level corpus, not a transport one); assert `result.ok === false` and `result.error.code === 'TARGET_NOT_LEGAL'` with `reason: 'PROTECTED'` (`validateAction`, validation.ts:16-84, the `TARGET_NOT_LEGAL` reasons enum). This action is **not** appended to the recorded `actionLog` (a rejected action never mutates state and `reduce` never returns a new `MatchState` for it) — instead the corpus entry for this scenario stores the **attempted action** and its **rejection** as a sibling fact next to the ordinary `{seed, actionLog, frames}` shape, specifically so every rewritten `validateAction`/`reduce` port is held to reproducing the *rejection*, not just the accepted path. See R5.3 for the file shape this needs.

**R3.8 (informative, not master-mandated but nearly free).** Because R3.6's sweep already explores thousands of matches with varied player counts, the generator MAY additionally sample a 3-player match arbitrarily from that sweep and record it as an eighth corpus entry, purely to give doc 4's engine port a topology the other seven don't otherwise cover (2p and 4p are both explicit; 3p is the `SETUP_TABLE` row nothing else exercises). Optional — cut if it slows Stage 0 down.

---

## R4 — How each rewritten layer replays the corpus, and what it asserts

**R4.1 — GDScript engine (doc 4).** For every corpus entry, replay `actionLog` through the GDScript port's own `create_match`/`reduce`/`start_next_round`, calling `view()` after each step exactly at the recorded `afterActionIndex` boundaries, and assert:
- **frame-for-frame identity** — the GDScript `view()` output, serialized through the same canonical-JSON sort as R2.3, equals the recorded frame byte-for-byte;
- **no forbidden substring** — apply R2.2's `FORBIDDEN_SUBSTRINGS` list to every frame the GDScript engine itself produces during replay, not just to the recorded reference. A GDScript engine could theoretically produce a frame that happens to equal the TS reference in its typed fields while *also* stuffing an extra untyped key into the `Dictionary` that the recorded-frame comparison never inspects if the comparison is a partial-key check rather than an exact one — R4.1's identity check MUST be a full-key equality (missing keys and extra keys both fail), and the substring guard is the second, independent net under that.
- For R3.7's protected-target entry: constructing the identical rejected action and asserting the GDScript `reduce`'s error code/reason matches, with **no state mutation** (re-running `view()` for every seat immediately after the rejected call must still equal the pre-rejection frame).

**R4.2 — GDScript AI (doc 5).** The AI corpus is a distinct, smaller need — doc 5 owns generating `(view, rng-seed) → decision` vectors from the TS AI's actual policy functions, using the same `scripts/gen-corpus.ts` machinery (R2's canonical-JSON and byte-stability rules apply identically) but is out of scope for this document's mandatory scenarios; R3's seven/eight scenarios are chosen to stress the *engine and redaction*, not AI decision quality. Doc 5 SHALL reuse this document's generator conventions (file layout under `godot/test/corpus/ai/`, canonical JSON, `gen:` script naming) rather than inventing a second one. The assertion doc 5 runs: for every `(view, rng)` pair in its own vectors, the GDScript AI's chosen `PlayCardAction` (or equivalent decision) equals the TS AI's recorded choice exactly.

**R4.3 — GDScript client (doc 7).** For every corpus entry, feed the recorded frame sequence into the client's pure layers (topology, content/narration, layout) exactly as they would arrive over the wire, and assert:
- **topology** — `computeLayout`'s ported equivalent selects the correct topology class for `playerCount`/seat arrangement, matching what the TS `layout/topology.ts` would choose for the same `RedactedView.players` shape;
- **narration** — every `publicLog` entry in every frame renders through the ported `content/` narration functions without a missing-case fallback, and (where the TS corpus generator additionally records the TS client's own narration string per entry, an easy add at generation time) the GDScript narration string matches verbatim;
- **legality display** — for the viewer's own turn frames, `own.legalPlays`/`own.legalTargets` drive the same playable/targetable UI state the TS client's `store/` would derive, spot-checked directly against R3.5's forced-First-Speaker entry (exactly one playable card) and R3.7's protected-target entry (the protected seat never appears as a selectable target, proving the client-side omission independently of the engine-side rejection R4.1 checks);
- **capacity = 8** — replaying R3.6's entry, the client's discard-area layout reserves room for `MAX_DISCARDS = 8` pips on the seat that reaches it, and never truncates, silently overflows, or reflows unexpectedly at exactly 8. This is the corpus's carrying-forward of `discardCapacity.test.ts`'s finding into the new language, per master §6.4 — "a Godot `VBoxContainer` will not discover this; it will simply overflow on the one match in a thousand that reaches eight."

---

## R5 — The `res://test/corpus/` layout and the generator script

**R5.1 — Directory layout**, mirrored under both the repo-relative `godot/test/corpus/` (the committed source of truth) and loaded by GUT/gdUnit4 (doc 9 §3 picks the runner — master plan gate 4 leaves the choice open pending a headless-CI spike) via Godot's `res://test/corpus/` resource path once the `godot/` project root is established (Stage 2). **`res://` addressing a plain committed file under the project root is ordinary Godot project layout** [verified — consistent with doc 2's own `res://test/vectors/rng_stream.json` convention, Task 3]; *which* test runner API loads and parses it (`FileAccess.open` + `JSON.parse_string`, or a GUT/gdUnit4 fixture helper) is **[uncertain/post-cutoff]** and is doc 9's call, not this document's — this document only fixes the path and the JSON shape, both runner-agnostic:

```
godot/test/corpus/
├── manifest.json                  # engine version stamp + list of entry ids (R6.2)
├── engine/
│   ├── sudden-death-2p.json           # R3.1
│   ├── match-4p.json                  # R3.2
│   ├── deck-out-tiebreak-2p.json      # R3.3
│   ├── shared-win-2p.json             # R3.4
│   ├── forced-first-speaker.json      # R3.5
│   ├── discard-capacity-8.json        # R3.6
│   ├── protected-target-rejection.json# R3.7
│   └── match-3p.json                  # R3.8 (optional)
└── ai/
    └── ...                             # doc 5's decision vectors, same conventions
```

**R5.2 — Per-entry shape** (`engine/*.json`, the ordinary case — R3.1 through R3.4, R3.6, R3.8):
```json
{
  "id": "discard-capacity-8",
  "seed": "0a1b2c3d4e5f60718293a4b5c6d7e8f9",
  "playerIds": ["p1", "p2"],
  "actionLog": [
    { "type": "PLAY_CARD", "playerId": "p1", "cardInstanceId": "informant#2", "target": "p2", "guess": 5 }
  ],
  "frames": [
    { "afterActionIndex": -1, "viewerId": "p1", "view": { "...": "..." } },
    { "afterActionIndex": -1, "viewerId": "p2", "view": { "...": "..." } },
    { "afterActionIndex": 0,  "viewerId": "p1", "view": { "...": "..." } }
  ]
}
```
`actionLog` entries use exactly `PlayCardAction`'s shape (types.ts:93-102) — `target`/`guess` present only when the action actually carried them, never a literal `null`, mirroring the wire discipline `changing-the-wire` and this repo's protocol already enforce.

**R5.3 — The rejection entry's extra shape** (`engine/protected-target-rejection.json`, R3.7): the ordinary shape above, plus one field:
```json
{
  "id": "protected-target-rejection",
  "seed": "...",
  "playerIds": ["p1", "p2", "p3"],
  "actionLog": [ "...preceding accepted actions, including the Shielded Mind play..." ],
  "frames": [ "..." ],
  "rejectedAction": {
    "afterActionIndex": 3,
    "action": { "type": "PLAY_CARD", "playerId": "p3", "cardInstanceId": "han-pritcher#0", "target": "p1" },
    "expectedError": { "code": "TARGET_NOT_LEGAL", "reason": "PROTECTED" }
  }
}
```
`rejectedAction` is applied by every consumer **after** replaying `actionLog` in full, and MUST NOT be appended to any replayed log — it exists purely to assert the rejection and the absence of mutation (R4.1).

**R5.4 — `manifest.json`**:
```json
{
  "engineVersion": "<git short SHA of the commit that generated this corpus>",
  "generatedAt": "<ISO 8601, informative only — never compared>",
  "entries": ["sudden-death-2p", "match-4p", "deck-out-tiebreak-2p", "shared-win-2p", "forced-first-speaker", "discard-capacity-8", "protected-target-rejection"]
}
```
`generatedAt` is explicitly excluded from R2.4's byte-stability check (a timestamp cannot be byte-stable across regenerations by definition) — R2.4 diffs every file **except** the `generatedAt` field of `manifest.json`, or equivalently the generator SHOULD write `generatedAt` to a separate untracked sidecar so the tracked `manifest.json` stays fully byte-stable. Prefer the sidecar: it keeps R2.4's check a plain `diff -r`, no field-level exclusion logic anywhere.

**R5.5 — Generator tasks** (`scripts/gen-corpus.ts`, TypeScript under Bun, alongside the existing `scripts/gen-rng-vectors.ts` doc 2 Task 6 introduces — this script SHOULD be written after Task 6 lands, reusing its canonical-JSON helper rather than duplicating it):

1. **Task G1 — Canonical JSON helper.** Write `sortKeysDeep(value): unknown` and `writeCorpusFile(path, value): void` (the latter calling the former then `JSON.stringify(sorted, null, 2) + '\n'`). Test: round-trip a nested object with keys in reverse-alphabetical order, assert the written file's raw text has keys sorted. This is shared with doc 2's vector generator if that lands first — do not fork it.
2. **Task G2 — A recording harness.** `recordMatch(seed, playerIds, drive: (state, record) => MatchState): CorpusEntry` — `drive` is a per-scenario callback that receives the current `MatchState` and a `record(state, actionIndex)` callback it invokes after every `reduce`/`startNextRound`/`createMatch` step; `record` internally calls `broadcastViews(state, playerIds)` and appends one frame per seat. This is the one function every scenario task below calls into — scenarios differ only in `drive`.
3. **Task G3 — One function per R3 scenario** (`recordSuddenDeath2p`, `recordMatch4p`, `recordDeckOutTiebreak2p`, `recordSharedWin2p`, `recordForcedFirstSpeaker`, `recordDiscardCapacity8`, `recordProtectedTargetRejection`, optionally `recordMatch3p`) — each drives play via direct `reduce`/`startNextRound` calls (never through `dispatch`/`Room`; this corpus is engine-level) using `computeLegalPlays`/`computeLegalTargets` to pick legal actions deterministically per the scenario's specific requirement (R3.1–R3.8 each state what must be true of the outcome). `recordDiscardCapacity8` specifically imports and reuses `discardCapacity.test.ts`'s `autoAction`/`worstPileInMatch` search rather than re-deriving the sweep (R3.6).
4. **Task G4 — The `FORBIDDEN_SUBSTRINGS` guard** (R2.2), run over every frame immediately before each file is written; abort the whole generation run on any hit, printing the offending entry id and frame index.
5. **Task G5 — `manifest.json` writer**, computing `engineVersion` from `git rev-parse --short HEAD` run at generation time (shell out via `Bun.spawnSync`), falling back to `"dirty"` if the working tree has uncommitted changes to `src/game/engine/` (a corpus generated against a dirty engine tree is not reproducible and SHOULD say so rather than silently stamping a misleading SHA).
6. **Task G6 — the `bun run gen:corpus` script.** Add to `package.json`'s `scripts`: `"gen:corpus": "bun scripts/gen-corpus.ts"`, alongside the existing `generate:assets` convention. Running it regenerates every file under `godot/test/corpus/engine/` and `manifest.json` from the current `src/game/engine/` tree.
7. **Task G7 — R2.4's regeneration check as a script.** `scripts/checkCorpusFresh.ts` (or a flag on `gen-corpus.ts` itself): generate into a temp directory, diff against the committed `godot/test/corpus/` (excluding the `generatedAt` sidecar per R5.4), exit non-zero on any difference. This is what CI runs (R6.3) — it is a **read-only** check, distinct from `gen:corpus` which writes.

---

## R6 — Regenerate-on-engine-change discipline (ties to `changing-the-wire`)

**R6.1** This document's corpus inherits the exact discipline `changing-the-wire`'s skill and master plan §6.1 already state for the wire protocol: **a protocol or rule change regenerates the corpus, and CI fails until every downstream layer updates to match.** Concretely: any commit touching `src/game/engine/` (rule logic, `RedactedView`'s shape, `EFFECT_DEFS`, `SETUP_TABLE`, anything `view()` reads) that is not paired with a `bun run gen:corpus` run and a corpus commit leaves `godot/test/corpus/` stale relative to the engine that's supposed to be its source of truth.

**R6.2** CI SHALL run `scripts/checkCorpusFresh.ts` (R5.5 Task G7) on every push that touches `src/game/engine/**`, and fail the build if the committed corpus disagrees with what the current engine would generate. This is the automated half of R6.1 — a human forgetting to regenerate is caught mechanically, the same way a stale `embeddedAssets.generated.ts` is caught by its own build-time manifest check (AGENTS.md, compiled-binary section).

**R6.3** A regenerated corpus is **not** committed silently. The generator's diff (R6.2's failure output) is the changelog: whichever corpus entries changed say exactly which recorded frames moved, which is the fastest available signal for "did this engine change actually change behaviour, or just refactor." A PR that regenerates the corpus SHOULD include that diff summary in its description.

**R6.4** This retroactive-regeneration cost is the same one master §6.1 already prices in for `RedactedView`/protocol changes — "a change to the protocol is retroactive across every stored match." The corpus makes that cost visible *before* a second implementation depends on the broken assumption, rather than three engines later. This is the entire value proposition of building this document before doc 4.

---

## Definition of done (Stage 0)

- `scripts/gen-corpus.ts` exists, imports only from `src/game/engine` (R2.1), and `bun run gen:corpus` regenerates `godot/test/corpus/` deterministically (R2.4 — running it twice with no engine change produces zero diff).
- All seven mandatory scenarios from master §5 (R3.1–R3.7) are present under `godot/test/corpus/engine/`, each satisfying its own stated assertion in R3, and none of their frames contain a `FORBIDDEN_SUBSTRINGS` hit (R2.2/G4).
- `manifest.json` correctly lists every entry and stamps a real `engineVersion`.
- **The corpus round-trips against the DOM/TS engine itself** — write a small Vitest suite (`src/game/engine/__tests__/corpusRoundTrip.test.ts` or similar) that loads every `godot/test/corpus/engine/*.json` file, replays `actionLog` through the *existing* TS `reduce`/`view`, and asserts the reproduced frames equal the recorded ones exactly, and that R3.7's rejection reproduces with the recorded error code/reason. This is the proof the corpus is internally consistent *before* a second language is asked to match it — if the TS engine cannot reproduce its own recorded corpus, nothing else can be trusted to either.
- **Sufficiency is proven, not assumed**: temporarily delete or neuter one real rule in `src/game/engine/` (concretely: comment out the `protected` check inside `computeLegalTargets`'s opponent branch, legality.ts:52-67) and confirm the round-trip suite above goes red on `protected-target-rejection.json` (R3.7) — specifically, the previously-rejected action would now be accepted, or `own.legalTargets` for the actor's turn would include the protected seat. Revert the change once the failure is observed. This is the check master §5 and this document's own opening paragraph promise: proving the corpus is sufficient to catch a real deleted rule, *before* a second engine implementation is allowed to lean on it for the same guarantee.
- `bun run test`, `bunx tsc --noEmit`, and `bun run build` all still pass (the generator script and its test live inside the existing TS toolchain and are subject to the same gates as everything else in `AGENTS.md`).
- Commit message: `test: conformance corpus for the GDScript rewrite` (the exact message master plan §8 names for Stage 0's "done").

**Only when this is green does doc 2 (the RNG port) begin drawing on it for its own vector files, and doc 4 (the engine port) begins replaying it.** The corpus is the gate; nothing after it gets to skip the gate because the language changed.

---

## What this document does not own

- **The RNG stream/shuffle vectors** (`rng_stream.json`, `rng_shuffle.json`) are doc 2's, generated by `scripts/gen-rng-vectors.ts` (doc 2 Task 6), not this script — they predate this corpus in the build order (Stage 1 depends on Stage 0 per master §7's table, but doc 2's own vectors are a narrower, RNG-only slice that can be written first specifically so Stage 1 can gate before this whole corpus exists). `scripts/gen-corpus.ts` (R5.5) SHOULD import doc 2's canonical-JSON helper once it exists rather than fork it (Task G1 says the same from this side).
- **The AI decision corpus's scenario selection** is doc 5's — R4.2 fixes only the shared machinery and file conventions, not which `(view, rng)` pairs matter for AI parity.
- **Which headless runner loads these files in Godot, and how CI invokes it** is doc 9 §3 (master plan gate 4). This document fixes the JSON on disk; doc 9 fixes what reads it.
- **The wire-level (`ClientMessage`/`ServerMessage`) framing of these frames** is out of scope — R3's scenarios drive `reduce`/`view` directly, never through `Room`/`dispatch`, because this is an engine corpus, not a transport one. A transport-level corpus (reconnection ordering, rate-limit behaviour, the reaper) is exactly the gap master §9 already names as *not* covered by any corpus, and doc 6 has to re-pin it by hand.
