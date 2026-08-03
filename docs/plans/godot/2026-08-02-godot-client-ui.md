# GDScript Client — Scenes, Store, Motion — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: use `superpowers:executing-plans` to implement this plan task-by-task.
> This is **Stage 5** (unstyled, playable) and **Stage 7** (theme/motion/Mule shader) of
> `2026-08-02-godot-full-rewrite-master-plan.md`. It assumes doc 6's GDScript server and wire are
> complete; it treats "a `ServerMessage` arrived" as a given input to the reducer.

**Goal:** Port `src/client/` (11,689 LOC — `store/`, `layout/`, `content/`, `ui/`, `styles/`) into a
Godot 4.7.1 client that speaks the frozen wire (§6.1), holds no game state (§6.6), and narrates, lays
out, and animates identically to the DOM client, held to the same conformance corpus (doc 3) the engine
is.

**Read first:** `src/client/store/types.ts:74-86` (`ClientState`), `store.ts:153-233` (the reducer),
`diff.ts:155-193`, `motion.ts` (whole file, 202 lines), `presentationQueue.ts`, `ui/beats.ts:1-70`
(header only), `layout/topology.ts` (whole file), `layout/tableLayout.ts:100-120` (`MAX_DISCARDS`),
master §6 (all six invariants), master §11 gates 2 and 3.

---

## 1. The state store

### 1.1 `ClientState` as an autoload

`types.ts:74-86` is the whole vocabulary — `screen` (`'menu'|'joining'|'lobby'|'table'|'fatal'`),
`connection` (`'connecting'|'open'|'reconnecting'|'closed'`), `matchId`, `seat`, `lobby`, `table`
(the latest `STATE_UPDATE`, held whole per `types.ts:59-72` — `view: RedactedView` plus `nicknames`,
`phase`, `paused`, `missingSeats`, optional `revealDeadline`, `serverTime`, and a locally stamped
`receivedAt` used only to age the server clock), `ended`, `pendingPlay`, `fatal`, `notices`.

**Port as an autoload singleton, not a `Resource`.** A `Resource`'s identity is file-backed and its
`.tres`/`.res` round-tripping invites the accidental persistence §1.3 forbids; an autoload is a plain
singleton with the same "one instance, constructed once" property `createStore` gives the DOM client.

```gdscript
class_name ClientState
extends RefCounted

var screen: String            # "menu"|"joining"|"lobby"|"table"|"fatal"
var connection: String        # "connecting"|"open"|"reconnecting"|"closed"
var match_id                  # String | null
var seat                      # {seat:int, player_id:String} | null
var lobby; var table; var ended; var pending_play
var fatal                     # String | null (ErrorCode)
var notices: Array

func duplicate_with(overrides: Dictionary) -> ClientState:
    var copy := ClientState.new()
    copy.screen = overrides.get("screen", screen)
    # ... one line per field. GDScript has no object-spread operator — this
    # function IS the `{ ...state, field: value }` spread, written once so
    # every reducer branch calls it instead of hand-copying seven fields and
    # eventually missing one.
    return copy
```

**R1.1** `duplicate_with` SHALL copy every field not named in `overrides` from `self` — a reducer
branch that forgets a field silently drops it, and unlike a TS object-spread typo this compiles either
way (Task 1.1 catches it). **R1.2** The store SHALL hold exactly one `ClientState` at a time, replaced
by `duplicate_with`, never mutated field-by-field — `store.ts:9-12`: "State is replaced, never
mutated... subscribers... can diff the old one against it," which is what lets `diffSnapshots` treat
`prev`/`next` as trustworthy snapshots rather than a moving target.

### 1.2 One message → one new state

