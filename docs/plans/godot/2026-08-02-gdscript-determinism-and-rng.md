# GDScript Determinism & RNG Port — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: use `superpowers:executing-plans` to implement this plan task-by-task.
> This is **Stage 1** of `2026-08-02-godot-full-rewrite-master-plan.md` and the **first GDScript code written in the whole rewrite**. If its tests do not pass, stop — nothing downstream is worth writing.

**Goal:** Reproduce `src/game/engine/rng.ts` in GDScript so that, from any seed, the GDScript generator emits a byte-identical stream and produces byte-identical shuffles to the TypeScript engine.

**Architecture:** A single pure module `engine/rng.gd` with static functions and no state of its own — state is a bare 32-bit integer passed in and returned, mirroring the TS `RngState` (which wraps exactly one number). A second thin cursor wrapper serves the AI layer, exactly as `src/game/ai/rng.ts` wraps the same functions.

**Tech Stack:** Godot 4.7.1, GDScript, GUT (headless) for the tests, and a one-off TypeScript vector generator run against the existing engine.

---

## Background — the hazard, in full

`src/game/engine/rng.ts` is the engine's entire source of randomness: mulberry32 seeded by FNV-1a, carried as one 32-bit number. Verbatim:

```ts
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const UINT32_RANGE = 4294967296;

export function seedRng(seed: string): RngState {
    let hash = FNV_OFFSET_BASIS;
    for (let i = 0; i < seed.length; i++) {
        hash ^= seed.charCodeAt(i);
        hash = Math.imul(hash, FNV_PRIME);
    }
    return { s: hash >>> 0 };
}

export function nextRng(rng: RngState): { rng: RngState; value: number } {
    const s = (rng.s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const value = ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
    return { rng: { s }, value };
}

export function shuffle<T>(items: readonly T[], rng: RngState): { shuffled: T[]; rng: RngState } {
    const shuffled = items.slice();
    let current = rng;
    for (let i = shuffled.length - 1; i > 0; i--) {
        const step = nextRng(current);
        current = step.rng;
        const j = Math.floor(step.value * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return { shuffled, rng: current };
}
```

Its correctness rests on four JavaScript facts GDScript does not share:

1. **`Math.imul(a, b)`** is a true 32-bit × 32-bit → 32-bit multiply with silent wraparound. GDScript has no equivalent; `a * b` on 64-bit signed ints does **not** wrap at 32 bits, and — critically — `0xFFFFFFFF * 0xFFFFFFFF ≈ 1.8×10^19` **overflows `int64` (max ≈ 9.2×10^18)**. So even a masked `(a * b) & 0xFFFFFFFF` is wrong at the top of the range. A half-width multiply is mandatory.
2. **`x >>> n`** is an *unsigned* right shift. GDScript's `>>` is arithmetic; it sign-extends. It is only safe on a value already masked non-negative into the low 32 bits.
3. **`x >>> 0`** coerces to `uint32`. GDScript has no unsigned type at all — the substitute is `& 0xFFFFFFFF` after every operation JavaScript would `ToInt32`/`ToUint32` implicitly (after each `^`, `|`, shift, `+`, and multiply).
4. **`seed.charCodeAt(i)`** returns UTF-16 code units. For a BMP character (all ASCII), that equals the Unicode code point `String.unicode_at(i)` returns. Every seed in this project is a 128-bit hex string (`mintHex128`) — pure ASCII — so this coincides. **A non-ASCII seed would fold differently and is therefore forbidden** (Task 2 guards it).

A naive transcription compiles, runs, produces plausible-looking shuffles, and silently produces a *different deck from the same seed*. Every persisted `{seed, actionLog}` then replays into a different match, and the failure surfaces as "reconnect shows me the wrong hand" three weeks later. This document exists to make that impossible.

**One more fact that constrains everything above it:** the match RNG **threads continuously across rounds and is never re-seeded** (`MatchState.rng` — "Threads continuously across rounds; never re-seeded"). `seedRng` runs exactly once, at `createMatch`; every `dealRound` consumes and advances the same stream. A port that re-seeds per round from `seed + roundNumber` compiles and passes a single-round test, then diverges from round 2 onward. The engine port (doc 4) inherits this; this document only has to get the *stream* right, but records the constraint so it is not lost.

