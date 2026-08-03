# GDScript Engine Port — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: use `superpowers:executing-plans` to implement this plan task-by-task.
> This is **Stage 3** of `2026-08-02-godot-full-rewrite-master-plan.md`. It is **blocked by Stage 1**
> (`2026-08-02-gdscript-determinism-and-rng.md`, which must be green — `godot/engine/rng.gd` is a dependency
> imported here, not reimplemented) and by **Stage 0's corpus existing**
> (`2026-08-02-conformance-corpus.md`). Do not start Task 1 until both are true.

**Date:** 2026-08-02
**Status:** Plan.
**Scope:** Port `src/game/engine/` (1,860 LOC, `reduce`/`view`/`replayMatch` and everything they call) into
`godot/engine/`. Nothing else — no server, no AI, no client. This document's only client is the corpus: every
task ends with a corpus-replay assertion, and Stage 3 is done when the whole corpus replays frame-for-frame
(master §8, Stage 3).

**Goal:** A GDScript reducer that, given the same `{seed, actionLog}` the TS engine was fed to produce a
corpus entry, reproduces that entry's `MatchState` transitions and every recorded per-seat `RedactedView`
frame exactly — byte-for-byte where the corpus stores JSON, field-for-field where this document defines the
comparison.

---

## 0. What doc 4 assumes from doc 3

Doc 3 does not exist yet in this repository at the time of writing (only docs 1 and 2 are committed). This
section is the **contract** this document needs from it, stated so the two can be written out of order without
drifting — the same reason `RedactedView` is declared standalone rather than derived (types.ts:6-13): a
contract that's just implied by whichever file happens to exist first is a contract that silently breaks when
the other file changes shape.

**R0.1** — Doc 3 SHALL emit one JSON file per recorded match under `res://test/corpus/`, containing at minimum:
`{ seed: string, matchId: string, playerIds: string[], actionLog: PlayCardAction[], frames: Record<PlayerId,
RedactedView[]> }` — one `RedactedView` array per seat, in the order that seat received them (i.e. after every
`reduce()` and every `startNextRound()` call the TS harness performed).

**R0.2** — The `PlayCardAction` and `RedactedView` shapes inside that JSON are the TS types verbatim
(camelCase field names — `cardInstanceId`, `playerId`, `deckCount`, etc.), because `JSON.stringify` on a TS
object produces exactly that. Doc 4's GDScript reproduces those same key strings (§1.3) so comparing a
GDScript-built frame against a corpus frame is a direct `Dictionary` equality check, not a translation.

**R0.3** — Doc 3's minimum coverage list (master §5) — sudden death, a 4-player match, deck-out with a
discard-total tiebreak, a 2-player shared-win round, a forced First-Speaker discard, an eight-deep discard
pile, a protected-target rejection — is exactly what makes this document's task list checkable rather than
merely plausible. A resolver task with no corpus match that exercises its edge case is unverified no matter how
many hand-written unit assertions it carries; §9 names which corpus match backs which task.

If doc 3 ships a different envelope, update **this section only** — nothing below it should need to change,
because every task here reads corpus data only through the shape R0.1–R0.2 describe.

---

## 1. State representation decision

### 1.1 The decision

**`MatchState`, `RoundState`, `RoundPlayerState`, and `RedactedView` port as plain GDScript `Dictionary`
values — never as typed classes, `Resource` subclasses, or `RefCounted` wrappers.** `godot/engine/*.gd`
functions take a `Dictionary` in and return a new (or, inside `reduce`, mutated-in-place-then-returned)
`Dictionary` out. No file in `godot/engine/` declares a class whose instances *are* game state.

### 1.2 The justification

Two facts about the TS engine point at the same answer, and the second is the one that actually forces it:

1. **"Every type reachable from `MatchState` is plain JSON"** is the TS engine's own first invariant
   (types.ts:6-8: "Types only — no runtime code lives here... Every type reachable from MatchState is plain
   JSON. No functions, no class instances, no closures."). A GDScript `Resource` or a hand-written class with
   typed fields is a *step away* from plain JSON — it needs a serializer written and kept in sync before it can
   become the corpus's JSON, and that serializer is exactly the kind of hand-maintained translation layer
   `changing-the-wire` warns about for the network boundary. A `Dictionary` needs no such layer: it *is* the
   JSON-shaped value, both while GDScript is running and when it crosses into `res://test/corpus/*.json`.

2. **`reduce()` clones state before mutating it** — `structuredClone(match.round) as RoundDraft`
   (reduce.ts:43) — and `Draft<T>` (types.ts:90-94) is a type-level "strip every `readonly`" transform with no
   runtime behavior of its own; the actual isolation is `structuredClone`'s deep copy. A GDScript port needs
   the same operation: mutate a private copy, leave the caller's value untouched. `Dictionary.duplicate(true)`
   and `Array.duplicate(true)` are the standard GDScript container deep-copy calls for exactly this — but
   *this claim is not independently re-verified against the live 4.7 class docs in this session's research*
   (`a315258f2d48ce88e.md` covers `int`/bitwise semantics and Tween/Container/Theme surfaces; it does not touch
   `Dictionary`/`Array` duplication). Mark it **[uncertain/post-cutoff]** and do not build on it silently —
   Task 1 below exists specifically to turn the assumption into a pinned, tested fact before anything is built
   on top of it. If a typed class were used instead, this problem doesn't go away — Godot has no built-in deep
   `.duplicate()` for a plain object graph of custom class instances either, so the clone would have to be
   hand-written regardless. Dictionaries are the version of this problem that has an engine-provided answer
   worth verifying, rather than one that needs writing from scratch either way.

### 1.3 The field lists, as GDScript Dictionary schemas

Keys are the TS field names **verbatim** — camelCase, unchanged — per R0.2. This is itself a decision worth
naming: GDScript convention is `snake_case` for identifiers, but a `Dictionary` string key is data, not an
identifier, and there is no GDScript style rule it violates. Translating `cardInstanceId` to `card_instance_id`
at the boundary would be one more hand-maintained mapping, and every hand-maintained mapping in this codebase's
history has drifted at least once (the `removedFaceDownCount` field exists specifically because a differently
named field would have tripped a substring guard — view.ts:66-71 — which is the same category of bug a
snake_case translation invites here).

```gdscript
# RoundPlayerState — types.ts:187-198
{
    "id": String,
    "hand": Array[String],                    # 0, 1, or 2 CardInstanceIds
    "discardPile": Array[Dictionary],          # { instanceId, cardId, value }
    "discardValueTotal": int,
    "alive": bool,
    "protected": bool,
}

# RoundState — types.ts:210-229
{
    "roundNumber": int,
    "seatOrder": Array[String],
    "currentPlayerIndex": int,
    "turnNumber": int,
    "deckOrder": Array[String],                # server-only; last element drawn next
    "setAsideFaceDown": Array[String],          # server-only
    "setAsideFaceUp": Variant,                  # String or null
    "players": Dictionary,                      # PlayerId -> RoundPlayerState
    "privateKnowledge": Array[Dictionary],      # PeekRecord[], server-only
    "publicLog": Array[Dictionary],             # PublicLogEntry[]
    "phase": String,                            # "awaiting-play" | "round-over"
    "roundResult": Variant,                     # RoundResult Dictionary or null
}

# MatchState — types.ts:271-290
{
    "schemaVersion": int,                       # always 1
    "matchId": String,
    "playerCount": int,                         # 2 | 3 | 4
    "tokensToWin": int,                          # 7 | 5 | 4
    "players": Array[Dictionary],               # MatchPlayer[]: {id, seat, tokens, lastStartedRound}
    "seed": String,
    "rng": int,                                  # bare mulberry32 state — see Rng in godot/engine/rng.gd
    "mode": String,                              # "normal" | "sudden-death"
    "suddenDeathPlayers": Array[String],
    "round": Dictionary,                        # RoundState
    "roundHistory": Array[Dictionary],          # CompletedRound[]
    "matchWinnerId": Variant,                   # String or null
    "actionLog": Array[Dictionary],             # PlayCardAction[]
}

# RedactedView — types.ts:342-409 (the only shape any client may see)
{
    "matchId": String, "playerCount": int, "tokensToWin": int, "mode": String,
    "players": Array[Dictionary],               # public-only per-player fields, no hand
    "deckCount": int,                            # bare integer, never an array
    "setAsideFaceUp": Variant,                   # CardTypeId String or null — type only
    "removedFaceDownCount": int,                 # count only, never setAsideFaceDown
    "currentPlayerId": String, "turnNumber": int,
    "publicLog": Array[Dictionary], "roundHistory": Array[Dictionary],
    "own": Dictionary,                           # { playerId, hand, legalPlays, legalTargets }
    "revealed": Array[Dictionary],               # { subjectId, cardTypeId }
    "roundResult": Variant, "matchWinnerId": Variant,
}
```

### 1.4 The trade-off, stated plainly

`RedactedView` in TS is a **compile error away from leaking state**: the type has no field that can hold a
`hand`, a `deckOrder`, the `rng`, or the `seed`, so a resolver that tries to smuggle one through fails
`tsc --noEmit` before it ever runs. A `Dictionary` has no such field list to enforce — any key can hold anything,
and a typo (`"setAsideFaceDwon"`) or a leftover debug field passes the GDScript type checker without a murmur.

**The corpus is what replaces the compiler here** — this is master §6.2 verbatim, and it is the whole reason
Stage 0 (the corpus) is sequenced before Stage 3 (this document). A `view()` that leaks `deckOrder` doesn't fail
to compile; it fails a **diff** against a recorded frame, and only if the corpus actually exercises the path
where the leak would show up. §7 of this document ports the forbidden-substring guard as a second, blunter
line of defense specifically because a field-by-field diff can still miss a raw `MatchState` serialization
smuggled in under a key the corpus's shape doesn't expect at all — the same reasoning that produced
`FORBIDDEN_SUBSTRINGS` in the TS transport in the first place (§7.7).

### Task 1: Pin `Dictionary.duplicate(true)` before relying on it

**Files:** Create `godot/test/engine/test_dictionary_semantics.gd`.

**Test.** A nested-structure deep-copy check standing in for what `reduce()` needs from cloning a `RoundState`:
mutating a duplicated dictionary's nested array must not touch the original's.

```gdscript
func test_dictionary_duplicate_true_is_deep_for_nested_arrays() -> void:
    var original := {
        "players": {
            "p1": {"hand": ["informant#0", "informant#1"]}
        }
    }
    var clone: Dictionary = original.duplicate(true)
    (clone["players"]["p1"]["hand"] as Array).append("mule#0")

    assert_eq((original["players"]["p1"]["hand"] as Array).size(), 2,
        "duplicate(true) must be deep — a shallow copy would let the clone's mutation reach the original")
    assert_eq((clone["players"]["p1"]["hand"] as Array).size(), 3)
```

**Run it.** If this fails or errors, `Dictionary.duplicate(true)` does not behave the way §1.2 assumes — stop
and hand-write a recursive deep-copy (`deep_duplicate(value: Variant) -> Variant`, dispatching on
`typeof(value)`) before touching Task 2. Do not proceed on an unverified assumption about the one operation
`reduce()`'s whole cloning strategy depends on.

**Commit:** `test(engine): pin Dictionary.duplicate(true) deep-copy semantics`.

---

## 2. Card catalog and `build_deck()`

### R2.1 — Catalog order is data, not container iteration order

GDScript `Dictionary` key-iteration order is **not** confirmed by this session's research either — the same
gap as `duplicate(true)`, and for the same reason not worth gambling on: `buildDeck()`'s catalog order is
itself load-bearing (it is the exact pre-shuffle deck layout the RNG vectors in doc 2 were generated against —
`rng_shuffle.json` shuffles *this* order). So `build_deck()` does **not** iterate `CARD_CATALOG.keys()` or
`CARD_CATALOG.values()`. It iterates an explicit `const CARD_ORDER: Array[String]`, written once, matching the
literal order `cardCatalog.ts:15-104` declares the object in.

### `godot/engine/card_catalog.gd`

```gdscript
class_name CardCatalog

# Catalog order, written down explicitly — see R2.1. Matches cardCatalog.ts:15-104.
const CARD_ORDER: Array[String] = [
    "informant", "han-pritcher", "bail-channis", "ebling-mis", "magnifico",
    "shielded-mind", "bayta-darell", "toran-darell", "mayor-indbur",
    "first-speaker", "mule",
]

# cardCatalog.ts:15-104. displayName is omitted here — it is client copy
# (doc 7's content/ port), not engine rules data.
const CATALOG: Dictionary = {
    "informant":      {"value": 1, "count": 5, "effectType": "GUARD"},
    "han-pritcher":   {"value": 2, "count": 1, "effectType": "PRIEST"},
    "bail-channis":   {"value": 2, "count": 1, "effectType": "PRIEST"},
    "ebling-mis":     {"value": 3, "count": 1, "effectType": "BARON"},
    "magnifico":      {"value": 3, "count": 1, "effectType": "BARON"},
    "shielded-mind":  {"value": 4, "count": 2, "effectType": "HANDMAID"},
    "bayta-darell":   {"value": 5, "count": 1, "effectType": "PRINCE"},
    "toran-darell":   {"value": 5, "count": 1, "effectType": "PRINCE"},
    "mayor-indbur":   {"value": 6, "count": 1, "effectType": "KING"},
    "first-speaker":  {"value": 7, "count": 1, "effectType": "COUNTESS"},
    "mule":           {"value": 8, "count": 1, "effectType": "PRINCESS"},
}

const INFORMANT_VALUE := 1     # cardCatalog.ts:113-117
const MIN_CARD_VALUE := 1
const MAX_CARD_VALUE := 8

static func make_card_instance_id(card_id: String, ordinal: int) -> String:
    return "%s#%d" % [card_id, ordinal]

## Splits on the LAST '#' — several slugs contain hyphens, none (yet) contain
## '#', but a slug is free to. cardCatalog.ts:130-132.
static func card_type_of(instance_id: String) -> String:
    return instance_id.substr(0, instance_id.rfind("#"))

## Every instance id in a fresh deck, catalog order, pre-shuffle. cardCatalog.ts:135-143.
static func build_deck() -> Array[String]:
    var deck: Array[String] = []
    for card_id in CARD_ORDER:
        var count: int = CATALOG[card_id]["count"]
        for ordinal in range(count):
            deck.append(make_card_instance_id(card_id, ordinal))
    return deck
```

### Task 2: `build_deck()` matches the TS deck exactly

**Files:** Create `godot/test/engine/test_card_catalog.gd`.

**Test.**

```gdscript
func test_build_deck_matches_ts_order_and_count() -> void:
    var deck := CardCatalog.build_deck()
    assert_eq(deck.size(), 16)
    assert_eq(deck[0], "informant#0")
    assert_eq(deck[4], "informant#4")
    assert_eq(deck[5], "han-pritcher#0")
    assert_eq(deck[15], "mule#0")

func test_card_type_of_splits_on_last_hash() -> void:
    assert_eq(CardCatalog.card_type_of("han-pritcher#0"), "han-pritcher")
    assert_eq(CardCatalog.card_type_of("mule#0"), "mule")

func test_build_deck_matches_the_rng_shuffle_vectors_deck() -> void:
    # rng_shuffle.json (doc 2, Task 6) records buildDeck()'s own output as its
    # unshuffled input — if this drifts, doc 2's shuffle vectors silently stop
    # meaning what they claim to.
    var vec: Dictionary = _load_json("res://test/vectors/rng_shuffle.json")
    assert_eq(CardCatalog.build_deck(), vec["deck"])
```

**Commit:** `feat(engine): card catalog and build_deck, pinned against the RNG vectors' deck`.

---

## 3. The effect registry

`EffectType` collapses eleven card identities onto eight behaviors (effectRegistry.ts:1-105). The registry
carries flags only — no `Callable` stored in the `const Dictionary` literal, because whether GDScript resolves
a static-method `Callable` correctly inside a `const` dictionary evaluated at parse time is **not** confirmed
by this session's research, and there is a strictly simpler alternative that sidesteps the question entirely:
dispatch by `match` on `effectType` at the one call site that needs it (§6). Flags-only also mirrors why the TS
`EffectDef.resolve` field is the *only* non-JSON field on an otherwise-plain-data type — the port removes it
rather than finding a GDScript equivalent for it.

### `godot/engine/effect_registry.gd`

```gdscript
class_name EffectRegistry

# effectRegistry.ts:24-105. Two flags carry rules that never reach a resolver:
#  - forcedPlayTriggers drives the First Speaker constraint (Legality.compute_legal_plays).
#  - eliminatesOnDiscard drives The Mule's elimination in the shared discard step (Discard.discard_played_card).
const DEFS: Dictionary = {
    "GUARD":    {"requiresTarget": true,  "canTargetSelf": false, "requiresGuess": true,  "isPassive": false, "eliminatesOnDiscard": false, "forcedPlayTriggers": []},
    "PRIEST":   {"requiresTarget": true,  "canTargetSelf": false, "requiresGuess": false, "isPassive": false, "eliminatesOnDiscard": false, "forcedPlayTriggers": []},
    "BARON":    {"requiresTarget": true,  "canTargetSelf": false, "requiresGuess": false, "isPassive": false, "eliminatesOnDiscard": false, "forcedPlayTriggers": []},
    "HANDMAID": {"requiresTarget": false, "canTargetSelf": false, "requiresGuess": false, "isPassive": true,  "eliminatesOnDiscard": false, "forcedPlayTriggers": []},
    "PRINCE":   {"requiresTarget": true,  "canTargetSelf": true,  "requiresGuess": false, "isPassive": false, "eliminatesOnDiscard": false, "forcedPlayTriggers": []},
    "KING":     {"requiresTarget": true,  "canTargetSelf": false, "requiresGuess": false, "isPassive": false, "eliminatesOnDiscard": false, "forcedPlayTriggers": []},
    "COUNTESS": {"requiresTarget": false, "canTargetSelf": false, "requiresGuess": false, "isPassive": true,  "eliminatesOnDiscard": false, "forcedPlayTriggers": ["KING", "PRINCE"]},
    "PRINCESS": {"requiresTarget": false, "canTargetSelf": false, "requiresGuess": false, "isPassive": true,  "eliminatesOnDiscard": true,  "forcedPlayTriggers": []},
}

static func of_card(card_id: String) -> Dictionary:
    var effect_type: String = CardCatalog.CATALOG[card_id]["effectType"]
    return DEFS[effect_type]
```

### Task 3: The flags, not the behavior

**Files:** Create `godot/test/engine/test_effect_registry.gd`.

**Test.** Pin the four flags whose direction is easy to get backwards on a hand-transcription — `canTargetSelf`
true for PRINCE alone, `eliminatesOnDiscard` true for PRINCESS alone, `forcedPlayTriggers` non-empty for
COUNTESS alone, `requiresGuess` true for GUARD alone:

```gdscript
func test_only_prince_can_target_self() -> void:
    for effect_type in EffectRegistry.DEFS:
        var expected := effect_type == "PRINCE"
        assert_eq(EffectRegistry.DEFS[effect_type]["canTargetSelf"], expected, effect_type)

func test_only_princess_eliminates_on_discard() -> void:
    for effect_type in EffectRegistry.DEFS:
        var expected := effect_type == "PRINCESS"
        assert_eq(EffectRegistry.DEFS[effect_type]["eliminatesOnDiscard"], expected, effect_type)

func test_only_countess_forces_play() -> void:
    for effect_type in EffectRegistry.DEFS:
        var expected: Array = ["KING", "PRINCE"] if effect_type == "COUNTESS" else []
        assert_eq(EffectRegistry.DEFS[effect_type]["forcedPlayTriggers"], expected, effect_type)
```

**Commit:** `feat(engine): effect registry flags`.

---

## 4. Resolver shared helpers

`resolvers/shared.ts` (49 lines) supplies three primitives every resolver but Handmaid and the noop pair calls
into. Port first, since Tasks 5–11 all depend on it.

### `godot/engine/resolvers/shared.gd`

```gdscript
class_name ResolverShared

## resolvers/shared.ts:9-11.
static func log_fizzle(round: Dictionary, actor_id: String, card_id: String) -> void:
    (round["publicLog"] as Array).append({
        "kind": "FIZZLE", "turn": round["turnNumber"], "actorId": actor_id, "cardId": card_id,
    })

## Binds to the immutable (viewer, subject, instance) triple, never a hand
## position — so a traded or discarded card stops resolving instead of being
## misreported as knowledge about its replacement. resolvers/shared.ts:20-38.
static func record_peek(round: Dictionary, kind: String, viewer_id: String, subject_id: String, card_instance_id: String) -> void:
    var record := {
        "id": "%s-r%d-t%d-%s-%s" % [kind, round["roundNumber"], round["turnNumber"], viewer_id, subject_id],
        "kind": kind, "viewerId": viewer_id, "subjectId": subject_id,
        "cardInstanceId": card_instance_id, "cardTypeId": CardCatalog.card_type_of(card_instance_id),
        "roundNumber": round["roundNumber"], "createdAtTurn": round["turnNumber"],
    }
    (round["privateKnowledge"] as Array).append(record)

## The single card a player still holds after their played card was discarded.
## null only in the four-player empty-deck Prince case. resolvers/shared.ts:44-46.
static func held_card(round: Dictionary, player_id: String) -> Variant:
    var hand: Array = round["players"][player_id]["hand"]
    return hand[0] if hand.size() > 0 else null
```

### Task 4: `held_card` on an empty hand returns `null`, not an error

**Files:** Create `godot/test/engine/test_resolver_shared.gd`.

**Test.** The one case worth pinning up front, because it's the edge every resolver's fizzle path leans on:

```gdscript
func test_held_card_on_empty_hand_is_null() -> void:
    var round := {"players": {"p1": {"hand": []}}}
    assert_eq(ResolverShared.held_card(round, "p1"), null)

func test_record_peek_id_is_reproducible() -> void:
    var round := {"roundNumber": 2, "turnNumber": 5, "privateKnowledge": []}
    ResolverShared.record_peek(round, "priest", "p1", "p2", "han-pritcher#0")
    assert_eq(round["privateKnowledge"][0]["id"], "priest-r2-t5-p1-p2")
```

**Commit:** `feat(engine): resolver shared helpers (log_fizzle, record_peek, held_card)`.

---

## 5. One task per resolver

Each resolver is `resolve(ctx: Dictionary) -> void`, mutating `ctx["round"]` in place, matching `ResolveContext`
(types.ts:99-108): `{"round": Dictionary, "actorId": String, "targetId": Variant, "guess": Variant,
"playedCardId": String}`. `targetId`/`guess` are `null` when TS would have left them `undefined` — **this is
an internal engine convention, not the wire's.** The wire (doc 6, §6.1) omits an absent optional key entirely;
translating between "absent key" (wire JSON) and "`null` value" (this engine's internal `Dictionary`) is doc 6's
dispatch layer's job, not this one's, and the two must not be conflated when doc 6 is written.

### Task 5: GUARD (Informant) — `godot/engine/resolvers/guard.gd`

Compares by **value**, catching both cards of a shared value (guessing 5 catches either Darell — guard.ts:1-37).

```gdscript
class_name ResolveGuard

static func resolve(ctx: Dictionary) -> void:
    var round: Dictionary = ctx["round"]
    var actor_id: String = ctx["actorId"]
    var target_id = ctx["targetId"]
    var guess = ctx["guess"]

    if target_id == null or guess == null:
        ResolverShared.log_fizzle(round, actor_id, ctx["playedCardId"])
        return

    var target = ResolverShared.held_card(round, target_id)
    var hit: bool = target != null and CardCatalog.CATALOG[CardCatalog.card_type_of(target)]["value"] == guess

    (round["publicLog"] as Array).append({
        "kind": "GUESS", "turn": round["turnNumber"], "actorId": actor_id,
        "targetId": target_id, "guessedValue": guess, "hit": hit,
    })
    if hit:
        Discard.eliminate(round, target_id, "guard")
```

**Test** (`test_resolver_guard.gd`):

```gdscript
func test_guard_compares_by_value_catching_either_darell() -> void:
    var round := _round_with_hands({"p1": ["informant#0"], "p2": ["bayta-darell#0"]})
    ResolveGuard.resolve({"round": round, "actorId": "p1", "targetId": "p2", "guess": 5, "playedCardId": "informant"})
    assert_false(round["players"]["p2"]["alive"])

    round = _round_with_hands({"p1": ["informant#0"], "p2": ["toran-darell#0"]})
    ResolveGuard.resolve({"round": round, "actorId": "p1", "targetId": "p2", "guess": 5, "playedCardId": "informant"})
    assert_false(round["players"]["p2"]["alive"])  # the OTHER value-5 card also hits

func test_guard_fizzles_without_a_target() -> void:
    var round := _round_with_hands({"p1": ["informant#0"]})
    ResolveGuard.resolve({"round": round, "actorId": "p1", "targetId": null, "guess": null, "playedCardId": "informant"})
    assert_eq(round["publicLog"][0]["kind"], "FIZZLE")
```

**Commit:** `feat(engine): GUARD resolver`.

### Task 6: PRIEST (Han Pritcher / Bail Channis) — `godot/engine/resolvers/priest.gd`

Private peek only; nothing beyond the already-logged `PLAY` enters the public log (priest.ts:1-23).

```gdscript
class_name ResolvePriest

static func resolve(ctx: Dictionary) -> void:
    var round: Dictionary = ctx["round"]
    var actor_id: String = ctx["actorId"]
    var target_id = ctx["targetId"]

    if target_id == null:
        ResolverShared.log_fizzle(round, actor_id, ctx["playedCardId"])
        return

    var seen = ResolverShared.held_card(round, target_id)
    if seen == null:
        return
    ResolverShared.record_peek(round, "priest", actor_id, target_id, seen)
```

**Test:** actor's `privateKnowledge` gains exactly one record with `kind == "priest"`, `viewerId == actor`; no
`publicLog` entry is appended beyond what the caller already pushed for `PLAY`.

**Commit:** `feat(engine): PRIEST resolver`.

### Task 7: BARON (Ebling Mis / Magnifico) — `godot/engine/resolvers/baron.gd`

**The mutual peek is unconditional and happens BEFORE the tie check** — "nothing happens on a tie" means no
elimination, not no reveal; both sides always learn each other's card because they physically compared them
(baron.ts:1-57).

```gdscript
class_name ResolveBaron

static func resolve(ctx: Dictionary) -> void:
    var round: Dictionary = ctx["round"]
    var actor_id: String = ctx["actorId"]
    var target_id = ctx["targetId"]

    if target_id == null:
        ResolverShared.log_fizzle(round, actor_id, ctx["playedCardId"])
        return

    var actor_card = ResolverShared.held_card(round, actor_id)
    var target_card = ResolverShared.held_card(round, target_id)
    if actor_card == null or target_card == null:
        ResolverShared.log_fizzle(round, actor_id, ctx["playedCardId"])
        return

    # Mutual, unconditional, before the tie check — see the class doc.
    ResolverShared.record_peek(round, "baron", actor_id, target_id, target_card)
    ResolverShared.record_peek(round, "baron", target_id, actor_id, actor_card)

    var actor_value: int = CardCatalog.CATALOG[CardCatalog.card_type_of(actor_card)]["value"]
    var target_value: int = CardCatalog.CATALOG[CardCatalog.card_type_of(target_card)]["value"]

    if actor_value == target_value:
        (round["publicLog"] as Array).append({
            "kind": "COMPARE", "turn": round["turnNumber"], "actorId": actor_id, "targetId": target_id, "result": "tie",
        })
        return

    var loser_id: String = actor_id if actor_value < target_value else target_id
    (round["publicLog"] as Array).append({
        "kind": "COMPARE", "turn": round["turnNumber"], "actorId": actor_id, "targetId": target_id,
        "result": "actor-eliminated" if loser_id == actor_id else "target-eliminated",
    })
    Discard.eliminate(round, loser_id, "baron")
```

**Test:** a forced tie (two `value: 3` cards) leaves both `alive == true` but produces **two** `privateKnowledge`
records (one per direction) — this is the assertion most likely to be dropped by an agent that reads "nothing
happens on a tie" too literally and skips the peek on that branch.

**Commit:** `feat(engine): BARON resolver, mutual peek before the tie check`.

### Task 8: HANDMAID (Shielded Mind) — `godot/engine/resolvers/handmaid.gd`

No target; sets `protected = true`; cleared **positionally** by `advance_turn` (§7), never a stored expiry
(handmaid.ts:1-14).

```gdscript
class_name ResolveHandmaid

static func resolve(ctx: Dictionary) -> void:
    var round: Dictionary = ctx["round"]
    var actor_id: String = ctx["actorId"]
    round["players"][actor_id]["protected"] = true
    (round["publicLog"] as Array).append({"kind": "PROTECTED", "turn": round["turnNumber"], "actorId": actor_id})
```

**Commit:** `feat(engine): HANDMAID resolver`.

### Task 9: PRINCE (Bayta / Toran Darell) — `godot/engine/resolvers/prince.gd`

Two branches worth separate assertions: **the Mule-forced discard skips the redraw entirely** (drawing would
bury an unseen card and shift which turn the deck runs out on — prince.ts:1-85), and the ordinary case draws
**deck first, then the face-down set-aside, else nothing** — `"none"` is a legitimate `drewFrom` value, not an
error path, for the 4-player empty-deck edge case.

```gdscript
class_name ResolvePrince

static func resolve(ctx: Dictionary) -> void:
    var round: Dictionary = ctx["round"]
    var actor_id: String = ctx["actorId"]
    var target_id = ctx["targetId"]

    if target_id == null:
        ResolverShared.log_fizzle(round, actor_id, ctx["playedCardId"])
        return

    var target: Dictionary = round["players"][target_id]
    var discarded = ResolverShared.held_card(round, target_id)

    if discarded != null:
        var card: Dictionary = CardCatalog.CATALOG[CardCatalog.card_type_of(discarded)]

        # Forced to discard The Mule: eliminated, and NO replacement is drawn.
        # eliminate() performs the reveal itself — do not also discard here first.
        if EffectRegistry.DEFS[card["effectType"]]["eliminatesOnDiscard"]:
            Discard.eliminate(round, target_id, "mule-forced")
            return

        (target["hand"] as Array).pop_front()
        (target["discardPile"] as Array).append({"instanceId": discarded, "cardId": CardCatalog.card_type_of(discarded), "value": card["value"]})
        target["discardValueTotal"] += card["value"]

    var drew_from := _draw_replacement(round, target_id)
    (round["publicLog"] as Array).append({
        "kind": "REDREW", "turn": round["turnNumber"], "actorId": actor_id, "targetId": target_id, "drewFrom": drew_from,
    })

## Deck first, then the face-down set-aside. "none" for the 4-player empty-deck
## case — a valid empty hand, never a placeholder; it ranks below every card
## value at the deck-out showdown (roundFlow.ts EMPTY_HAND_RANK).
static func _draw_replacement(round: Dictionary, target_id: String) -> String:
    var hand: Array = round["players"][target_id]["hand"]
    var deck: Array = round["deckOrder"]
    if not deck.is_empty():
        hand.append(deck.pop_back())   # last element is drawn next — RoundState.deckOrder doc
        return "deck"
    var set_aside: Array = round["setAsideFaceDown"]
    if not set_aside.is_empty():
        hand.append(set_aside.pop_back())
        return "set-aside"
    return "none"
```

**Test.** Two cases, not one: `test_prince_mule_forced_discard_skips_redraw` (target's Mule is discarded,
`alive == false`, `deckOrder` is untouched — the size before and after must be equal); `test_prince_self_target_
after_discard_is_unambiguous` (actor targets self; because `discard_played_card` already removed the played
Prince before this resolver runs, `held_card` sees exactly the actor's one remaining card, never the Prince
itself).

**Commit:** `feat(engine): PRINCE resolver, Mule-forced discard skips the redraw`.

### Task 10: KING (Mayor Indbur) — `godot/engine/resolvers/king.gd`

A synchronous swap; no peek recorded (each trader sees the new hand as ordinary self-knowledge — `view()`'s
live re-check, §7.4, is what invalidates any third party's stale knowledge of either traded card, not a
resolver-side record).

```gdscript
class_name ResolveKing

static func resolve(ctx: Dictionary) -> void:
    var round: Dictionary = ctx["round"]
    var actor_id: String = ctx["actorId"]
    var target_id = ctx["targetId"]

    if target_id == null:
        ResolverShared.log_fizzle(round, actor_id, ctx["playedCardId"])
        return

    var actor_hand = round["players"][actor_id]["hand"]
    var target_hand = round["players"][target_id]["hand"]
    round["players"][actor_id]["hand"] = target_hand
    round["players"][target_id]["hand"] = actor_hand

    (round["publicLog"] as Array).append({"kind": "TRADED", "turn": round["turnNumber"], "actorId": actor_id, "targetId": target_id})
```

**Test:** after resolve, `players[actor_id]["hand"]` equals the target's **pre-swap** hand and vice versa —
assert against captured copies, since the whole point is the arrays are exchanged, not merged.

**Commit:** `feat(engine): KING resolver`.

### Task 11: COUNTESS / PRINCESS — `godot/engine/resolvers/noop.gd`

Both cards' entire function lives in `EffectRegistry.DEFS` flags, not here (noop.ts:1-16): the First Speaker's
forced-play rule is enforced by `Legality.compute_legal_plays` via `forcedPlayTriggers`; the Mule's elimination
is enforced by `Discard.discard_played_card` via `eliminatesOnDiscard`.

```gdscript
class_name ResolveNoop

static func resolve(_ctx: Dictionary) -> void:
    pass  # Intentionally empty — see the module doc above.
```

**Test:** calling `resolve` on a round leaves `publicLog`, `players`, and `privateKnowledge` byte-identical to
before the call (a straight `deep_equal` against a pre-call snapshot) — the test that would fail if a future
edit accidentally gave this resolver a body.

**Commit:** `feat(engine): COUNTESS/PRINCESS share the noop resolver`.

### Task 12: Dispatch — `match`, not a stored `Callable`

**Files:** Create `godot/engine/resolve.gd`.

```gdscript
class_name Resolve

## Dispatches on effectType. A match statement, not a Callable stored in
## EffectRegistry.DEFS — see §3 for why the latter is deliberately avoided.
static func resolve_effect(effect_type: String, ctx: Dictionary) -> void:
    match effect_type:
        "GUARD": ResolveGuard.resolve(ctx)
        "PRIEST": ResolvePriest.resolve(ctx)
        "BARON": ResolveBaron.resolve(ctx)
        "HANDMAID": ResolveHandmaid.resolve(ctx)
        "PRINCE": ResolvePrince.resolve(ctx)
        "KING": ResolveKing.resolve(ctx)
        "COUNTESS", "PRINCESS": ResolveNoop.resolve(ctx)
        _:
            push_error("Resolve.resolve_effect: unknown effectType %s" % effect_type)
```

**Test:** one assertion per effect type that `resolve_effect` reaches the resolver claimed (cheapest way: give
each resolver's `resolve()` a distinguishing side effect in a throwaway round and confirm dispatch produces it
— e.g. GUARD requires a `guess` key or it fizzles, so dispatching `"GUARD"` with no guess must fizzle;
dispatching `"HANDMAID"` must set `protected`).

**Commit:** `feat(engine): effect dispatch by match statement`.

---

## 6. Discard primitives

**`eliminate()` is the only code path that eliminates anyone** — a Guard hit, a lost Baron comparison, a
voluntary or Prince-forced Mule discard all route through it, which is what makes "an eliminated player's card
becomes public" hold by construction (discard.ts:1-64).

### `godot/engine/discard.gd`

```gdscript
class_name Discard

static func _push_to_discard(round: Dictionary, player_id: String, instance_id: String) -> void:
    var card: Dictionary = CardCatalog.CATALOG[CardCatalog.card_type_of(instance_id)]
    var player: Dictionary = round["players"][player_id]
    (player["discardPile"] as Array).append({"instanceId": instance_id, "cardId": CardCatalog.card_type_of(instance_id), "value": card["value"]})
    player["discardValueTotal"] += card["value"]

## THE only elimination path. discard.ts:24-36.
static func eliminate(round: Dictionary, player_id: String, cause: String) -> void:
    var player: Dictionary = round["players"][player_id]
    for instance_id in (player["hand"] as Array).duplicate():
        _push_to_discard(round, player_id, instance_id)
    player["hand"].clear()
    player["alive"] = false
    (round["publicLog"] as Array).append({"kind": "ELIMINATED", "turn": round["turnNumber"], "playerId": player_id, "cause": cause})

## Discards the played card BEFORE its effect resolves — makes "the actor's
## remaining card" unambiguous for Baron/King/self-Prince. Also where The
## Mule's own elimination-on-discard is triggered, generically, via the
## eliminatesOnDiscard flag rather than inside a resolver. discard.ts:49-64.
static func discard_played_card(round: Dictionary, player_id: String, instance_id: String) -> void:
    var player: Dictionary = round["players"][player_id]
    var card_id: String = CardCatalog.card_type_of(instance_id)

    (player["hand"] as Array).erase(instance_id)
    _push_to_discard(round, player_id, instance_id)
    (round["publicLog"] as Array).append({"kind": "PLAY", "turn": round["turnNumber"], "actorId": player_id, "cardId": card_id})

    if EffectRegistry.DEFS[CardCatalog.CATALOG[card_id]["effectType"]]["eliminatesOnDiscard"]:
        eliminate(round, player_id, "mule-voluntary")
```

### Task 13: The Mule eliminates on discard, before any resolver runs

**Files:** Create `godot/test/engine/test_discard.gd`.

**Test.**

```gdscript
func test_discarding_the_mule_eliminates_before_effect_resolution() -> void:
    var round := _round_with_hands({"p1": ["mule#0"]})
    Discard.discard_played_card(round, "p1", "mule#0")
    assert_false(round["players"]["p1"]["alive"])
    assert_eq(round["players"]["p1"]["discardPile"][0]["cardId"], "mule")
    # A second call to eliminate() would be idempotent-looking but wrong —
    # discard_played_card must be the ONLY caller for a Mule play; reduce()'s
    # own alive-guard (Task 14) is what stops a second elimination attempt.

func test_eliminate_reveals_the_whole_hand() -> void:
    var round := _round_with_hands({"p1": ["han-pritcher#0", "informant#3"]})
    Discard.eliminate(round, "p1", "baron")
    assert_eq((round["players"]["p1"]["discardPile"] as Array).size(), 2)
    assert_true((round["players"]["p1"]["hand"] as Array).is_empty())
```

**Commit:** `feat(engine): discard primitives — eliminate is the sole elimination path`.

---

## 7. `reduce()` — the pipeline, in the fixed order

**R7.1** — The pipeline order SHALL be exactly: **validate → discard the played card → resolve (guarded by
`actor.alive`) → check round end → advance turn.** This is reduce.ts:35-69 verbatim, and every clause of that
order is load-bearing:

- Discarding *before* resolving is what makes "the actor's remaining card" unambiguous for Baron/King/a
  self-targeted Prince — by the time the resolver runs, the played instance is already gone from the hand.
- The `alive` guard before calling the resolver exists because playing the Mule voluntarily already eliminated
  the actor inside the discard step (§6) — a dead actor's effect must never fire. Today this only matters for
  PRINCESS (whose resolver is a noop anyway), but the guard is generic so a future card with a real effect and
  `eliminatesOnDiscard: true` doesn't need this rule rediscovered.
- Checking round end *before* advancing the turn is what "a round ends when a player cannot draw" means
  operationally: `checkRoundEnd` runs right after a play resolves and right before the next player would draw,
  so an empty deck at that moment ends the round instead of handing out an undrawable turn.

### `godot/engine/reduce.gd`

```gdscript
class_name Reduce

## The sole gameplay mutation entrypoint. reduce.ts:35-69.
## Returns { "ok": true, "state": Dictionary } or { "ok": false, "error": Dictionary }.
static func reduce(match: Dictionary, action: Dictionary) -> Dictionary:
    if match["matchWinnerId"] != null:
        return {"ok": false, "error": {"code": "ROUND_NOT_IN_PROGRESS"}}

    var validation := Validation.validate_action(match["round"], action)
    if not validation["ok"]:
        return validation

    var round: Dictionary = (match["round"] as Dictionary).duplicate(true)   # Task 1 pins this deep
    var card_id: String = CardCatalog.card_type_of(action["cardInstanceId"])
    var effect_type: String = CardCatalog.CATALOG[card_id]["effectType"]

    Discard.discard_played_card(round, action["playerId"], action["cardInstanceId"])

    # A player who played The Mule is already out; their effect never resolves.
    if round["players"][action["playerId"]]["alive"]:
        Resolve.resolve_effect(effect_type, {
            "round": round, "actorId": action["playerId"],
            "targetId": action.get("target", null), "guess": action.get("guess", null),
            "playedCardId": card_id,
        })

    var action_log: Array = (match["actionLog"] as Array).duplicate()
    action_log.append(action)

    var outcome = RoundFlow.check_round_end(round)

    if outcome == null:
        RoundFlow.advance_turn(round)
        var next_match: Dictionary = match.duplicate()
        next_match["round"] = round
        next_match["actionLog"] = action_log
        return {"ok": true, "state": next_match}

    var mid_match: Dictionary = match.duplicate()
    mid_match["actionLog"] = action_log
    return {"ok": true, "state": RoundLifecycle.conclude_round(mid_match, round, outcome)}
```

`Validation.validate_action` mirrors `validation.ts:16-96`'s fixed check order — round phase → turn ownership
→ card-in-hand → forced-play (`Legality.compute_legal_plays`) → target requirement/legality (rejection reasons
`PROTECTED | ELIMINATED | SELF_NOT_ALLOWED | UNKNOWN_PLAYER`, `computeLegalTargets` again) → guess
requirement/range/self-guess ban. It is ported once here because `reduce()` needs it, but it is **shared** with
`view()`'s own `legalPlays`/`legalTargets` hint (§8) exactly as `computeLegalPlays`/`computeLegalTargets` are
shared in TS — port `legality.gd` (`compute_legal_plays`, `compute_legal_targets`, mirroring legality.ts:1-67's
"check the actor and opponents SEPARATELY, never collapse into one predicate" warning) once, in Task 14, and
have both `validation.gd` and `view.gd` import it. The full validation error-code surface belongs to the wire
boundary doc (doc 6) more than to this one; this document only needs `validate_action` to gate `reduce()`
correctly for the corpus, so keep the port narrow: one function, the seven checks, no client-facing error
formatting.

### Task 14: `legality.gd` — the shared gate, and the trap it exists to prevent

**Files:** Create `godot/engine/legality.gd`, `godot/test/engine/test_legality.gd`.

**Test.** The regression this file's own TS comment warns about — collapsing the self/opponent check into one
predicate lets a Prince target a protected opponent:

```gdscript
func test_prince_cannot_target_a_protected_opponent() -> void:
    var round := _round(["p1", "p2"], {"p1": {"alive": true, "protected": false}, "p2": {"alive": true, "protected": true}})
    var targets := Legality.compute_legal_targets(round, "p1", EffectRegistry.DEFS["PRINCE"])
    assert_true(targets.has("p1"))    # self, exempted by canTargetSelf
    assert_false(targets.has("p2"))   # protected opponent — never exempted, even though PRINCE canTargetSelf

func test_first_speaker_forced_alongside_king_or_prince() -> void:
    var round := _round_with_hands({"p1": ["first-speaker#0", "mayor-indbur#0"]})
    var plays := Legality.compute_legal_plays(round, "p1")
    assert_eq(plays, ["first-speaker#0"])
```

**Implement:** direct port of `computeLegalPlays`/`computeLegalTargets` (legality.ts:26-67) — a hand scan for a
forcing card whose `forcedPlayTriggers` matches another card in hand, and a `seatOrder` filter checking
`alive`/`protected` for opponents and `canTargetSelf` for the actor **as two separate branches of the same
`if`**, never merged.

**Commit:** `feat(engine): legality — compute_legal_plays, compute_legal_targets`.

### Task 15: `validation.gd`

**Files:** Create `godot/engine/validation.gd`, `godot/test/engine/test_validation.gd`.

**Test:** one case per rejection this document actually exercises downstream — wrong turn (`NOT_YOUR_TURN`),
card not in hand (`CARD_NOT_IN_HAND`), a fizzle-eligible play with no legal targets still validates `ok: true`
even with `target` absent (validation.ts:44-51's "the play still happens and still discards" comment — the
easiest of these seven checks to get backwards), and the Informant guessing its own value (`GUESS_CANNOT_BE_
INFORMANT`).

**Commit:** `feat(engine): validate_action, the shared legality gate`.

### Task 16: `reduce()` replays one corpus turn correctly

**Files:** Create `godot/test/engine/test_reduce.gd`.

**Test.** Take the corpus match doc 3 records for "a 2-player match reaching sudden death" (R0.3), replay its
first logged action through `Reduce.reduce`, and assert the resulting `round.publicLog`'s first two entries are
`PLAY` then whatever the played card's effect logged — this is the pipeline-order assertion, not a rules
assertion (the resolver tasks already cover rules): if `resolve` ran before `discard_played_card`, the `PLAY`
log entry would be missing or out of order.

```gdscript
func test_reduce_pipeline_order_play_then_effect() -> void:
    var corpus: Dictionary = _load_json("res://test/corpus/two_player_sudden_death.json")
    var state := Setup.create_match(corpus["playerIds"], corpus["seed"], corpus["matchId"])
    var result := Reduce.reduce(state, corpus["actionLog"][0])
    assert_true(result["ok"])
    var log: Array = result["state"]["round"]["publicLog"]
    assert_eq(log[0]["kind"], "PLAY")
```

**Commit:** `feat(engine): reduce() — validate, discard, resolve, check end, advance, in that order`.

---

## 8. Round flow

### `godot/engine/round_flow.gd`

```gdscript
class_name RoundFlow

const EMPTY_HAND_RANK := -1

## Protection for the incoming seat is cleared FIRST, before they draw.
## Positional, never a stored expiry — eliminations reshape the rotation
## mid-window, which a counter can't track but a position always answers
## correctly. roundFlow.ts:15-32.
static func advance_turn(round: Dictionary) -> void:
    var seats: Array = round["seatOrder"]
    var index: int = round["currentPlayerIndex"]
    for _step in range(seats.size()):
        index = (index + 1) % seats.size()
        if round["players"][seats[index]]["alive"]:
            break
    round["currentPlayerIndex"] = index
    round["turnNumber"] += 1

    var incoming: Dictionary = round["players"][seats[index]]
    incoming["protected"] = false

    var deck: Array = round["deckOrder"]
    if not deck.is_empty():
        incoming["hand"].append(deck.pop_back())

static func _hand_rank(round: Dictionary, player_id: String) -> int:
    var hand: Array = round["players"][player_id]["hand"]
    if hand.is_empty():
        return EMPTY_HAND_RANK
    return CardCatalog.CATALOG[CardCatalog.card_type_of(hand[0])]["value"]

## Called after a play resolves, before the next player draws. null while the
## round continues. roundFlow.ts:50-74.
static func check_round_end(round: Dictionary):
    var survivors: Array = (round["seatOrder"] as Array).filter(func(id): return round["players"][id]["alive"])

    if survivors.size() <= 1:
        return {"reason": "last-survivor", "winnerIds": survivors}

    if not (round["deckOrder"] as Array).is_empty():
        return null

    var revealed_hands := {}
    for id in survivors:
        var hand: Array = round["players"][id]["hand"]
        revealed_hands[id] = CardCatalog.card_type_of(hand[0]) if not hand.is_empty() else null

    var best_rank: int = survivors.map(func(id): return _hand_rank(round, id)).max()
    var by_rank: Array = survivors.filter(func(id): return _hand_rank(round, id) == best_rank)

    var best_discard: int = by_rank.map(func(id): return round["players"][id]["discardValueTotal"]).max()
    var winner_ids: Array = by_rank.filter(func(id): return round["players"][id]["discardValueTotal"] == best_discard)

    return {"reason": "deck-out", "winnerIds": winner_ids, "revealedHands": revealed_hands}
```

`Array.max()`/`Array.filter()`/`Array.map()` are ordinary GDScript 4.x `Array` methods with lambda `Callable`
arguments — standard, long-shipped surface, not tagged, matching the convention set in the RNG doc for
core-language constructs that aren't distinctive 4.7 API surface.

### `godot/engine/round_lifecycle.gd`

```gdscript
class_name RoundLifecycle

## Awards tokens, then decides match-over / sudden-death / continue.
## reduce.ts:75-116.
static func conclude_round(match: Dictionary, round: Dictionary, outcome: Dictionary) -> Dictionary:
    var finished: Dictionary = round.duplicate(true)
    finished["phase"] = "round-over"
    finished["roundResult"] = outcome
    (finished["publicLog"] as Array).append({
        "kind": "ROUND_END", "turn": round["turnNumber"], "reason": outcome["reason"], "winners": outcome["winnerIds"],
    })

    var players: Array = (match["players"] as Array).map(func(p):
        var np: Dictionary = p.duplicate()
        if (outcome["winnerIds"] as Array).has(p["id"]):
            np["tokens"] += 1
        return np
    )

    var settled: Dictionary = match.duplicate()
    settled["players"] = players
    settled["round"] = finished

    # Sudden death: a clean round win takes the match outright — token totals
    # are ignored entirely, not just capped.
    if match["mode"] == "sudden-death":
        if (outcome["winnerIds"] as Array).size() == 1:
            settled["matchWinnerId"] = outcome["winnerIds"][0]
        else:
            settled["suddenDeathPlayers"] = (outcome["winnerIds"] as Array).duplicate()
        return settled

    var at_target: Array = players.filter(func(p): return p["tokens"] >= match["tokensToWin"])
    if at_target.size() == 1:
        settled["matchWinnerId"] = at_target[0]["id"]
    elif at_target.size() > 1:
        settled["mode"] = "sudden-death"
        settled["suddenDeathPlayers"] = at_target.map(func(p): return p["id"])
    return settled

## The previous round's winner leads; a co-win breaks toward whoever most
## recently led. reduce.ts:118-176.
static func start_next_round(match: Dictionary) -> Dictionary:
    assert(match["round"]["phase"] == "round-over", "the current round is still in progress")
    assert(match["matchWinnerId"] == null, "the match is already decided")

    var participants: Array = match["suddenDeathPlayers"] if match["mode"] == "sudden-death" else (match["players"] as Array).map(func(p): return p["id"])
    var winners: Array = match["round"]["roundResult"].get("winnerIds", []) if match["round"]["roundResult"] != null else []
    var eligible: Array = winners.filter(func(id): return participants.has(id))
    var starter_id: String = _choose_starter(match, eligible, participants)

    var dealt := Setup.deal_round(participants, starter_id, match["round"]["roundNumber"] + 1, match["rng"])
    var finished: Dictionary = match["round"]

    var next: Dictionary = match.duplicate()
    next["rng"] = dealt["rng"]
    next["players"] = (match["players"] as Array).map(func(p):
        var np: Dictionary = p.duplicate()
        if p["id"] == starter_id:
            np["lastStartedRound"] = dealt["round"]["roundNumber"]
        return np
    )
    next["roundHistory"] = (match["roundHistory"] as Array).duplicate()
    next["roundHistory"].append({
        "roundNumber": finished["roundNumber"],
        "reason": finished["roundResult"]["reason"] if finished["roundResult"] != null else "last-survivor",
        "winnerIds": finished["roundResult"]["winnerIds"] if finished["roundResult"] != null else [],
        "publicLog": finished["publicLog"],
    })
    next["round"] = dealt["round"]
    return next

static func _choose_starter(match: Dictionary, winner_ids: Array, participants: Array) -> String:
    if winner_ids.size() == 1:
        return winner_ids[0]
    if winner_ids.is_empty():
        return participants[0]

    var last_started := func(id): 
        for p in (match["players"] as Array):
            if p["id"] == id:
                return p["lastStartedRound"]
        return 0
    var most_recent: int = winner_ids.map(last_started).max()

    if most_recent > 0:
        for id in winner_ids:
            if last_started.call(id) == most_recent:
                return id

    # Nobody tied has ever led. Fall back to turn order in the finished round.
    for id in (match["round"]["seatOrder"] as Array):
        if winner_ids.has(id):
            return id
    return winner_ids[0]
```

### `godot/engine/setup.gd`

```gdscript
class_name Setup

# player count -> {faceUp, faceDown, tokensToWin}. setup.ts:14-18.
const SETUP_TABLE := {
    2: {"faceUp": 1, "faceDown": 2, "tokensToWin": 7},
    3: {"faceUp": 0, "faceDown": 1, "tokensToWin": 5},
    4: {"faceUp": 0, "faceDown": 0, "tokensToWin": 4},
}

static func _fresh_player(id: String) -> Dictionary:
    return {"id": id, "hand": [], "discardPile": [], "discardValueTotal": 0, "alive": true, "protected": false}

## Shuffles, burns/sets-aside per SETUP_TABLE, deals one card each, rotates
## seatOrder to start at starterId, then gives the starter an OPENING SECOND
## DRAW — the round opens mid-turn with the starter already holding 2 cards.
## setup.ts:52-100.
static func deal_round(participants: Array, starter_id: String, round_number: int, rng: int) -> Dictionary:
    var count: int = participants.size()
    var table: Dictionary = SETUP_TABLE[count]

    var shuffle_result := Rng.shuffle(CardCatalog.build_deck(), rng)
    var deck: Array = shuffle_result["shuffled"]
    var after_shuffle: int = shuffle_result["state"]

    var set_aside_face_up = deck.pop_back() if table["faceUp"] > 0 else null
    var set_aside_face_down: Array = []
    for _i in range(table["faceDown"]):
        set_aside_face_down.append(deck.pop_back())

    var players := {}
    for id in participants:
        var p := _fresh_player(id)
        p["hand"] = [deck.pop_back()]
        players[id] = p

    var start_at: int = participants.find(starter_id)
    var seat_order: Array = participants.slice(start_at) + participants.slice(0, start_at)

    (players[starter_id]["hand"] as Array).append(deck.pop_back())   # the opening draw

    return {
        "round": {
            "roundNumber": round_number, "seatOrder": seat_order, "currentPlayerIndex": 0, "turnNumber": 1,
            "deckOrder": deck, "setAsideFaceDown": set_aside_face_down, "setAsideFaceUp": set_aside_face_up,
            "players": players, "privateKnowledge": [], "publicLog": [], "phase": "awaiting-play", "roundResult": null,
        },
        "rng": after_shuffle,
    }

## seedRng runs exactly ONCE, here. Every later round threads the same rng
## forward through start_next_round — never re-seeded. setup.ts:113-145.
## Depends on godot/engine/rng.gd (Stage 1) — do not reimplement seed_rng here.
static func create_match(player_ids: Array, seed: String, match_id: String = "match") -> Dictionary:
    var starter_id: String = player_ids[0]
    var dealt := deal_round(player_ids, starter_id, 1, Rng.seed_rng(seed))

    var players: Array = []
    for i in range(player_ids.size()):
        players.append({"id": player_ids[i], "seat": i, "tokens": 0, "lastStartedRound": 1 if player_ids[i] == starter_id else 0})

    return {
        "schemaVersion": 1, "matchId": match_id, "playerCount": player_ids.size(),
        "tokensToWin": SETUP_TABLE[player_ids.size()]["tokensToWin"], "players": players,
        "seed": seed, "rng": dealt["rng"], "mode": "normal", "suddenDeathPlayers": [],
        "round": dealt["round"], "roundHistory": [], "matchWinnerId": null, "actionLog": [],
    }
```

### Task 17: `advance_turn` clears protection positionally

**Files:** Create `godot/test/engine/test_round_flow.gd`.

**Test.** The regression this rule exists to prevent: a Handmaid player's protection must survive an unrelated
elimination that happens between their turns, and must clear the instant they become current again — never
before, never a turn late:

```gdscript
func test_protection_clears_positionally_not_by_a_counter() -> void:
    var round := _round(["p1", "p2", "p3"], {"p1": {"protected": true}, "p2": {"alive": true}, "p3": {"alive": true}})
    round["currentPlayerIndex"] = 1   # p2's turn
    RoundFlow.advance_turn(round)     # -> p3
    assert_true(round["players"]["p1"]["protected"])   # untouched — not p1's turn yet
    RoundFlow.advance_turn(round)     # -> p1
    assert_false(round["players"]["p1"]["protected"])  # cleared the instant it's p1's turn
```

**Commit:** `feat(engine): advance_turn clears protection positionally`.

### Task 18: `check_round_end` — deck-out showdown ranks by value then discard total

**Files:** Modify `godot/test/engine/test_round_flow.gd`.

**Test:** three survivors, two tied on hand value, one of the two with a higher `discardValueTotal` — only the
higher-discard player wins; the third survivor (lower hand value) wins nothing regardless of discard total.
Separately, an `EMPTY_HAND_RANK` case (a 4-player empty-deck Prince fallback survivor with `hand == []`) must
rank below every real card, never crash on `hand[0]`.

**Commit:** `feat(engine): check_round_end — last-survivor and deck-out showdown`.

### Task 19: `deal_round` matches `SETUP_TABLE` and the opening second draw

**Files:** Create `godot/test/engine/test_setup.gd`.

**Test.** Assert `deal_round` for each player count against `SETUP_TABLE`'s `{faceUp, faceDown}`, and that the
starter alone holds 2 cards after dealing while everyone else holds 1. Then the determinism check that ties
this task to Stage 1: replay `create_match` for a seed in `rng_shuffle.json`'s sample and assert the resulting
`round.deckOrder` (reversed, since `deckOrder`'s *last* element is drawn next but the shuffle vector records
forward order) matches the recorded shuffle **after** removing the burn/set-aside/dealt cards from the front —
this is the first end-to-end proof that `Setup` and `Rng` (Stage 1) agree with each other, not just each with
their own tests.

**Commit:** `feat(engine): deal_round and create_match — SETUP_TABLE, opening second draw`.

### Task 20: `start_next_round` — starter selection and sudden death entry

**Files:** Create `godot/test/engine/test_round_lifecycle.gd`.

**Test:** a single-winner round hands the starter role to that winner; a co-win where neither has ever started
falls back to `seatOrder`; a co-win where one co-winner has a higher `lastStartedRound` than the other picks
that one. Separately, `conclude_round` in `mode: "sudden-death"` with a single round-winner sets
`matchWinnerId` **even if their token count never crossed `tokensToWin`** — this is the assertion most likely
to be silently dropped, since it reads like a bug (ignoring tokens) rather than the rule (reduce.ts:98-101).

**Commit:** `feat(engine): start_next_round, conclude_round, choose_starter`.

---

## 9. `view()` — redaction, field by field (gated task-set)

Each task below is independently gated: it may land only once its own test — one specific forbidden field, one
specific safe field — passes against a real corpus frame. This granularity exists because §1.4's whole point is
that redaction failures are diff failures, not compiler errors; testing "the view looks about right" in one
lump assertion is exactly the coarse check that let `removedFaceDownCount`'s naming trap matter in the first
place (view.ts:66-71) — a broad pass/fail can't tell you *which* field leaked.

### `godot/engine/view.gd`

```gdscript
class_name View

## THE only function whose output may ever reach a client. view.ts:33-104.
static func view(match: Dictionary, viewer_id: String) -> Dictionary:
    var round: Dictionary = match["round"]
    var viewer = round["players"].get(viewer_id, null)
    var is_current_player: bool = round["seatOrder"][round["currentPlayerIndex"]] == viewer_id

    return {
        "matchId": match["matchId"], "playerCount": match["playerCount"], "tokensToWin": match["tokensToWin"], "mode": match["mode"],
        "players": _public_players(match, round),
        "deckCount": (round["deckOrder"] as Array).size(),                                  # §9.2
        "setAsideFaceUp": CardCatalog.card_type_of(round["setAsideFaceUp"]) if round["setAsideFaceUp"] != null else null,  # §9.2
        "removedFaceDownCount": (round["setAsideFaceDown"] as Array).size(),                 # §9.2
        "currentPlayerId": round["seatOrder"][round["currentPlayerIndex"]],
        "turnNumber": round["turnNumber"],
        "publicLog": round["publicLog"],                                                     # §9.5
        "roundHistory": match["roundHistory"],                                               # §9.5
        "own": {
            "playerId": viewer_id,
            "hand": viewer["hand"] if viewer != null else [],                                # §9.3
            "legalPlays": Legality.compute_legal_plays(round, viewer_id) if is_current_player else [],  # §9.3
            "legalTargets": _legal_targets_for(round, viewer_id) if is_current_player else {},          # §9.3
        },
        "revealed": _revealed_for(round, viewer_id),                                         # §9.4
        "roundResult": round["roundResult"] if round["phase"] == "round-over" else null,      # §9.6
        "matchWinnerId": match["matchWinnerId"],                                              # §9.6
    }

static func _public_players(match: Dictionary, round: Dictionary) -> Array:
    var out: Array = []
    for player in (match["players"] as Array):
        var in_round = round["players"].get(player["id"], null)
        out.append({
            "id": player["id"], "seat": player["seat"], "tokens": player["tokens"],
            "alive": in_round["alive"] if in_round != null else false,
            "protected": in_round["protected"] if in_round != null else false,
            "discardPile": (in_round["discardPile"] as Array) if in_round != null else [],
            "discardValueTotal": in_round["discardValueTotal"] if in_round != null else 0,
        })
    return out

static func _legal_targets_for(round: Dictionary, actor_id: String) -> Dictionary:
    var targets := {}
    for instance_id in Legality.compute_legal_plays(round, actor_id):
        var effect_def: Dictionary = EffectRegistry.of_card(CardCatalog.card_type_of(instance_id))
        targets[instance_id] = Legality.compute_legal_targets(round, actor_id, effect_def)
    return targets

## Re-checked LIVE, every call: a record survives only while the subject
## still holds that exact instance. A traded/discarded card stops resolving
## rather than being misreported as knowledge about its replacement.
static func _revealed_for(round: Dictionary, viewer_id: String) -> Array:
    var out: Array = []
    for record in (round["privateKnowledge"] as Array):
        if record["viewerId"] != viewer_id or record["roundNumber"] != round["roundNumber"]:
            continue
        var subject = round["players"].get(record["subjectId"], null)
        if subject != null and (subject["hand"] as Array).has(record["cardInstanceId"]):
            out.append({"subjectId": record["subjectId"], "cardTypeId": record["cardTypeId"]})
    return out
```

### Task 21: `players[]` carries no hand

**Test:** for a round where `p2` holds a face-down card, `view(match, "p1")["players"]` has an entry for `p2`
with keys exactly `{id, seat, tokens, alive, protected, discardPile, discardValueTotal}` — assert the **key set**,
not just that a `hand` key is absent, so an added field is caught the same way a leaked one would be.

**Commit:** `feat(engine): view() — public player fields, no hand`.

### Task 22: `deckCount` / `setAsideFaceUp` / `removedFaceDownCount` are counts and types, never arrays or instances

**Test:** three assertions against one round with a non-trivial deck: `typeof(view["deckCount"]) == TYPE_INT`
(never `TYPE_ARRAY`); `view["setAsideFaceUp"]` equals the card **type** id (`"informant"`, say) never an
instance id (`"informant#2"`); `view["removedFaceDownCount"]` is an integer equal to
`round["setAsideFaceDown"].size()`, and the key `"setAsideFaceDown"` (the array) does not appear anywhere in
`view.keys()` at all — this is the specific naming trap view.ts:66-71 documents: a differently-named count
field would still be safe in shape but would trip the substring guard in Task 25 by *containing* the forbidden
substring in its own key name, so the field is named `removedFaceDownCount` specifically to not contain it.

**Commit:** `feat(engine): view() — deckCount/setAsideFaceUp/removedFaceDownCount as counts and types only`.

### Task 23: `own.legalPlays`/`own.legalTargets` are empty for a non-current viewer

**Test:** two views of the same round, one for the current player and one for someone else — the non-current
viewer's `own.legalPlays` and `own.legalTargets` are `[]`/`{}` even though `Legality.compute_legal_plays` would
happily return a real answer for them if called directly; the gate is `is_current_player`, not "does this player
have a turn to take eventually."

**Commit:** `feat(engine): view() — own.legalPlays/legalTargets gated on is_current_player`.

### Task 24: `revealed` stops resolving once the subject no longer holds the card

**Test.** The specific regression `_revealed_for`'s live re-check exists to prevent: p1 Priest-peeks p2's card,
then p2 plays King and trades hands with p3. p1's `revealed` list for p2 must now be **empty** — not
misreporting p3's new-to-p2 card as still being what p1 originally saw.

```gdscript
func test_revealed_stops_resolving_after_a_trade() -> void:
    var round := _round_with_hands({"p1": ["han-pritcher#0"], "p2": ["informant#0"], "p3": ["mule#0"]})
    ResolverShared.record_peek(round, "priest", "p1", "p2", "informant#0")
    # p2 and p3 trade — informant#0 leaves p2's hand.
    round["players"]["p2"]["hand"] = ["mule#0"]
    round["players"]["p3"]["hand"] = ["informant#0"]

    var match := _match_with_round(round)
    var revealed: Array = View.view(match, "p1")["revealed"]
    assert_true(revealed.is_empty())
```

**Commit:** `feat(engine): view() — revealed re-checks live, never trusts a stale peek`.

### Task 25: `roundResult`/`matchWinnerId` — phase-gated and passthrough

**Test:** `roundResult` is `null` while `round.phase == "awaiting-play"` even if a caller pre-populated
`round["roundResult"]` by mistake (defensive, matching the TS ternary reading phase rather than the field's
mere presence); `matchWinnerId` passes straight through unconditionally, including `null`.

**Commit:** `feat(engine): view() — roundResult gated on phase, matchWinnerId verbatim`.

### Task 26: `publicLog`/`roundHistory` — identical for every viewer

**Test:** call `view()` for every seat in a round with a non-trivial `publicLog`/`roundHistory` and assert all
resulting arrays are `==` to each other — these two fields are "safe by construction" (peeks never enter
`publicLog`; `roundHistory` entries were already public while live), so the *only* bug this task can catch is
an accidental per-viewer filter added later.

**Commit:** `feat(engine): view() — publicLog/roundHistory identical across every seat`.

### Task 27: The forbidden-substring guard

**Files:** Create `godot/engine/redaction_guard.gd`, `godot/test/engine/test_redaction_guard.gd`.

Port `FORBIDDEN_SUBSTRINGS` as a blunt second line of defense that a field-by-field diff can still miss — a raw
`MatchState` value smuggled into an unexpected key would pass every per-field test above (none of them scan
*every* key) but still fail this one.

```gdscript
class_name RedactionGuard

## A view that ever serializes to a string containing one of these has leaked
## server-only state, full stop — independent of which key it hid under.
const FORBIDDEN_SUBSTRINGS: Array[String] = ["deckOrder", "setAsideFaceDown", "\"rng\"", "\"seed\"", "actionLog", "privateKnowledge"]

static func assert_clean(view_dict: Dictionary) -> void:
    var serialized: String = JSON.stringify(view_dict)   # [uncertain/post-cutoff] — JSON.stringify's exact
                                                            # signature is not re-verified against 4.7 docs
                                                            # this session; confirm before relying on it in CI.
    for substring in FORBIDDEN_SUBSTRINGS:
        assert(not serialized.contains(substring), "view() leaked a forbidden substring: %s" % substring)
```

**Test:** run `RedactionGuard.assert_clean` over `View.view(match, seat)` for every seat in every corpus match
(R0.3) — this is the task-set's actual gate, not a hand-built fixture, because a hand-built fixture only proves
the guard *can* fire, not that a real reachable state never trips it.

**Commit:** `feat(engine): forbidden-substring guard over every corpus view frame`.

---

## 10. Replay from `{seed, actionLog}`

`replayMatch` (persistence.ts:230-249) is the corpus's actual entry point — every other task above is
exercised *through* this function once Task 28 lands, because a corpus match is exactly `{seed, matchId,
playerIds, actionLog}` (R0.1) fed through it. Note it is `src/server/persistence.ts`, not
`src/game/engine/`: production room recovery is doc 6's domain (the sqlite store around it, the reaper, the
resume flow), but `replay_match` itself is pure engine composition and belongs here so the corpus can call it
without depending on anything doc 6 hasn't built yet.

**R10.1** — `actionLog` records `PLAY_CARD` actions only. Round boundaries are never logged, because
`start_next_round` is deterministic from state alone — the replay loop re-derives every round transition
itself, calling `start_next_round` whenever `round.phase == "round-over"` and the match isn't decided, before
applying the next logged action.

### `godot/engine/replay.gd`

```gdscript
class_name Replay

## Rebuilds a MatchState by folding actionLog through the real engine,
## starting from create_match(playerIds, seed, matchId). null on any
## divergence — an action past a decided match, or one reduce() rejects —
## so the caller (doc 6's room recovery) can quarantine the row instead of
## trusting a corrupt log. persistence.ts:230-249.
static func replay_match(player_ids: Array, seed: String, match_id: String, action_log: Array):
    var state := Setup.create_match(player_ids, seed, match_id)

    for action in action_log:
        if state["round"]["phase"] == "round-over":
            if state["matchWinnerId"] != null:
                return null   # actions logged after a decided match: corrupt
            state = RoundLifecycle.start_next_round(state)
        var result := Reduce.reduce(state, action)
        if not result["ok"]:
            return null       # corrupt log — caller quarantines
        state = result["state"]

    return state
```

### Task 28: The corpus replay test — Stage 3's actual gate

**Files:** Create `godot/test/engine/test_corpus_replay.gd`.

This is the task the whole document has been building toward, and it is the one that must run against **every**
file doc 3 emits, not a sample:

```gdscript
func test_every_corpus_match_replays_frame_for_frame() -> void:
    var dir := DirAccess.open("res://test/corpus/")
    for file_name in dir.get_files():
        var corpus: Dictionary = _load_json("res://test/corpus/%s" % file_name)
        var final_state = Replay.replay_match(corpus["playerIds"], corpus["seed"], corpus["matchId"], corpus["actionLog"])
        assert_not_null(final_state, "replay diverged on %s" % file_name)

        for player_id in corpus["frames"].keys():
            var recorded_frames: Array = corpus["frames"][player_id]
            # Re-derive each frame by replaying up to that point and calling
            # view() — doc 3's exact harness shape governs this loop; sketch
            # only, see R0.1.
            var replayed_frames := _rebuild_frames(corpus, player_id)
            assert_eq(replayed_frames.size(), recorded_frames.size(), "%s frame count, seat %s" % [file_name, player_id])
            for i in range(recorded_frames.size()):
                assert_eq(replayed_frames[i], recorded_frames[i], "%s frame %d, seat %s" % [file_name, i, player_id])
                RedactionGuard.assert_clean(replayed_frames[i])
```

`_rebuild_frames` is the one piece of scaffolding this test needs that isn't a pure engine function — it must
call `view()` after every `reduce()`/`start_next_round()` in exactly the order the TS harness (doc 3) did, so
its shape depends on doc 3's actual recording discipline. Write it once doc 3's harness is read, not guessed at
here.

**Commit:** `test(engine): corpus replay — every recorded match, every seat, every frame`.

---

## 11. Determinism reminder

**R11.1** — `Setup.deal_round`/`Setup.create_match` call `Rng.seed_rng`/`Rng.shuffle` from `godot/engine/rng.gd`
(Stage 1) — they do **not** reimplement any part of mulberry32 or FNV-1a. `match["rng"]` threads continuously
across every round in a match, from the single `seed_rng(seed)` call inside `create_match`, through every
`deal_round` call `start_next_round` makes — never re-seeded (master §6.3, doc 2 §"Background"). A port that
re-seeds per round from `seed + roundNumber` would pass every single-round test in this document and diverge
from round 2 onward on any multi-round corpus match — which is exactly why R0.3 requires the corpus to include
a match that reaches sudden death: sudden death cannot happen inside round 1, so a re-seeding bug is invisible
until a match runs long enough to need it, and this document's own Task 16/19/28 all touch multi-round matches
specifically because a single-round test would let that bug through.

If Stage 1 is not green, none of this document's determinism-dependent tasks (2, 16, 19, 28) can be trusted even
if they pass — a wrong-but-consistent shuffle would make the GDScript engine agree with *itself* while
disagreeing with the corpus in a way that could still coincidentally pass a hand-picked assertion. This is the
whole reason Stage 1 gates Stage 3 rather than merely preceding it (master §7).

---

## Definition of done for Stage 3

- Every file under `godot/engine/` listed in this document exists, and every task's test passes headless
  (`godot --headless -s addons/gut/gut_cmdln.gd -gdir=res://test/engine -gexit` exits `0` — doc 9 §3, gate 4 of
  the master plan).
- **Task 28 passes for every match file doc 3 emits**, not a sample — replaying `{seed, actionLog}` through
  `Replay.replay_match` reproduces the recorded `MatchState` transitions, and calling `View.view` after each
  reproduces every recorded per-seat `RedactedView` frame exactly, for every seat, in order.
- `RedactionGuard.assert_clean` passes on every one of those frames — no frame contains `deckOrder`,
  `setAsideFaceDown`, a raw `rng` or `seed` field, `actionLog`, or `privateKnowledge`, regardless of which key
  it might have been hiding under.
- The one flagged uncertainty (`Dictionary.duplicate(true)`'s deep-copy semantics, §1.2/Task 1) is resolved —
  either pinned by a passing test or replaced by a hand-written deep-copy — before it is relied on anywhere
  else in the tree.
- `godot/engine/` imports `godot/engine/rng.gd` from Stage 1 and reimplements no part of it (R11.1).

**Only when this is green does doc 5 (the AI port, which depends only on this stage — master §7) or doc 6 (the
server port, which depends on this stage's replay function specifically — master §9) begin.**
