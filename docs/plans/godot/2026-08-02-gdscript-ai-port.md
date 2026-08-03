# GDScript AI Inference Port — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: use `superpowers:executing-plans` to implement this plan task-by-task.
> This is **Stage 6** of `2026-08-02-godot-full-rewrite-master-plan.md`. Per the master plan's stage table (§7), Stage 6 is blocked only by Stage 3 (the engine port) — not by the server or the client — and runs in parallel with Stages 4–5 once the engine replays the conformance corpus frame-for-frame. It does not gate anything downstream: a match is playable with human-only seats before this document's work lands.

**Goal:** Port the bot's *inference* path — the code that runs on a live client's turn — from `src/game/ai/` into GDScript, so that for every `(view, rng-seed, tier)` triple in an AI-decision corpus, the GDScript policy returns the identical `PolicyDecision` the TypeScript policy returns.

**Explicit non-goal, stated once and not revisited:** `arena.ts`, `cem.ts`, `selfPlay.ts` — the cross-entropy trainer and its evaluation harness — **stay in TypeScript, forever, as offline tooling.** They never ship inside `godot/`. Master plan §4 and §10 already made this call; this document does not reopen it. If `TRAINED_WEIGHTS` is ever retrained, the output is thirteen new floats pasted into a GDScript file, not a GDScript rewrite of the trainer.

**Architecture:** Seven small GDScript modules under `godot/ai/`, each a near-literal port of one TS file, holding the same seam: a `Policy` that takes a redacted view and an RNG cursor and returns a decision or `null`. No module computes a rule — every legality question is answered by reading fields the engine's `view()` already populated, and every simulated move runs through the engine's own `reduce()` (Stage 3, doc 4). This is `AGENTS.md`'s own phrase for `staticAssets.ts`, verbatim applicable here: **do not fork the policy.**

**Tech stack:** Godot 4.7.1, GDScript, GUT (headless), plus one more TypeScript vector generator run against the retiring engine — the same shape as doc 2's Task 6, extended to cover a decision rather than a random stream.

---

## 0. A naming assumption this document depends on, and cannot resolve itself

Doc 4 (the engine port) has not been written yet. Everything below assumes it represents `RedactedView` as a `Dictionary` whose keys are the **exact camelCase names of `src/game/engine/types.ts:342-409`** — `view["own"]["legalPlays"]`, `view["deckCount"]`, `view["publicLog"]`, and so on — unchanged from the TS field names, rather than translated to `snake_case`.

This is not a stylistic default; it is forced by §6.1 (the wire is frozen). The server (doc 6) forwards this same `Dictionary` to a client as a `ServerMessage` payload with **exact-key validation** on the far end. A translation layer between "the engine's internal view" and "the wire's view" is a second place the shape can drift, and the whole discipline of this project is refusing exactly that duplication. If doc 4 chooses differently, every `Dictionary` key literal in this document — and every fixture in the AI-decision corpus (§8) — has to be rewritten before a single test here can pass. Flag it now so the two documents do not silently disagree three stages apart.

---

## 1. Module map

| TS source | GDScript port | Runtime? |
| --- | --- | --- |
| `policy.ts` | `godot/ai/policy.gd` | Yes — the seam |
| `census.ts` | `godot/ai/census.gd` | Yes |
| `heuristic.ts` | `godot/ai/heuristic.gd` | Yes |
| `determinize.ts` | `godot/ai/determinize.gd` | Yes |
| `search.ts` | `godot/ai/search.gd` | Yes |
| `difficulty.ts` | `godot/ai/difficulty.gd` | Yes — the factory a session actually calls |
| `weights.ts` | `godot/ai/weights.gd` | Yes — type shape + `DEFAULT_WEIGHTS` control |
| `weights.generated.ts` | `godot/ai/weights_generated.gd` | Yes — 13 floats, committed |
| `rng.ts` (AI cursor) | `godot/ai/rng.gd` | **Already built** — doc 2 Task 5 |
| `randomPolicy.ts` | *not ported* | No `DIFFICULTIES` entry uses it (`difficulty.ts:52-61` names only `novice`/`adept`/`master`); skip until something needs it |
| `arena.ts`, `cem.ts`, `selfPlay.ts` | *not ported* | Offline trainer — §0 above |

`godot/ai/rng.gd` (`AiRng`) already exists from Stage 1. Nothing in this document re-derives mulberry32 or FNV-1a; every module below takes an `AiRng` as a parameter and calls `.next()` on it, exactly as the TS files take a `Rng` and call `.next()`. If any test in this document fails because two languages' RNG streams disagree, the bug is in doc 2, not here — re-run doc 2's vector suite before debugging anything in `godot/ai/`.