---

## Task 1: The 32-bit multiply

**Files:**
- Create: `godot/engine/rng.gd`
- Test: `godot/test/engine/test_rng.gd`

**Step 1 — Write the failing test.** Pin `mul32` against three references: an identity, a mid-range case, and the top-of-range case that breaks the naive multiply.

```gdscript
func test_mul32_wraps_at_32_bits() -> void:
    assert_eq(Rng.mul32(0x811c9dc5, 0x01000193), 0x4b83b7a1)  # one FNV-1a step of a single 0x00 byte
    assert_eq(Rng.mul32(0xFFFFFFFF, 0xFFFFFFFF), 0x00000001)  # (2^32-1)^2 mod 2^32 = 1 — the int64-overflow case
    assert_eq(Rng.mul32(0x00000000, 0x01000193), 0x00000000)
```

> The `0x4b83b7a1` vector: `0x811c9dc5 ^ 0x00 = 0x811c9dc5`, times `0x01000193` mod 2^32. Compute it once with the TS engine (`node -e "console.log((Math.imul(0x811c9dc5,0x01000193)>>>0).toString(16))"`) and paste the result rather than trusting this comment.

**Step 2 — Run it, confirm it fails** (`Rng` not defined).

**Step 3 — Implement the half-width multiply.** This is the version that never overflows `int64` — its largest intermediate is `0xFFFF * 0xFFFF ≈ 4.3×10^9`.

```gdscript
class_name Rng

# uint32 * uint32 -> uint32 (wrapping), via 16-bit halves so no intermediate
# exceeds int64. The naive (a * b) & 0xFFFFFFFF overflows int64 near the top of
# the range, which is why this exists.
static func mul32(a: int, b: int) -> int:
    var a_lo := a & 0xFFFF
    var a_hi := (a >> 16) & 0xFFFF
    var b_lo := b & 0xFFFF
    var b_hi := (b >> 16) & 0xFFFF
    var low := a_lo * b_lo
    var mid := (a_lo * b_hi + a_hi * b_lo) & 0xFFFF
    return (low + (mid << 16)) & 0xFFFFFFFF
```

**Step 4 — Run it, confirm it passes.**

**Step 5 — Commit:** `feat(rng): 32-bit wrapping multiply for the GDScript engine`.

---

## Task 2: The seed fold (FNV-1a)

**Files:** Modify `godot/engine/rng.gd`; Test `godot/test/engine/test_rng.gd`.

**Step 1 — Write the failing test.** Fold a known hex seed and compare against the TS `seedRng`. Generate the expected value from the retiring engine (Task 6 automates a batch; this one can be hand-pasted first).

```gdscript
func test_seed_rng_matches_ts() -> void:
    # node -e "import('./src/game/engine/rng.ts')..." -> seedRng('deadbeef').s
    assert_eq(Rng.seed_rng("deadbeef"), 0x_PASTE_FROM_TS)

func test_seed_rng_rejects_non_ascii() -> void:
    # Seeds are always 128-bit hex in this project; a non-ASCII seed would fold
    # differently than charCodeAt and must be refused, not silently mis-hashed.
    assert_true(Rng.seed_is_ascii("0a1b2c3d"))
    assert_false(Rng.seed_is_ascii("café"))
```

**Step 2 — Run it, confirm it fails.**

**Step 3 — Implement.** Iterate `unicode_at` to match `charCodeAt` on the BMP (which covers every ASCII seed), and mask every step.

```gdscript
const FNV_OFFSET_BASIS := 0x811c9dc5
const FNV_PRIME := 0x01000193

static func seed_is_ascii(seed: String) -> bool:
    for i in seed.length():
        if seed.unicode_at(i) > 0x7F:
            return false
    return true

static func seed_rng(seed: String) -> int:
    assert(seed_is_ascii(seed), "seeds must be ASCII (all real seeds are 128-bit hex)")
    var hash := FNV_OFFSET_BASIS
    for i in seed.length():
        hash = (hash ^ seed.unicode_at(i)) & 0xFFFFFFFF
        hash = mul32(hash, FNV_PRIME)
    return hash & 0xFFFFFFFF
```