`store.ts:153-233`'s `next(msg)` is a `switch` over eight `ServerMessage` types, returning either
`state` unchanged (a no-op the publisher won't broadcast) or a new object. Port as a GDScript `match`:

```gdscript
func _next(msg: Dictionary) -> ClientState:
    match msg.get("type"):
        "SEAT_CLAIMED":
            _tokens.save(msg.matchId, {...})   # persist BEFORE returning — store.ts:156-165
            return _state.duplicate_with({"screen": "lobby", "seat": {...}})
        "LOBBY_UPDATE": return _state.duplicate_with({"screen": "lobby", "lobby": _lobby_from(msg)})
        "MATCH_STARTED": return _state   # inert — per-seat view arrives separately (store.ts:175-179)
        "STATE_UPDATE": return _state.duplicate_with({"screen": "table", "table": _table_from(msg), "pending_play": null, "ended": ...})
        "MATCH_ENDED": return _state.duplicate_with({"ended": _ended_from(msg)})
        "ERROR": return _handle_error(msg)
        "FATAL": return _handle_fatal(msg)
        "PONG": return _state
        _:
            push_error("unhandled ServerMessage.type: %s" % msg.get("type"))
            return _state
```

**R1.3 — the default branch is load-bearing.** GDScript's `match` has no exhaustiveness check; TS's
`switch` over `ServerMessage` has none *either* here (`store.ts:154-232` has no `default`, because the
compiler already proves every case handled). A ninth wire message added without a ninth `case` is a
compile error in TypeScript and a silent no-op in GDScript unless this `_` branch exists and fails
loudly — the same class of gap `changing-the-wire` documents for `RedactedView` leaks, ported to the
reducer.

**R1.4 — FATAL is terminal.** `store.ts:245-250`:
```ts
apply(msg) { if (state.fatal !== null) return; commit(next(msg)); }
```
Port this guard *ahead of* the `match`, not after computing `_next` — `FATAL` is only ever `BAD_TOKEN`
or `SEAT_TAKEN` (`store.ts:23`) and the server closes the socket when it sends one, so anything after
is provably stale. Computing `_next` first and discarding it is wasted but harmless; publishing it
first is not — that flashes stale content to every scene before the guard catches it.

**Ported branches worth naming:** `SEAT_CLAIMED` persists the token before returning (ordering
matters — a subscriber reading storage must not race the write); `ERROR` routes to `screen: 'fatal'`
only when `msg.code` is in `DEAD_END_CODES` (`ROOM_NOT_FOUND`, `ROOM_FULL`, `MATCH_OVER`) **and**
`state.table === null` (`store.ts:209-211`) — the same code answering a late play from someone already
watching the table is a toast, not a wall; `FATAL` with `BAD_TOKEN` clears the seat and returns to
`joining` (a bad link is a retry, not a wall — UIX §5), every other code keeps the token since
`SEAT_TAKEN`'s "Take over here" needs it to reconnect with.

### 1.3 §6.6 — the client holds no game state

The view IS the state. **R1.5** No file outside `client/store/` SHALL cache a derived game fact — "it's
my turn," "this card is playable" — across frames. Every scene's `update(state)` SHALL recompute such
facts from `state.table.view` on every call, exactly as `table.ts` recomputes `RenderPlan` from
`RedactedView` on every `draw()`, never diffing against what it drew last time. A `var _is_my_turn: bool`
set once in `_ready()` is the bug: nothing invalidates a plain GDScript field when an opponent's turn
changes it. This survives as discipline, not as an enforced test (§1.4 gets partway there for the pure
layer only).

### 1.4 Tasks

**Task 1.1 — `ClientState` + `duplicate_with`.** Test: `duplicate_with({"screen":"table"})` changes
only `screen`, copies every other field by value. Commit: `feat(client): ClientState value type (R1.1)`.

**Task 1.2 — The reducer, branch by branch.** Failing test per `ServerMessage` type first (port
`store.test.ts`'s cases), then the branch, covering the three orderings called out above. Commit per
branch or in one: `feat(client): port the ClientState reducer`.

**Task 1.3 — FATAL-terminal guard + queued publication.** Test the guard (R1.4) and port `store.ts:113-130`'s
queued-not-recursive `commit`: a listener calling back into the store mid-broadcast must not let a
later listener skip a state. Commit: `feat(client): FATAL-terminal + queued publication (R1.4)`.

**Task 1.4 — Default-branch loud failure + purity guard.** Test an unknown `msg.type` triggers
`push_error` (R1.3). Add a text-scan test over `client/store/*.gd`, `client/layout/*.gd`,
`client/content/*.gd`, `client/tokens/*.gd` failing on `get_node(`, `get_tree(`, `Input.`, or any
`Control`/`CanvasItem` subclass reference — the GDScript-text-scan stand-in for `purity.test.ts` (no
static-analysis tool assumed available), scoped to the same four directories `adding-to-the-pure-layer`
names. Commit: `test(client): reducer exhaustiveness + purity guard for the four pure dirs`.

---

## 2. The surface contract, ported

### 2.1 `mount`/`update`/`destroy` → `_ready`/`update(state)`/`queue_free`

`ui/surface.ts:12-29`:
```ts
export interface Surface { mount(parent: HTMLElement): void; update(state: ClientState): void; destroy(): void; }
```
GDScript has no `interface` keyword — every scene honours the contract by convention:
`_ready()` constructs child nodes (never reads `ClientState` — a scene mounts before its first
`update`); `update(state)` is the only path a scene learns of a change; `_exit_tree()` releases
tweens/timers. **R2.1** No surface SHALL read the store directly — enforced by review and Task 2.4, not
by the language, since Godot has no ambient-global ban the way `purity.test.ts` gives the DOM client.

**Pointer-events is inverted from the DOM.** `ui.css`'s `#ui-root > *` rule exists because DOM elements
are click-through by default and the chrome must punch holes for the table beneath. Godot's
`Control.mouse_filter` defaults to `MOUSE_FILTER_STOP` — the opposite default. **R2.2** A decorative
Control that should let clicks fall through SHALL set `mouse_filter = MOUSE_FILTER_IGNORE` explicitly.
Getting this backwards presents as "the table stopped responding to clicks" behind an invisible
full-screen Control — the same symptom class `uiRoot.ts` exists to prevent, now from the opposite
default.

### 2.2 The ~21-scene inventory

One Godot scene per DOM surface (client-anatomy research §5); `clipboard.ts`/`ids.ts` evaporate
(master §4 — `DisplayServer.clipboard_set`/`Crypto` have no secure-context caveat):

| Scene | Ports | Purpose |
|---|---|---|
| `action_sheet.tscn` | `actionSheet.ts` | Play panel; renders `legalTargets`, decides no rule |
| `beats.gd` (no scene) | `beats.ts` | Executes `motion_plan()` into a transient layer (§5) |
| `card_hint.tscn` | `cardHint.ts` | Hover tooltip; enhancement only |
| `connection_dot.tscn` | `connectionDot.ts` | `ConnectionStatus` indicator |
| `deal_cues.gd` | `dealCues.ts` | One cue per dealt card, on `motion.gd`'s stagger |
| `elimination_notice.tscn` | `eliminationNotice.ts` | "You are out, and why" — own scene, derived from durable `alive`+log so a reconnect still shows it |
| `fatal_screen.tscn` | `fatalScreen.ts` | Terminal wall on `state.fatal`; always carries an action |
| `icons.gd` | `icons.ts` | `Texture2D`/`Theme` icon set (no inline-SVG-as-DOM equivalent) |
| `join_screen.tscn` | `joinScreen.ts` | Nickname entry, validated client-side (§8) |
| `lobby_screen.tscn` | `lobbyScreen.ts` | `LOBBY_UPDATE` verbatim, rebuilt wholesale |
| `menu_screen.tscn` | `menuScreen.ts` | Host/join; mints seat, persists token before navigating |
| `overlays.tscn` | `overlays.ts` | Round/match-over/paused — one scene, defined precedence |
| `reference_dock.tscn` | `referenceDock.ts` | Card reference / match log tabs |
| `seat_dossier.tscn` | `seatDossier.ts` | Per-seat detail; reads `discardPile` only, never `hand` |
| `sound.gd` | `sound.ts` | Audio bus graph — the "how", not the "what" |
| `sound_toggle.tscn` | `soundToggle.ts` | Mute toggle; default unmuted, unlocks on first gesture |
| `table.tscn` | `table.ts` | Consumes `compute_layout`+`build_render_plan`, decides nothing (§3) |
| `toasts.tscn` | `toasts.ts` | One live-announcement region, strict order |
| `ui_root.tscn` | `uiRoot.ts` | Owns the pointer-pass-through contract (R2.2) |

### 2.3 Tasks

**Task 2.1 — `ui_root.tscn` pointer contract (R2.2).** Test the default blocks a click through a
decorative child; test `MOUSE_FILTER_IGNORE` lets it through. Commit:
`feat(client): UiRoot pointer-pass-through (R2.2)`.

**Task 2.2 — Chrome scenes, one at a time.** For each row above except `table.tscn` (§3) and `beats.gd`
(§5): scene + `update(state)` + a test asserting node text/visibility/`accessibility_name` against a
`ClientState` fixture (no DOM to snapshot — assert structure, not pixels). Order cheapest-first:
`connection_dot`, `toasts`, `fatal_screen`, `menu_screen`, `join_screen`, `lobby_screen`,
`sound_toggle`, `card_hint`, `seat_dossier`, `reference_dock`, `action_sheet`, `elimination_notice`,
`overlays`. One commit per scene: `feat(client): port <scene> from ui/<file>.ts`.

**Task 2.3 — Single subscriber + conformance guard.** `main.gd` registers exactly one callback that
calls `update(state)` on every mounted scene in fixed order (test: two scenes, one state change, each
updated exactly once). Add the `tableContract.test.ts`-style text-scan asserting every scene declares
`update` and reads state only via its parameter. Commit:
`feat(client): single-subscriber composition root + conformance guard`.

**Task 2.4 — Accessibility smoke pass.** Every mounted scene: every `Control` with
`focus_mode != FOCUS_NONE` has a non-empty `accessibility_name` [verified 4.5+, `Control` props
confirmed in 4.7]. Weaker than `axe.test.ts` by design (master §11 gate 2) — presence-of-name only, no
tree/contrast check — and that weakness is accepted, not hidden. Commit:
`test(client): accessibility-name coverage sweep`.

---

## 3. Layout: decisions kept, pixels discarded

### 3.1 Topology as a rule both eras agree on

`layout/topology.ts` in full is 43 lines and ports near-verbatim:

```gdscript
class_name Topology
const PORTRAIT_MAX_ASPECT := 0.9
const MIN_WIDE_HEIGHT := 560.0

static func classify(w: float, h: float) -> String:
    if w / h < PORTRAIT_MAX_ASPECT: return "portrait"
    return "landscape-narrow" if h < MIN_WIDE_HEIGHT else "wide"
```

`topology.ts:14-31`'s own comment records *why* height, not aspect, splits the landscape classes: a
rotated phone (844×390, aspect 2.16) misclassifies as `wide` under pure aspect; a 4:3 desktop window
(aspect 1.34) misclassifies as `landscape-narrow`. That's a fact about device proportions, not
TypeScript, so it survives unchanged. `get_viewport_rect().size` supplies the same two numbers
`window.innerWidth`/`innerHeight` did. Held to the corpus: doc 3 asserts classification for a fixed
`(w,h)` sample including both adversarial cases.

### 3.2 `Container` nodes replace hand-rolled `Rect`s

Godot's `VBoxContainer`/`HBoxContainer`/`GridContainer`/`MarginContainer`/`AspectRatioContainer`
[stable API, not freshly re-verified this session — §5 in the Godot research] auto-place children,
which is the *opposite* discipline from "geometry is data, the renderer only obeys it"
(AGENTS.md) — a Container **is** a renderer that also decides.

**R3.1** The port SHALL keep the decision layer (topology, discard-row count, hand-slot layout) as pure
functions returning a `LayoutSpec`-shaped `Dictionary`, mirroring `computeLayout`. `table.gd` SHALL
configure `Container` properties (`custom_minimum_size`, separation, `size_flags_*`) *from* that data —
a Container deciding its own child placement independently is the Godot-native version of the bug
AGENTS.md documents ("every visual bug this table has shipped was that rule being broken"). **R3.2**
Where a genuine pixel rect is needed (the oval table composition no stock Container expresses), use
explicit anchors/offsets driven by the pure layer, not a Container.

### 3.3 The discard reserve is eight — proven by corpus, not hoped for

Master §6.4, restated: `discardCapacity.test.ts` (`tableLayout.ts:119`) drives thousands of real
matches through the *engine* to prove the worst single-seat discard pile is **8**, not the 7 the design
doc states — a 2-player round's 5 own-turn discards + 2 Prince-forced discards + 1 elimination reveal.
The test is two-sided: `toBeLessThanOrEqual(8)` at every player count *and* `toBe(8)` exactly for the
2-player sweep, proving the bound is tight, not merely safe.

**A `VBoxContainer` sized to "however many discards look right" cannot discover this number** — it has
no way to ask the engine its own worst case, because the fact lives in game rules, not layout code. It
will render 7 correctly for months and clip on the one match in a thousand that reaches 8.

**R3.3** `discard_capacity.gd`'s sweep SHALL be ported from `discardCapacity.test.ts`'s method
(`autoAction` sweeping legal-play choice index, not always-first — picking-first under-explores
forced-discard chains) and run against the **same conformance corpus** doc 3 generates, not a fresh
GDScript simulation. `MAX_DISCARDS := 8` SHALL be a named constant, and every discard-row's reserved
slot count SHALL derive from it, never a literal typed a second time.

### 3.4 Tasks

**Task 3.1 — `Topology.classify` + `LayoutSpec`.** Test the two adversarial cases and the boundary
values (`w/h == 0.9`, `h == 560`). Port `computeLayout`'s decision tree as pure data, no `Control`
reference in the file, held to the purity guard (§1.4). Commit:
`feat(client): port topology + LayoutSpec (decisions, no Nodes)`.

**Task 3.2 — `table.gd` contract guard.** Text-scan test (mirroring `tableContract.test.ts`) that every
`LayoutSpec` field is referenced in `table.gd`, with a short, argued `NOT_DRAWN` allowlist — carrying
forward the specific lesson its docstring records: a nickname scrim reading `nameBandH` but letting
text metrics decide the actual height passed a naive version of this test and hid a real overlap.
Commit: `test(client): table.gd contract guard`.

**Task 3.3 — Discard capacity, corpus-driven (R3.3).** Failing test first: the sweep over the corpus's
recorded matches reaches exactly 8 at 2 players, never exceeds 8 at 3/4. Wire `MAX_DISCARDS` into every
discard-row reservation. Commit: `feat(client): discard capacity proven against the corpus (master §6.4)`.

---

## 4. The presentation pipeline, ported as concepts

### 4.1 `diff.ts` — near 1:1, pure, `prev == null → []`

No DOM dependency, so it ports closest to verbatim of anything here. `diffSnapshots(prev, next)`
(`diff.ts:155-193`) computes, in order: appended `publicLog` entries, draws (exit-before-enter), peek
gain/loss, round/match transitions.

**R4.1** `prev == null → []` SHALL be preserved exactly — `diff.ts:146-153`: a reconnecting/first-load
player should see the table as it stands, not a replay of every beat that happened while absent. A
GDScript port that diffs against a zero-valued `Dictionary` instead of checking for an explicit null
reintroduces this bug through a different door.

**R4.2** The own-vs-opponent draw asymmetry (`diff.ts:17-28`) SHALL be preserved: an opponent's
`card-drawn` event carries a seat id and no `cardTypeId`, because `RedactedView` never reveals another
seat's hand — a redaction fact, not a UI convenience. "Helpfully" filling in `cardTypeId` for every draw
moves the leak class `changing-the-wire` exists to prevent from the wire into the presentation layer.

**R4.3** Opponent-draw detection SHALL stay `alive`-based, not `deckCount`-based (`diff.ts:93-114`'s
`holdsCard`) — a Darell (Prince) redraw takes a card from the deck for a player who isn't the one whose
turn began, so attributing every `deckCount` drop to "the current player drew" is wrong on exactly that
card.

### 4.2 `motion.ts` — the policy is data; only the executor rewrites

The whole 202-line file — `BeatName`, `StepKind`, `MotionStep`/`MotionPlan`, the `FULL` table (9 beats),
`beatForEvent`, `dealDelayMs`/`dealSequenceMs`, the reduced-motion collapse — ports **verbatim as a
GDScript data table**, since none of it touches WAAPI. Only `ui/beats.ts` (§5) is a full rewrite.

```gdscript
class_name Motion
const QUICK_MS := 300
const DEAL_MS := 260
const DEAL_STAGGER_MS := 40
const DEAL_STAGGER_CAP := 6
const FULL := {
    "elimination": [{"kind":"banner","duration_ms":200}, {"kind":"desaturate","duration_ms":500}, {"kind":"flip","duration_ms":300}],
    "mule": [{"kind":"ripple","duration_ms":600}, {"kind":"loom","duration_ms":1200}, {"kind":"banner","duration_ms":200}, {"kind":"desaturate","duration_ms":500}, {"kind":"flip","duration_ms":300}],
    # peek, play, deal, token-award, victory, countdown-tick copied 1:1 from motion.ts:110-135
}
const INFORMATIONAL := ["countdown-tick"]   # reduced motion must NOT touch these (motion.ts:102-108)

static func deal_delay_ms(index: int) -> int:
    return clampi(index, 0, DEAL_STAGGER_CAP) * DEAL_STAGGER_MS

static func motion_plan(beat: String, reduced_motion: bool) -> Dictionary:
    if reduced_motion and not INFORMATIONAL.has(beat):
        return {"steps": [{"kind": "fade", "duration_ms": 150}]}
    return {"steps": FULL[beat]}

static func beat_for_event(event: Dictionary) -> String:
    match event.kind:   # exhaustive over PresentationEvent.kind — motion.ts:160-202
        "log":
            if event.entry.kind == "PLAY": return "play"
            if event.entry.kind == "ELIMINATED":
                return "mule" if event.entry.cause in ["mule-voluntary", "mule-forced"] else "elimination"
            return ""
        "peek-gained": return "peek"
        "card-drawn": return "deal"
        "peek-lost": return ""
        "round-over": return "token-award"
        "match-over": return "victory"
        _:
            push_error("unhandled PresentationEvent.kind: %s" % event.kind)
            return ""
```

**R4.4** `beat_for_event`'s exhaustiveness SHALL be tested with one case per `PresentationEvent.kind`,
since GDScript's `match` can't enforce it at compile time. `motion.ts:151-154` names the exact failure:
"an event that computes a beat and then gets dropped is invisible... exactly how the private peek
shipped doing nothing at all."

### 4.3 `presentationQueue.ts` — `await Tween.finished` replaces WAAPI promises

`createPresentationQueue` (`presentationQueue.ts:31-59`) chains steps on a promise tail so `announce`
fires only after `animate` settles. GDScript's `await tween.finished`
[verified — `Tween.finished` signal, `a315258f2d48ce88e.md` §6] is the direct replacement:

```gdscript
class_name PresentationQueue
extends RefCounted
var _running := false
var _pending: Array[Dictionary] = []

func enqueue(step: Dictionary) -> void:
    _pending.append(step)
    if not _running: _run_next()

func _run_next() -> void:
    if _pending.is_empty(): _running = false; return
    _running = true
    var step: Dictionary = _pending.pop_front()
    if step.has("animate"):
        var tween: Tween = step.animate.call()
        if tween != null: await tween.finished
    if step.has("announce"): _announce(step.announce)
    _run_next()
```

**R4.5** `announce` SHALL fire only after its `Tween` resolves, never before or in parallel — "the
accessible channel never runs ahead of the visible one." **R4.6** A failing `animate` step (a null/freed
Tween, a Callable error) SHALL NOT wedge the queue — port `presentationQueue.ts:34-40`'s reasoning
verbatim: "the thing being announced happened on the server whether or not it drew."

### 4.4 Tasks

**Task 4.1 — `Diff.diff_snapshots`.** Test against the corpus's recorded `RedactedView` frame pairs for
narration parity, plus explicit cases for `prev == null` (R4.1) and the draw asymmetry (R4.2, R4.3) —
a corpus sample might not happen to exercise the reconnect path. Commit:
`feat(client): port diffSnapshots (1:1, pure)`.

**Task 4.2 — `Motion` data table + exhaustiveness.** Test every `BeatName` has non-empty steps,
`INFORMATIONAL` beats survive reduced motion, `deal_delay_ms` matches the TS formula across a swept
range including negatives and >6, and one test per `PresentationEvent.kind` (R4.4). Commit:
`feat(client): port motion.ts as data + beatForEvent exhaustiveness`.

**Task 4.3 — `PresentationQueue` ordering (R4.5, R4.6).** Test strict ordering across two queued steps
and that a throwing `animate` Callable still lets `announce` fire and the queue continue. Commit:
`feat(client): PresentationQueue on Tween-based sequencing`.

---

## 5. Beats: the executor rewrite, and the invariants that survive it

`ui/beats.ts` (661 lines) is a full rewrite — WAAPI-specific by construction, unlike `motion.ts`. The
nine beats (`mule`, `elimination`, `peek`, `play`, `deal`, `countdown-tick`, `token-award`, `victory`,
plus the reduced-motion `fade` collapse) each become a GDScript function building a `Tween`.

### 5.1 Nothing animates forever

Master §6.5's Godot twin: **`Tween.finished` never fires for an infinitely-looping tween**
[verified, `a315258f2d48ce88e.md` §6] — the identical trap `beats.ts`'s header warns against for
`iterations: Infinity`. **R5.1** No `Tween` in `beats.gd` SHALL use `set_loops()` with no finite
argument. **R5.2** Any `await tween.finished` on a tween that could loop infinitely is a bug on sight —
the `await` never resumes, which reads as a hung beat with no error anywhere.

### 5.2 Beats own their own transient layer, never a live table node

`beats.ts:9-13`: `table.ts#draw()` calls `replaceChildren()` on every state update, so an animation
targeting a table element has its target ripped out mid-flight, and a WAAPI promise never rejects on
this — the beat hangs with no error. `table.gd` has the identical hazard (§3.1's R3.1: the renderer
recomputes its tree from `RenderPlan` on every `update`, never diffing against what it drew last).

**R5.3** `beats.gd` SHALL draw every beat into a dedicated transient `CanvasLayer` (`BeatLayer`) that
`table.gd` never touches, mirroring `planLayer` in the DOM client. **R5.4** No `tween_property()` call
SHALL target a `Node` owned by `table.gd`'s render tree — a beat that needs to appear to originate from
a table element (a card flying to the discard pile) SHALL snapshot that element's rect/texture into a
new node in `BeatLayer` and animate the copy, exactly as `beats.ts` already does.

### 5.3 4.7 Control offset transforms for Container-managed motion

Where a beat animates a node that lives *inside* a Container (a hand card in an `HBoxContainer`, a
shimmer riding a seat chip in a `GridContainer`) — not the table, which isn't Container-managed per
R3.2 — Godot 4.7's offset-transform properties are the tool, not `BeatLayer`, because the node should
stay in the layout tree while only its rendered position diverges temporarily.

[Verified via PR #87081 and the 4.7 class docs]: `offset_transform_enabled`,
`offset_transform_position/_rotation/_scale`, `offset_transform_pivot`/`_pivot_ratio`,
`offset_transform_visual_only` (defaults **true**) — added because pre-4.7, "any Container child
transform was destroyed the next time the container re-sorted children."

```gdscript
func _animate_card_lift(card: Control) -> Tween:
    card.offset_transform_enabled = true
    # visual_only=true (default): hover/focus hit-testing keeps using the
    # untransformed rect while the card visually lifts — the Container-managed
    # analogue of "never lose accessibility mid-beat."
    var tween := create_tween()
    tween.tween_property(card, "offset_transform_position", Vector2(0, -12), 0.15)
    tween.tween_property(card, "offset_transform_position", Vector2.ZERO, 0.15)
    return tween
```

**R5.5** `offset_transform_visual_only` SHALL stay at its default (`true`) for every beat animating a
Container-managed node — none of the nine beats needs the animated position to also be the click
target mid-flight. **R5.6** `get_offset_transform()`'s exact accessor name is
**[uncertain — low-confidence naming, not independently confirmed on the live class page]**: drive the
confirmed `offset_transform_*` properties directly rather than reading a computed transform back.

### 5.4 The Mule's ripple, without a displacement filter — until §6

`beats.ts`'s header explains the DOM original does *not* literally warp the table: no cheap way exists
to rasterize live HTML for a filter to distort. Its substitute — portrait shudder, full-viewport wash,
compositor-safe table-root shudder, run concurrently — is a **workaround for a missing capability**,
not a design preference (`docs/plans/typescript/2026-07-30-renderer-architecture-research.md` §8).
`shaders/distortion_map.png` stays unused by design in that version. §6 is where Godot removes the
constraint that forced this substitute in the first place; this section is the Stage-5 fallback,
still needed for parity before the shader exists.

### 5.5 Tasks

**Task 5.1 — `BeatLayer` isolation (R5.3, R5.4).** Test: two `table.gd#update()` calls leave
`BeatLayer`'s children untouched. Text-scan guard (Task 2.3's technique) failing if `beats.gd`
references a `table.gd`-owned node. Commit: `feat(client): BeatLayer isolated from table.gd's redraw`.

**Task 5.2 — The eight non-shader beats.** `elimination`, `peek`, `play`, `deal`, `countdown-tick`,
`token-award`, `victory`, and the Mule fallback triad (§5.4) — one `Tween`-building function each,
driven by `motion_plan()`'s steps, tested against total duration matching `beat_duration_ms`. Include
the `countdown-tick`-survives-reduced-motion case explicitly (R4.4's `INFORMATIONAL` set). Commit per
beat or in one: `feat(client): port eight of nine beats onto Tween`.

**Task 5.3 — Infinite-loop guard (R5.1, R5.2).** Text-scan test over `beats.gd` for unbounded
`set_loops()`. Commit: `test(client): no beat may loop infinitely`.

---

## 6. The Mule beat, recovered: `SubViewport` displacement on the live table

Master §3.3 doesn't name this, but it's the clearest example of a capability the DOM client was
**denied by its platform**, not by design taste — read §5.4 again: the non-displacement substitute
exists *because* "a DOM table grants no surface to warp," not because a warped live table was rejected
on its merits.

### 6.1 The mechanism

[General feasibility: **verified** — "nothing about 4.7 changes or restricts this pattern." The exact
2D displacement recipe is **[uncertain/standard-not-verbatim]** — the fetched docs confirmed the
underlying viewport-texture-as-shader-input principle but not a copy-paste 2D worked example.]

Render the table's `Control` tree into a `SubViewport`; display its texture via a
`SubViewportContainer`; apply a `canvas_item` `.gdshader` material to it that offsets UV lookups for a
ripple — the same pattern Godot's screen-reading-shaders tutorial demonstrates for reproducing
back-buffer sampling with a dedicated Viewport instead of `SCREEN_TEXTURE`.

```glsl
// client/shaders/mule_ripple.gdshader — shape only; math is
// [uncertain/standard-not-verbatim] and MUST be tuned against gate 3, not shipped as-is.
shader_type canvas_item;
uniform float strength : hint_range(0.0, 0.05) = 0.0;   // driven by a Tween, 0 at rest
uniform float time_offset = 0.0;

void fragment() {
    vec2 offset = vec2(sin(UV.y * 40.0 + time_offset), cos(UV.x * 40.0 + time_offset)) * strength;
    COLOR = texture(TEXTURE, UV + offset);   // procedural ripple, not distortion_map.png
}
```

**R6.1** The filter region SHALL be set explicitly, not left to the node's default bounding rect
**[flagged — not independently re-verified this session; confirm against the live 4.7 shader docs]** —
a `SubViewportContainer` smaller than the table it hosts clips the ripple into a rectangular seam.
**R6.2** `strength` SHALL be driven by a *finite* `Tween` (R5.1's rule applies to shader uniforms too),
ramping 0→peak→0 across the `ripple` step's 600ms (`motion.ts`'s `FULL.mule[0]`), never left non-zero
after the beat — a resting ripple reads as a rendering bug, not dread. **R6.3** `SubViewport.update_mode`
SHOULD be `UPDATE_WHEN_VISIBLE` outside an active Mule beat, switching to continuous only while
`strength` is non-zero — rendering the whole table offscreen every frame for a mostly-static game is
unneeded GPU/battery cost on the native-first target (master §3.3).

### 6.2 This is gate 3 — a spike, not a foregone conclusion

Master §11 gate 3: does the displacement read as *dread* rather than *effect*? It blocks Stage 7 only —
Stage 5 ships complete and playable on §5.4's fallback. **R6.4** Before the shader replaces the
fallback, a human SHALL watch both side by side and confirm the shader reads as *worse dread*, not
merely *different* — `designing-an-effect`'s standing question applies at full force, since a
`SubViewport` warp is the single most technically impressive thing this client can do, and
impressiveness is not the bar.

### 6.3 Tasks

**Task 6.1 — `SubViewport` scaffold, unshaded.** Wire the table through `SubViewport` +
`SubViewportContainer`; verify identical rendering and input routing to before. Commit:
`feat(client): render table into SubViewport (no shader yet)`.

**Task 6.2 — The ripple shader (gate 3 spike).** Implement `mule_ripple.gdshader`, wire `strength` to a
`Tween` (R6.2), set `update_mode` per R6.3. Not a TDD task — record the human verdict (R6.4) in the
commit message. Commit: `feat(client): Mule ripple shader on the live table (gate 3 spike)`.

**Task 6.3 — Edge-clipping check (R6.1).** Manual: resize across all three topologies with the ripple
active, confirm no seam at the container edge. Fix-commit if needed.

---

## 7. Accessibility and focus

[`accessibility_name`/`_description`/`_controls_nodes`/`_described_by_nodes`/`_labeled_by_nodes`/
`_flow_to_nodes`/`_live` are documented `Control` properties in 4.7 — verified. AccessKit itself landed
in **4.5**; a 4.7 project inherits it, doesn't newly gain it.]

**R7.1** Every interactive `Control` SHALL set `accessibility_name` to the **same string** the DOM
client's `aria-label` carried. `table.ts:917-921`'s `handAccessibleName`:
```ts
function handAccessibleName(card: HandCardPlan): string {
    const copy = cardCopyFor(card.cardId);
    return `${copy.value} · ${copy.displayName}${card.playable ? ', playable' : ''}${card.caption === null ? '' : `, ${card.caption}`}`;
}
```
Port this exact composition function — it's already DOM-agnostic — rather than writing an
independent "good enough" label; per-control accessible names aren't corpus content, so sharing the
function is what keeps the two eras from drifting apart on copy nothing else checks.

### 7.2 A forbidden card is disabled WITH its reason, never merely greyed

`table.ts:931-939`, quoted because it's the rule: the DOM client uses `aria-disabled`, **never** the
native `disabled` property, because "a native `disabled` button cannot be focused, clicked, or
activated by keyboard at all, which would silently take that reading path away from the one situation
it matters most" — reading what a card does while it's *not* your turn.

**R7.2** A forbidden hand card SHALL stay `focus_mode = FOCUS_ALL` and activatable in Godot too — never
`Button.disabled = true`. **R7.3** Dim it via `modulate` (never a layout change) and attach the reason
via `content/playability.ts`'s three-reason vocabulary ported verbatim (`accessibility_described_by_nodes`
is the Godot analogue of `aria-describedby`, mirroring `table.ts:941-945`). The three reasons — not
your turn / another card forces itself / playable but nothing to aim at — are exhaustive by design;
`playability.ts`'s own header records the regression collapsing them caused: "off-turn it announced
'every other player is protected or eliminated' — a rule of the game, stated to a player for whom it
was simply not their turn."

### 7.3 Real focus order

**Godot auto-focuses nothing** [verified — `grab_focus()` must be called explicitly]. **R7.4** Every
scene in §2.2 SHALL `grab_focus()` its natural first control on becoming active. **R7.5**
`focus_neighbor_left/right/top/bottom` [verified] SHALL be set explicitly wherever automatic geometric
neighbor-finding picks the wrong control — the hand row is the canonical case: arrow keys should move
strictly along the row, not jump to a geometrically-closer seat chip above it. **R7.6**
`focus_behavior_recursive` [verified present but **flagged young in 4.7** — still being hardened per
PR #105293, `grab_focus()` didn't initially respect it] MAY gate a container's descendants but SHALL be
tested per use, not trusted blind.

### 7.4 AccessKit-on-web is unverified — gate 1

**[Uncertain — no official statement found either way; the one forum post is speculation, not
confirmation.]** Master §11 gate 1 blocks the web target only. **R7.7** This section's work targets
native builds; if web export is attempted, accessibility SHALL be re-verified with a real screen reader
— AccessKit's model is OS-native-adapter-based (UIA/AX-API/AT-SPI2), with no obvious in-browser
equivalent, so the properties existing on `Control` proves nothing about a browser's AT tree.

### 7.5 Tasks

**Task 7.1 — `handAccessibleName` + playability vocabulary.** Test exact string composition against
fixtures (forced-play, off-turn, fizzle-warning) matching the ported TS output. Commit:
`feat(client): port handAccessibleName and playability reasons`.

**Task 7.2 — Forbidden cards stay focusable (R7.2, R7.3).** Test: `focus_mode == FOCUS_ALL` and the
`pressed` signal fires on a forbidden card; `Button.disabled` is never set. Commit:
`feat(client): forbidden cards stay focusable, not disabled`.

**Task 7.3 — Focus chain + per-scene accessibility-name coverage.** Test `focus_neighbor_right` chains
correctly across N hand cards (R7.5); extend Task 2.4's sweep per-scene. Commit:
`feat(client): explicit focus chain + per-scene accessibility coverage`.

**Task 7.4 — Manual VoiceOver/TalkBack pass.** Not automatable — master §11 gate 2 trades the DOM's
automated sweep for this. Run on hardware before Stage 7 is called done; record findings as follow-up
tasks, not a commit.

---

## 8. Text: `LineEdit` and `RichTextLabel`

**R8.1** The nickname field SHALL be a `LineEdit` [confirmed stable API] with `max_length` read from
the same `MAX_NICKNAME_LENGTH` doc 6's ported server config owns — `nickname.ts:1-13`'s documented
exception ("pure directories never import server runtime," except `config.ts`, which has zero imports
and bundles to a few bytes) carries forward: `client/content/nickname.gd` reads the constant from doc
6's config, never a re-typed literal that can drift.

**R8.2** Validation SHALL run client-side on every `text_changed`, via a ported `validate_nickname` —
trim, then the same three refusals in order (`empty`, `too-long`, `control-char`), length measured
*after* trimming. **The point (`nickname.ts`'s header, verbatim): `MALFORMED` never round-trips** — an
invalid nickname fails the *whole* `CLAIM_SEAT` frame server-side, costing the seat, so catching it
client-side isn't a UX nicety, it's what keeps a typo from burning a claim attempt.

**R8.3** Card rules, quick-reference, and match-log narration SHALL render via `RichTextLabel` with
`bbcode_enabled = true` [confirmed stable API], consuming the same plain strings `content/` produces
(§9) — the content module stays platform-agnostic; only the rendering surface picks BBCode vs. HTML.

### Tasks

**Task 8.1 — `LineEdit` + validation (R8.1, R8.2).** Test: typing past `max_length` is refused before
validation runs; a control character surfaces the `control-char` problem to the error label. Commit:
`feat(client): nickname LineEdit with client-side validation`.

**Task 8.2 — `RichTextLabel` rendering.** Test a fixture card's BBCode-parsed text matches the plain
content `cardCopy.ts` would have produced with tags stripped. Commit:
`feat(client): RichTextLabel rules/reference/log rendering`.

---

## 9. Content as pure functions

The 13 `content/` modules port as GDScript static functions, held to the corpus for narration parity —
one of the task's stated done-criteria:

`announce.gd` (exhaustive `PresentationEvent → line-or-silence`; its own header names the bug the
`never`-default guards against — a peek-gained event computed and then silently unhandled, "the private
peek shipped doing nothing visible at all"), `cardCopy.gd`, `countdown.gd` (from server-owned
`revealDeadline`/`serverTime` only — never a local clock), `difficulty.gd`, `elimination.gd` (built only
from the viewer's own `RedactedView`), `failureCopy.gd` (exhaustive `ErrorCode` map), `matchLog.gd`,
`narration.gd`, `nickname.gd` (§8), `playability.gd` (§7.2), `portraits.gd` (trivial — assets are reused
verbatim per doc 8), `quickReference.gd`, `rules.gd` (match-size-dependent devotion target, derived from
`RedactedView`).

**R9.1** Every module SHALL be held to the corpus's narration fixtures — for a fixed `(prev, next)`
`RedactedView` pair and its known `PresentationEvent[]`, GDScript output SHALL match TS output
byte-for-byte. **R9.2** None of these 13 files SHALL touch a `Node`, `Control`, or `get_tree()` — the
same `PURE_DIRS` boundary §1.4 enforces for `store/`/`layout/`/`tokens/`, extended to `content/` (all
four are `PURE_DIRS` in the DOM client's `purity.test.ts`).

### Tasks

**Task 9.1 — Content modules, corpus-first, grouped by dependency.** No-dependency group first
(`failureCopy`, `nickname`, `narration`, `elimination`); depends-on-`cardCopy`/`narration` group next
(`announce`, `playability`, `cardCopy`, `quickReference`, `rules`, `matchLog`); independent-low-risk
last (`countdown`, `difficulty`, `portraits`). Corpus fixture test before each implementation. Commit
per module or per group: `feat(client): port <module(s)> from content/, held to corpus`.

**Task 9.2 — Exhaustiveness + purity extension.** Per-variant tests for `announce.gd` and
`failureCopy.gd` (R4.4's pattern, both total functions over closed unions in TS). Extend the purity
guard (Task 1.4) to `client/content/*.gd` (R9.2). Commit:
`test(client): exhaustiveness guards + purity extended to content/`.

---

## Definition of done

**Stage 5 (unstyled, playable):** every task in §§1–4, 7–9 is green; §5's eight non-shader beats play
on `Tween` with the Mule fallback triad standing in for the shader; a human plays a full match to a
devotion-token win, unstyled, with real focus order and accessible names on every control (master §8's
own words); topology, narration, legality display, and discard capacity (=8) all assert against doc 3.
Master §11 gate 2 (trading an automated a11y gate for a manual one) SHALL be explicitly confirmed by the
owner *at this stage* — its own text says "before Stage 5 commits the surfaces," not Stage 7.

**Stage 7 (theme, motion, shader):** §6's shader has passed gate 3's human read (R6.4), or the fallback
ships instead and that's recorded, not silently reverted; doc 8's `.theme` resource is consumed without
a scene here hardcoding a color/font it's meant to own.