---

## 2. R1 — The Policy seam

**R1.1** `Policy` is a base class with one method: `decide(view: Dictionary, rng: AiRng) -> Variant` (a `Dictionary` shaped as `PolicyDecision`, or `null`). This mirrors `policy.ts:37-49` exactly — GDScript has no interface keyword, so the port is inheritance-and-override rather than a structural type, which is the one place this port's discipline is *weaker* than the TypeScript original: nothing stops a `Policy` subclass from typing `view` as `Dictionary` and reaching for a key that isn't there. There is no compiler here either, same as `RedactedView` losing its standalone-type guarantee in doc 4 (§6.2). The corpus (§8) is the substitute, same as it is there.

**R1.2 — GDScript-specific, and not in the TS original because TS didn't need it.** `Dictionary` and `Array` in GDScript are **reference types**: assigning one to a variable or passing it as an argument does not copy it, it aliases it. `RedactedView` in TypeScript is `readonly` all the way down and every consuming function treats it as structurally immutable by convention; nothing enforces that in GDScript. This matters specifically because of how `decide()` is called on the `master` tier: `search.gd`'s loop invokes `determinize(seat, rng)` **up to 400 times inside one `decide()` call, passing the same `seat` Dictionary every time** (mirroring `search.ts:233`, inside the `while iterations < …` loop at `:228-254`). If `determinize()` ever takes a nested value out of `seat` — `seat["own"]["hand"]`, say — and hands it into the assembled `MatchState` **without duplicating it**, and anything downstream (a `reduce()` call, a rollout ply) mutates that array in place, the mutation reaches back into `seat` itself. The 401st line of code doesn't see it; the *next* of the 400 iterations does, silently, as a corrupted `own.hand` that no longer matches what the player was actually dealt. This is the single most dangerous latent bug in this whole document, because it is invisible in a single-shot test and only shows up under repetition. §5's determinize tasks make deep-duplication a written obligation, not a hope.