**Step 4 — Run it, confirm it passes.**
**Step 5 — Commit:** `feat(rng): FNV-1a seed fold, ASCII-guarded`.

---

## Task 3: The generator step (mulberry32)

**Files:** Modify `godot/engine/rng.gd`; Test `godot/test/engine/test_rng.gd`.

**Step 1 — Write the failing test — a *stream*, not one value.** The whole point is that the sequence matches; a single draw can coincide by luck.

```gdscript
func test_next_rng_stream_matches_ts() -> void:
    # Vector file emitted by the TS generator (Task 6): { seed, values: [float,...] }
    var vec: Dictionary = _load_json("res://test/vectors/rng_stream.json")
    for case in vec["cases"]:
        var s: int = Rng.seed_rng(case["seed"])
        for expected in case["values"]:
            var step := Rng.next_rng(s)
            assert_eq(step["value"], expected)   # exact float equality — both are IEEE doubles
            s = step["state"]
```

**Step 2 — Run it, confirm it fails.**

**Step 3 — Implement.** Every intermediate masked; the line-41 `t ^= t + imul(...)` becomes an explicit XOR-of-sum, masked — the bit pattern of the low 32 bits is identical to JavaScript's `ToInt32` truncation.

```gdscript
const RNG_INCREMENT := 0x6d2b79f5
const UINT32_RANGE := 4294967296.0   # 2^32 as a float divisor

# Returns { "state": int, "value": float in [0,1) }. Pure: state in, new state out.
static func next_rng(state: int) -> Dictionary:
    var s := (state + RNG_INCREMENT) & 0xFFFFFFFF
    var t := s
    t = mul32(t ^ (t >> 15), t | 1)
    t = (t ^ ((t + mul32(t ^ (t >> 7), t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
    var out := (t ^ (t >> 14)) & 0xFFFFFFFF
    return { "state": s, "value": float(out) / UINT32_RANGE }
```

> Why every `>>` here is safe as an arithmetic shift: `t` is always masked non-negative into the low 32 bits before each shift, so there is no sign bit set in the int64 and `>>` behaves as a logical shift. Why `float(out) / 2^32` is exact-matching: `out` is ≤ 2^32-1, representable exactly as a double, and JavaScript divides the same integer by the same 2^32 double — identical result.

**Step 4 — Run it, confirm it passes across the whole vector file.**
**Step 5 — Commit:** `feat(rng): mulberry32 step, byte-identical stream`.

---

## Task 4: The shuffle

**Files:** Modify `godot/engine/rng.gd`; Test `godot/test/engine/test_rng.gd`.

**Step 1 — Write the failing test — shuffle a known deck and compare orderings.** Use the real 16-card catalog order so this doubles as an early check on `build_deck` (doc 4).

```gdscript
func test_shuffle_matches_ts() -> void:
    var vec: Dictionary = _load_json("res://test/vectors/rng_shuffle.json")
    for case in vec["cases"]:
        var result := Rng.shuffle(vec["deck"], Rng.seed_rng(case["seed"]))
        assert_eq(result["shuffled"], case["expected_order"])
```

**Step 2 — Run it, confirm it fails.**

**Step 3 — Implement Fisher-Yates with the *exact* draw count.** The loop runs `n-1` draws (index 0 is never a pivot, only a swap target); one extra draw for index 0 desynchronises every downstream shuffle.

```gdscript
# Returns { "shuffled": Array (a copy), "state": int }. Input array untouched.
static func shuffle(items: Array, state: int) -> Dictionary:
    var out := items.duplicate()
    var s := state
    var i := out.size() - 1
    while i > 0:
        var step := next_rng(s)
        s = step["state"]
        var j := int(floor(step["value"] * (i + 1)))
        var tmp = out[i]
        out[i] = out[j]
        out[j] = tmp
        i -= 1
    return { "shuffled": out, "state": s }
```