**R1.3** A policy never receives or invents a `playerId`. The driver (whichever GDScript owns a bot's turn — client-side offline solo per master-plan §3.3, or eventually a server-side seat) supplies the seat when it turns the `PolicyDecision` into a `PLAY_CARD` action. Concrete failure this prevents: a `decide()` that stashed a player id anywhere in its return `Dictionary` is one accidental key-merge away from a bot playing a move as a seat it does not occupy — exactly the reason `PLAY_CARD` itself carries no `playerId` on the wire (`changing-the-wire`, and master plan §6.1).

**R1.4** Randomness is injected, never ambient. There is no `randi()`/`randf()` anywhere in `godot/ai/` — every draw comes from the `AiRng` parameter. A stray ambient call compiles, "looks random," and makes the AI-decision corpus (§8) permanently unreproducible, which is a much quieter failure than a compile error and correspondingly worse to debug three stages later.

---

## 3. R2 — `census.gd`: belief accounting and `Recall`

Ports `census.ts` whole. This is the exact half of belief — pure counting, no inference — consumed by both `heuristic.gd` (§4) and `determinize.gd` (§5), same as in TS (`census.ts:1-21`).

**R2.1** `Recall` is `{"discard_depth": int, "peeks": bool}` (or `INF` for `discard_depth`, GDScript's `INF` constant standing in for TS's `Infinity` — used identically in `PERFECT_RECALL = { discardDepth: Infinity, peeks: true }`, `census.ts:46`).

**R2.2** `take_census(seat: Dictionary, recall: Dictionary) -> Dictionary` returns `{"unseen": Array[String], "known_hands": Dictionary, "hand_sizes": Dictionary}`, replicating `census.ts:66-122` field for field:
- Hand sizes: a living seat holding the turn counts 2, any other living seat counts 1, dead counts 0 — **except** the viewer's own hand, which is *observed* (`seat.own.hand.length`) rather than inferred, and overwrites the computed value (`census.ts:67-76`). Get the override order backwards and the viewer's own census disagrees with its own hand.
- Known hands: only entries in `revealed` when `recall.peeks` is true; skip a peek at oneself (`record.subjectId === seat.own.playerId`, `:82`); de-duplicate a repeated peek at the same subject+type via a seen-set (`:88-90`) but stop pushing once `known_hands[subject].size() >= hand_sizes[subject]` (`:93`) — a hand can't hold more cards than it has.
- The multiset: start `remaining` at the catalog's per-type counts, subtract one for every located instance (own hand, the tail of each discard pile per `discard_depth`, `set_aside_face_up`, everything in `known_hands`), then expand what's left into `unseen` — one array entry per uncounted physical copy (`:96-119`).

**Task 1 — Files:** create `godot/ai/census.gd`, test `godot/test/ai/test_census.gd`.
1. Write a failing test that builds a small hand-authored `Dictionary` view (4-player, one peek recorded, one discard pile of length 2) and asserts `take_census`'s three fields against hand-computed expected values — the same style as a normal unit test, not corpus-driven, because this is small enough to reason about directly.
2. Run, confirm it fails (`Census` undefined).
3. Implement `census.gd` per R2.1–R2.2.
4. Run, confirm it passes.
5. **Commit:** `feat(ai): belief census and Recall degradation`.

---

## 4. R3 — `heuristic.gd`: the linear scorer

Ports `heuristic.ts` whole — `scoreMoves`, `chooseBest`, `createHeuristicPolicy` (`heuristic.ts:128-288`). This is Layer 1, and it is also the rollout policy layer 2 leans on (§6), so it has to be correct before search can be tested at all.

**R3.1 — the belief helpers**, straight ports of `heuristic.ts:82-107`:
- `p_holds(beliefs, player_id, value) -> float` — 1.0/0.0 if a peek pins the hand (`:84-86`), else `unseen_by_value[value] / unseen_total`, guarding the zero-total case (`:87-88`).
- `expected_value(beliefs, player_id) -> float` — the peeked card's value if known, else the mean of `unseen` (`:91-95`).
- `p_below(beliefs, player_id, mine)` / `p_above(beliefs, player_id, mine)` — sum `p_holds` over every catalog value strictly below/above `mine` (`:97-107`).

**R3.2 — floating-point order is a real risk here, not a pedantic one.** `float` in GDScript is a 64-bit IEEE double, same representation as JS `number` — so a given sequence of additions produces a bit-identical result in both languages. But floating addition is **not associative**, so `p_below`/`p_above` must sum over `VALUES` in the **same sorted-ascending order** the TS `reduce` does (`heuristic.ts:97-101` iterates the module-level `VALUES` array, itself sorted ascending at `:40-42`), not by iterating a `Dictionary`'s keys in whatever order GDScript happens to store them. The AI-decision corpus (§8) only asserts the *final chosen move*, not intermediate scores — so a reordered sum that stays within a few ULPs of the TS value will usually agree. It will not always agree: two moves scored within noise of each other are exactly the case `chooseBest`'s random tie-break (`heuristic.ts:257-264`) exists for, and a spurious ULP-level difference between languages can flip which move is "the" max before the tie-break even runs, producing a *different, both-legal* decision that still fails the corpus's exact-match assertion. Keep summation order identical to the TS source, not merely "equivalent."

**R3.3 — per-effect terms.** One `match`/`when` over `played.effect_type`, each branch a direct port:

| Effect | TS source | Formula |
| --- | --- | --- |
| Forced discard on holding (self-eliminates) | `:166-169` | fixed `weights.self_destruct` |
| Targeted card, no legal target | `:171-174` | fixed `weights.fizzle` |
| `GUARD` | `:177-183` | per target, per guessable value: `weights.guard_hit * p_holds(target, guess)` |
| `PRIEST` | `:185-190` | `weights.priest_info * (already_known ? 0.1 : 1.0)` |
| `BARON` | `:192-200` | `weights.baron_win * p_below(target, kept_value) + weights.baron_lose * p_above(target, kept_value)` — **against the retained card, not the played one** |
| `HANDMAID` | `:202-204` | `weights.handmaid_base + weights.handmaid_threat * threat` |
| `PRINCE`, self-target | `:208-217` | `weights.self_destruct` if it would discard the Mule, else `weights.prince_cycle * (unseen_mean - kept_value)` |
| `PRINCE`, other-target | `:219-224` | `weights.prince_mule_kill * p_holds(target, MULE_VALUE) + weights.prince_disrupt * expected_value(target)` |
| `KING` | `:227-238` | `weights.self_destruct` if the Mule would be traded away, else `weights.king_gain * (expected_value(target) - kept_value)` |
| default (`COUNTESS`, anything else) | `:240-242` | `weights.countess_base` |

`MULE_VALUE = 8` (`:38`); `GUESSABLE_VALUES` is every catalog value except the Informant's value (`:44-46`, `INFORMANT_VALUE` imported from the engine, not restated).

**R3.4 — the universal retention bonus.** Added to *every* move, including the fixed-score branches, before it's pushed: `weights.keep_value * kept_value * showdown`, where `showdown = 1.0 / (1.0 + seat.deck_count)` (`:136-138, 153, 162`). `kept_value` is the value of whichever card in `own.hand` is *not* the one being played (`:151-152`) — zero if there is no other card, which cannot actually occur mid-turn but keeps the formula total.

**R3.5 — `threat_level`.** Port of `:117-125`: `(1.0 if holding_mule else 0.0) + living_opponent_count * 0.15 + (0.4 if a public COMPARE log entry named this seat else 0.0)`.

**R3.6 — `choose_best`.** Find the max score, collect every move tied at that score, `AiRng.pick()` (already built, doc 2 Task 5) one of them uniformly (`:257-264`). This is why ties are broken by the injected `rng` and not by `Array` order — a systematic first-listed-move bias is exactly the bug `heuristic.ts:252-255`'s own comment names.

**Task 2 — Files:** create `godot/ai/weights.gd`, `godot/ai/weights_generated.gd`, `godot/ai/heuristic.gd`; tests `godot/test/ai/test_heuristic.gd`.
1. `weights.gd` first, since everything else needs it: a plain `Dictionary` constant (or a typed `RefCounted` with 13 `var` fields — either works; a `Dictionary` is chosen here because it round-trips to/from the JSON corpus fixtures with no glue code) holding `DEFAULT_WEIGHTS`, matching `weights.ts:57-72` key-for-key. `weights_generated.gd` holds `TRAINED_WEIGHTS` — the 13 floats from `weights.generated.ts:16-31`, pasted, **not recomputed**. This is the "13 named floats, not a model artifact" fact from the master plan: there is no training logic to port, only a copy.
2. Write a failing test pinning `scoreMoves`' output against a small number of hand-computed cases (one `GUARD` guess, one `BARON` against a known retained card, the `PRINCE`-self-with-Mule suicide branch) using `DEFAULT_WEIGHTS`.
3. Run, confirm it fails.
4. Implement `heuristic.gd` per R3.1–R3.6.
5. Run, confirm it passes.
6. **Commit:** `feat(ai): heuristic scorer and choose-best tie-break`.

---

## 5. R4 — `determinize.gd`: sampling one hidden world

Ports `determinize.ts:56-260` whole. The correctness contract is one line, quoted directly from the TS header (`:11-13`), and it is the gate for this module — not a style goal:

```
view(determinize(v, rng), v.own.playerId)   deep-equals   v
```

**R4.1 — claim order matters, and it is a direct port of `:100-125`.** Observed placements are claimed from the instance pool *before* the loose remainder is computed, so "loose" is exactly what's left over, never guessed at independently:
1. The viewer's own hand (`claim`, one call per instance — `claim` must fail loudly, not silently, if an instance is already gone; see R4.4).
2. Every seat's discard pile, one `any_copy(card_type)` per entry — copies of one type are interchangeable, so which physical copy lands where doesn't matter (`:91-97, 104-109`).
3. `set_aside_face_up`, if present (`:111`).
4. Every hand a live peek pins via `census.known_hands` (`:118-125`) — this is `census.gd`'s output, not re-derived here.

**R4.2 — the remainder, dealt in one Fisher-Yates pass.** Whatever's left in the pool is shuffled (`shuffled()`, `:128, 253-260` — a **separate, local** Fisher-Yates over the `AiRng` stream, not the engine's `Rng`/`RngState` from doc 2; it draws from the *policy's* randomness, same distinction §2's R1.4 makes) and dealt into: each other living seat's remaining hand slots (`:144-148`), the face-down set-aside (`:150`), and the deck (`:151` — whatever's left after that). A reconciliation check runs first (`:130-142`): `loose.size()` must equal `hidden_slots + seat.deck_count + seat.removed_face_down_count`, or the census and the view have disagreed about how many cards exist unaccounted-for — a bug, not a recoverable case.

**R4.3 — seat rotation is recovered, not invented.** `RedactedView` carries no `seatOrder` field, but `legalTargets` was filtered through it on the engine side (per the TS header comment, `:19-21`), so the rotation is *observable* even though it isn't a named field. Recovery: the round's leader is whoever's id is on the first `publicLog` entry that carries an `actorId` (`opening_actor`, `:245-250`); with an empty log (round not yet played into) the leader is simply `current_player_id`. Rotate `seat.players` sorted by `.seat` starting from the leader (`:154-157`).

**R4.4 — GDScript's `assert()` is the wrong tool for `claim`'s and `any_copy`'s failure paths, and this needs to be said explicitly.** `claim()` and `any_copy()` throw in TS when the pool disagrees with the view (`:84, 94`) — a real, load-bearing runtime error, not a defensive check that's expected to never fire. GDScript's `assert()` is compiled out entirely in non-debug/release exports (documented, long-standing GDScript behavior — **not re-verified against the 4.7 docs this session, confirm before relying on it**); using it here would mean the release build of `godot/ai/` silently returns a corrupted `MatchState` from a reconciliation failure instead of refusing to determinize at all, and `search.gd`'s loop would proceed to `reduce()` a world that was already known to be wrong. Use an explicit `if …: push_error(...); return null` (propagated up as "this iteration produced no world," which `search.gd`'s loop already has to handle for a `reduce()` rejection — see R5's retirement path) — never `assert()` — for every check this module makes that TS expressed as `throw`.