> `int(floor(value * (i + 1)))` mirrors `Math.floor(step.value * (i + 1))` exactly: same double `value`, same small integer `(i+1)`, same product, same floor. The `while i > 0` bound stops before index 0, matching `for (…; i > 0; i--)`.

**Step 4 — Run it, confirm it passes.**
**Step 5 — Commit:** `feat(rng): Fisher-Yates shuffle, byte-identical ordering`.

---

## Task 5: The AI cursor wrapper

**Files:** Create `godot/ai/rng.gd`; Test `godot/test/ai/test_ai_rng.gd`.

The AI does not implement a second generator — `src/game/ai/rng.ts` wraps the *same* `nextRng`/`seedRng` behind a mutable cursor, on a **separate stream** from the match so a bot never perturbs the deck by thinking. Port that, and nothing else.

**Step 1 — Write the failing test:** a `make_rng(seed)` cursor whose successive `next()` values equal the pure `next_rng` stream from the same seed; and `pick(array, rng)` returning `null` for an empty array (a real case — `legalTargets` is empty for every card that takes no target).

**Step 3 — Implement** a tiny `RefCounted` holding one `int state`, calling `Rng.next_rng` and reassigning:

```gdscript
class_name AiRng
extends RefCounted

var _state: int

func _init(seed: String) -> void:
    _state = Rng.seed_rng(seed)

func next() -> float:
    var step := Rng.next_rng(_state)
    _state = step["state"]
    return step["value"]

static func pick(items: Array, rng: AiRng):
    if items.is_empty():
        return null
    return items[int(floor(rng.next() * items.size()))]
```

**Step 5 — Commit:** `feat(ai): RNG cursor over the shared generator`.

---

## Task 6: The vector generator (the retiring oracle, RNG slice)

**Files:** Create `scripts/gen-rng-vectors.ts` (TypeScript, runs under Bun against the existing engine); Output: `godot/test/vectors/rng_stream.json`, `godot/test/vectors/rng_shuffle.json`.

This is doc 3's conformance-corpus idea in miniature, scoped to the RNG so Stage 1 can gate before the full corpus exists. It **imports the real `seedRng`/`nextRng`/`shuffle`/`buildDeck`** and emits, as canonical JSON:

- `rng_stream.json` — for a generated sample of seeds (a fixed list of ~64 hex seeds, plus edge cases: `"0"`, a 32-char all-`f` seed, a single-char seed), the first ~256 `nextRng` values.
- `rng_shuffle.json` — the fixed 16-card catalog deck (`buildDeck()`), and for the same seeds the resulting `shuffled` ordering.

**Requirements:**
- **R6.1** The generator SHALL import from `src/game/engine/`, never restate the algorithm — it is a witness of the retiring engine, not a second copy.
- **R6.2** Output SHALL be byte-stable for a fixed engine version (sorted keys, fixed seed list, `JSON.stringify` with a stable replacer) so a diff is meaningful in CI.
- **R6.3** A `bun run gen:rng-vectors` script SHALL regenerate both files, and a change to `rng.ts` that alters the stream SHALL change these files and fail the GDScript suite until regenerated — the same retroactive-change discipline `changing-the-wire` describes.

**Step — Commit:** `test(rng): generate cross-language RNG conformance vectors`.

---

## Definition of done for Stage 1

- `godot/engine/rng.gd` and `godot/ai/rng.gd` exist and are pure.
- The GDScript suite loads the generated vectors and asserts **stream equality** and **shuffle equality** over the whole sample of seeds — not a handful of examples.
- Regenerating the vectors from an unchanged TS engine produces a byte-identical file (R6.2).
- The suite runs headless: `godot --headless -s addons/gut/gut_cmdln.gd -gdir=res://test/engine -gexit` exits `0` on pass, non-zero on any mismatch (doc 9 §3).

**Only when this is green does doc 4 (the engine port) begin.** The rule from the master plan, restated because it is the whole reason this document is first: if the stream is wrong, every rule built on it is wrong in a way no rule test will catch.