**R4.5 — the aliasing obligation from R1.2, restated as code, not prose.** Every array assembled here — `own_hand`, each `discard_piles[player]`, every `hands[subject]` from a known peek, the dealt slices — must be a **freshly duplicated** `Array`/`Dictionary`, never a slice or reference held over from `seat`. In GDScript terms: `seat["own"]["hand"].duplicate()` (or build a brand-new `Array` by iterating and appending), not `seat["own"]["hand"]` assigned directly. `determinize()` runs up to 400 times per `decide()` call on the same `seat` (R1.2); one aliased array turns every later iteration's world into garbage derived from whatever the *previous* iteration's `reduce()` call mutated.

**R4.6 — throws when the round can't be determinized**, ported unchanged from `:57-66`: sudden death (a tied-leaders-only round cannot distinguish a non-participant from an eliminated one) and a round that already has a `roundResult` or `matchWinnerId` both refuse rather than degrade. `search.gd` never calls `determinize()` in either state; `difficulty.gd`'s tiers below the search tier never call it at all.

**Task 3 — Files:** create `godot/ai/determinize.gd`; test `godot/test/ai/test_determinize.gd`; requires doc 4's `view()` to exist (Stage 3 must be green first — this is the concrete instance of the master-plan-table dependency "Stage 6 blocked by Stage 3").
1. Write a failing round-trip test: build a hand-authored `MatchState`-shaped `Dictionary`, call the doc-4 `view()` to get a seat, call `determinize(seat, AiRng.new("test-seed"))`, call `view()` again on the result, and assert **deep equality** against the original `seat` — the exact property the TS header states. GDScript's `Dictionary`/`Array` support `==` deep comparison (`hash_compare` semantics) for this; if GUT's `assert_eq` doesn't do a deep compare for nested `Dictionary`/`Array` out of the box, write a small `deep_eq()` helper rather than trust reference equality.
2. Run, confirm it fails.
3. Implement per R4.1–R4.6.
4. Run, confirm it passes — then run it in a loop over ~50 seeds and 2/3/4-player fixtures, since one seed passing is not the same guarantee as the shuffle-equality suite in doc 2 demanded.
5. **Commit:** `feat(ai): determinize a hidden world from a redacted view`.

---

## 6. R5 — `search.gd`: one-ply PIMC with PUCT

Ports `search.ts:41-267`. **State plainly, because it is easy to reach for the wrong mental model:** this is **not ISMCTS and not expectimax** — it is a **one-ply root search**, all budget spent re-sampling and re-scoring the moves available *right now*, never building a multi-ply tree (`search.ts:9-20`, header). The TS rationale carries over unchanged: `reduce()` cloning a round and running at roughly 60k calls/sec means a 50ms turn buys ~3000 calls, a round is 8-16 plies, and spreading that over a tree gives 1-2 visits per node — noise. A GDScript `reduce()` will have a different constant (native code vs. V8 JIT), but the *shape* of the argument — few thousand calls, few dozen candidate moves, favor breadth-of-samples-per-move over tree depth — does not change with the language, and Stage 3's engine port should re-measure the actual call rate before treating `MASTER_BUDGET` (§7) as tuned correctly for GDScript rather than merely copied from TS.

**R5.1 — per-iteration loop**, `:228-254`:
1. `determinize(seat, rng)` → a concrete world (§5, same `seat`, same aliasing obligation as R1.2/R4.5).
2. `select_by_puct(moves, iterations, explore, rng)` picks a root move: `value + explore * prior * sqrt(max(total_visits, 1)) / (1 + visits)`, where `value` is `total/visits` (0 for an unvisited move) — **PUCT, not UCB1**, and the TS comment (`:142-155`) explains why in a way worth carrying forward rather than re-deriving: UCB1 forces every move to be sampled once before any move twice, which with ~20 root moves and a few hundred rollouts is close to uniform allocation, and worse — a losing move with one sample gets the *largest* exploration bonus of any move on the board, because a low visit count *is* the bonus. The header names the concrete failure this produced: "the first version of this file played the Mule for exactly that reason." PUCT weights exploration by the base policy's *prior* instead, so a move Layer 1 already knows is self-destructive gets a near-zero prior and is essentially never sampled, without `search.gd` knowing what the Mule is.
3. Ties in step 2 broken by reservoir sampling over the `rng` stream (`:171-177`), not by first-listed-wins — same discipline as `choose_best` in §4.
4. Apply the chosen move to the sampled world with the **real, doc-4 `reduce()`** (`:236-240`). If `reduce()` rejects it (the sampled world was inconsistent with the move the real view offered — can happen because determinization is only *consistent* with the view, not unique), **retire that move from consideration entirely** for the rest of this `decide()` call (`byKey.delete`, `moves.splice`, `:241-249`) rather than retrying it. If that empties the move list, return the first candidate outright (`:247`) — a `search.gd` that never terminates on a persistently-inconsistent world is worse than one that falls back crudely.
5. Roll the *rest of the round* — not the match — forward with the Layer-1 heuristic policy under `PERFECT_RECALL` (`rollout()`, `:119-139`), capped at `MAX_ROLLOUT_PLIES = 64` (`:70`) as a runaway guard (rounds end on their own; this only bites a search running against an already-inconsistent sampled world). Score 1/0/0.5 for the root seat winning/losing/hitting the ply cap or a `null` decision from the base policy (a forced-but-empty legal-move set, treated as a draw rather than a search failure, `:128, 133`).
6. Accumulate `visits`/`total` on the chosen move.

**R5.2 — priors.** `priors_from(scores)` is a softmax over Layer 1's scores at `PRIOR_TEMPERATURE = 25` (`:184-189`, `:88`) — computed once, before the loop, from `score_moves(seat, weights, PERFECT_RECALL)` (`:202, 210`), never recomputed per iteration.

**R5.3 — `MIN_SAMPLES_PER_MOVE = 8` is a deference threshold, not a minimum-quality gate — get this backwards and the tier gets *weaker*, not merely thinner.** The TS comment is explicit and worth quoting rather than paraphrasing, because the number 8 has a measured reason behind it: a round position typically offers ~20 moves; at 60 iterations that's 3 samples each, and "a single rollout scores 0 or 1 — so one lucky win gives a move a mean of 1.0 and it captures the allocation... at that budget the master tier lost to the adept tier outright" (`search.ts:94-105`). Two checks enforce the deferral, one for each way the budget can run out:
- **Before the loop** (`:211-216`): if `budget.max_iterations < scored.size() * MIN_SAMPLES_PER_MOVE`, skip search entirely and return the base heuristic's own choice — costing zero random draws, so the answer is byte-identical to what Layer 1 alone would have produced.
- **After the loop** (`:256-258`): if a wall-clock budget cut the loop short of `min_iterations` (cannot be checked in advance, since `max_ms` isn't known to bite until it does), return `prior_best` — the highest-scoring Layer-1 move — rather than the partial visit counts.

**R5.4 — final selection is most-visited, not best-average** (`:260-264`): PUCT already spends its samples on the moves it trusts, so the visit count carries less variance than the mean score of a thinly-sampled outlier. "A move that scored 1.0 once is not a finding" is the TS comment's own summary and it is exactly right — do not substitute an average-score comparison here, it silently reintroduces the one-lucky-rollout failure R5.1 step 2's PUCT was built to avoid.

**R5.5 — wall-clock timing.** `search.ts` reads `performance.now()` (`:225, 229`), sub-millisecond precision, checked once per iteration. Godot's equivalent is `Time.get_ticks_msec()` on the `Time` singleton — **[uncertain / not re-verified against the 4.7 docs this session]**; confirm the exact class/method name and its precision (integer milliseconds vs. `Time.get_ticks_usec()`'s microseconds) before wiring `search.gd`'s budget check. The precision difference does not matter for correctness — §8 explains why the wall-clock path is never asserted exactly in the corpus regardless of which clock function is used.

**Task 4 — Files:** create `godot/ai/search.gd`; test `godot/test/ai/test_search.gd`.
1. Write a failing test with `budget = {max_iterations: N, max_ms: INF}` for a small fixed `N` and a hand-authored view with 2-3 legal moves, asserting the returned decision matches a value computed by manually tracing PUCT allocation for that `N` — small enough to hand-verify, the way `mul32`'s top-of-range vector was hand-verified in doc 2.
2. Run, confirm it fails.
3. Implement per R5.1–R5.4 (defer R5.5's exact timing API to the point it's needed — an iteration-bounded budget with `max_ms = INF` never calls it).
4. Run, confirm it passes.
5. Add the `max_ms` path only once R5.5 is resolved, with its own test asserting the search terminates and returns *some* legal decision under a very small `max_ms` — not an exact-match test; see §8.
6. **Commit:** `feat(ai): one-ply PIMC search with PUCT allocation`.

---

## 7. R6 — `difficulty.gd`: three tiers, one scorer

Ports `difficulty.ts:29-61` — the smallest module in this document and the one whose simplicity is the point. **The load-bearing rule, stated in the TS file's own header and worth repeating because it is the easiest thing to get backwards:** every tier runs the *same* scorer on the *same* trained weights. Difficulty is never a worse decision procedure — only a smaller share of the facts, or an added layer of lookahead:

```gdscript
const NOVICE_RECALL := {"discard_depth": 1, "peeks": false}       # difficulty.ts:41
const MASTER_BUDGET := {"max_iterations": 400, "max_ms": 50.0}    # difficulty.ts:50

static func create_opponent(difficulty: String, budget: Dictionary = MASTER_BUDGET) -> Policy:
    match difficulty:
        "novice":
            return HeuristicPolicy.new(TrainedWeights.WEIGHTS, "novice", NOVICE_RECALL)
        "adept":
            return HeuristicPolicy.new(TrainedWeights.WEIGHTS, "adept", Census.PERFECT_RECALL)
        "master":
            return SearchPolicy.new(budget, "master")
        _:
            push_error("unknown difficulty: %s" % difficulty)
            return null
```

**R6.1** `novice`: heuristic + `NOVICE_RECALL` — remembers only the single most recent discard per player, never retains a peek past the turn it happened. **R6.2** `adept`: heuristic + `PERFECT_RECALL` — same scorer, no forgetting, still Layer 1 only, no search. **R6.3** `master`: search + `MASTER_BUDGET`, whose own rollout policy is built with `PERFECT_RECALL` regardless of the outer tier (`search.ts:196`) — the difficulty knob never touches the rollout's memory, only the root's.

**Task 5 — Files:** create `godot/ai/difficulty.gd`; test `godot/test/ai/test_difficulty.gd`.
1. Write a failing test asserting `create_opponent("novice").weights == create_opponent("adept").weights == create_opponent("master")`'s internal `weights` (same `TRAINED_WEIGHTS` reference/value in all three) — pinning R6's actual invariant, not just that the function returns *something* per tier.
2. Run, confirm it fails.
3. Implement per R6.1–R6.3.
4. Run, confirm it passes.
5. **Commit:** `feat(ai): three difficulty tiers over one scorer`.

---

## 8. The AI-decision corpus

Doc 3 owns the general conformance-corpus machinery (recorded matches, per-seat view frames). This section is the AI-specific slice of it, generated the same way doc 2's Task 6 generated the RNG vectors — a witness script that imports the *real* TS AI and emits fixtures, never a hand-written expectation.

**R7.1 — corpus shape.** For a generated sample of `(view, ai-seed, tier)` triples, record the `PolicyDecision` (or `null`) the TS `createOpponent(tier).decide(view, makeRng(aiSeed))` actually returned. Cover, at minimum: an early-round view with many unseen cards, a late-round view with a near-empty deck (`showdown` term dominant), a view where a live peek pins an opponent's hand (Guard/Baron precision), a view where the viewer holds the Mule (`selfDestruct` branches for Prince-self and King), and a forced-fizzle view (a targeted card with no legal target). Cross each with all three tiers.

**R7.2 — generation script**, mirroring doc 2 Task 6's `R6.1`–`R6.3`: `scripts/gen-ai-vectors.ts`, importing `createOpponent`/`decide` from the real `src/game/ai/` — never restating the policy logic — emitting `godot/test/vectors/ai_decisions.json` with sorted keys and a fixed input list, byte-stable for a fixed engine+AI version.

**R7.3 — the master tier is the one entry in this whole document that cannot be asserted exactly against wall-clock production behavior, and the corpus has to say so rather than paper over it.** `SearchBudget.maxMs` is real wall-clock time (`search.ts:52`'s own doc comment: *"Bounded runs are reproducible; the clock is not."*), and Godot's iteration throughput will differ from Node's regardless of how faithful the port is — different JIT, different allocator, different machine. The shipped `MASTER_BUDGET = {maxIterations: 400, maxMs: 50}` is therefore **not eligible for exact-match corpus testing as shipped.** Two lanes, not one:
- **Determinism lane (novice, adept, and master-with-`maxMs: INF`):** generate the corpus with search's wall-clock check disabled — a fixed `max_iterations`, `max_ms = INF` — so `decide()` is a pure function of `(view, ai-seed, max_iterations)`. This is what R7.1's `master` fixtures actually pin: exact-match, same as the other two tiers.
- **Production lane (master, real `MASTER_BUDGET`):** never exact-match. Test only that the shipped config (a) terminates within its time budget, (b) returns a legal decision, and (c) its win rate against `adept` stays within a tolerance band across a batch of seeded matches — a distributional check, the same kind `arena.ts` already runs for the trainer, not a corpus diff.

Do not let "master is non-deterministic in production" become an excuse to skip determinism-lane testing of the search algorithm itself — R7.3's first lane is exact and mandatory; only the second lane is inherently approximate.

**Task 6 — Files:** create `scripts/gen-ai-vectors.ts`; output `godot/test/vectors/ai_decisions.json`; test `godot/test/ai/test_ai_corpus.gd`.
1. Write the generator per R7.1–R7.2, gated behind a `bun run gen:ai-vectors` script.
2. Write a failing GDScript test that loads the vector file, reconstructs each `view` as a `Dictionary`, calls the matching `create_opponent(tier).decide(view, AiRng.new(seed))`, and asserts equality against the recorded decision — `null == null` included as a real case, not skipped.
3. Run, confirm it fails (no GDScript AI exists yet, or an earlier task's module has a bug the smaller unit tests didn't reach).
4. Fix whichever of §3–§7's modules the failure points at.
5. Run, confirm the whole corpus passes.
6. **Commit:** `test(ai): AI-decision conformance corpus, GDScript vs. TypeScript`.

---

## 9. R8 — total engine dependence, restated for this port

The AI computes no rule. It never restates targeting legality, elimination conditions, or round-end scoring — it reads `seat.own.legal_plays` / `seat.own.legal_targets`, fields the engine's `view()` already computed with every rule (protection, First-Speaker forcing, elimination) folded in, and it simulates by calling the engine's own `reduce()`, never a hand-rolled approximation of one. This is true of `heuristic.gd` (reads legality, computes no rule), `determinize.gd` (assembles state, simulates nothing), and especially `search.gd` (applies *every* candidate and rollout move through `reduce()` — `search.ts:35`'s own comment: *"Nothing in this file knows a rule"*).

The consequence, restated from `AGENTS.md`'s treatment of `staticAssets.ts` because it is the same shape of risk: **an engine change is automatically reflected in the AI, or breaks a test — never silently drifts.** If doc 4 changes what `legalTargets` returns for a card, `heuristic.gd` and `search.gd` see the new legality on their very next `view()` call, with no AI-side code to update. If doc 4 changes `reduce()`'s validation, `search.gd`'s retirement path (R5.1 step 4) already handles a rejection it didn't previously produce. The corpus (§8) is what turns "reflected or breaks a test" from a hope into a fact — a `heuristic.gd`/`determinize.gd`/`search.gd` that silently forked the engine's rules would still compile, still return *a* decision, and only the corpus would notice it disagrees with the oracle.

This also closes the loop back to §6.2 of the master plan: the AI receives exactly the same `RedactedView` a browser client would, over the same `view()` call, with the same hidden fields absent. A `Policy` that could name the deck order or another seat's hand would be cheating by construction — not a rule someone has to remember not to break, same as the TS original's own framing (`policy.ts:7-12`).

---

## 10. Definition of done for Stage 6

- `godot/ai/{census,heuristic,determinize,search,difficulty,weights,weights_generated}.gd` exist, alongside the already-built `godot/ai/rng.gd`.
- `godot/test/ai/` passes headless (`godot --headless -s addons/gut/gut_cmdln.gd -gdir=res://test/ai -gexit` exits `0`), including the `census`/`heuristic`/`determinize`/`search`/`difficulty` unit suites (§3–§7's Tasks 1–5) and the AI-decision corpus (§8's Task 6).
- The determinism-lane corpus (R7.3) passes exact-match for `novice`, `adept`, and `master`-with-bounded-iterations-and-`max_ms: INF`.
- The production-lane check (R7.3, real `MASTER_BUDGET`) passes its termination/legality/win-rate-band assertions — not exact-match, and the test file says so in a comment so nobody "fixes" it into a flaky exact-match test later.
- `determinize.gd`'s round-trip property (`view(determinize(v, rng), v.own.playerId) == v`) holds across the seed/topology sample from Task 3, not just the corpus's fixed fixtures.
- No module under `godot/ai/` imports or restates a rule the engine (doc 4) already owns — spot-checked by grepping for anything that looks like a legality or scoring decision made outside `heuristic.gd`'s scorer.

**Only when this is green does a client (doc 7) have a bot worth seating.** Stage 6 does not block Stages 4–5, but a client that ships before this is done ships with no computer opponent — offline solo (master plan §3.3, §8) has nothing to instantiate.
