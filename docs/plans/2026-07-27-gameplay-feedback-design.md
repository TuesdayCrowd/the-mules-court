# Gameplay feedback — plan and record

**Date:** 2026-07-27
**Source:** eleven items of playtest feedback, triaged against the code.
**Status:** eleven items plus two further rounds of feedback, shipped on branch
`gameplay-feedback` ([PR #30](https://github.com/TuesdayCrowd/the-mules-court/pull/30)).
One real-device pass outstanding.

This is both the plan the work followed and the record of what it found. The two are
one document on purpose: three of the defects fixed here were *already* described
correctly in a design doc and a test, and the thing missing was any record that the
description had never been honoured. A plan that does not say what happened is how that
recurs.

---

## 1. The feedback as reported

Verbatim, numbered for reference throughout.

1. Devotion tokens for other seats are hidden under their name as text grows with screen size.
2. The game needs to be more explicit about why `5` or `6` is unable to be played when you have `7` in your hand. What card 5 said when viewed:
   > 5 · Bayta Darell — Choose any player to discard their hand and draw a new card.
   > Not your turn — this is what the card does.
   > Every other player is protected or eliminated. This card will be discarded with no effect.
3. The Card Reference is missing the abilities for each card.
4. Card Reference should be allowed to stay visible while playing.
5. Viewing `1 - Informant` while not my turn did not have its context update when it became my turn.
6. Match log should be retained for at least the previous round. One suggestion was to have the match log for that round viewable by clicking on its devotion token.
7. Card abilities should show as hints when hovered over with mouse or pointer.
8. Increase time to 10 seconds from 5 between rounds.
9. When only one player is selectable, while playing a card such as `1 - Informant`, default to the only selectable player.
10. Match log should have an option to be always visible like `Card reference`.
11. Show card icon in card discard section on left of screen like how the icon is shown for the card an opponent just played on right of screen.

---

## 2. What triage found before any code changed

Three items turned out to be *already implemented and never drawn*. In each case the
pure layer is correct, a test asserts it, and `Court.ts` does not read the field.

**The forced-play sentence existed.** `renderPlan.ts`'s `dimCaption(view)` returns
`must play The First Speaker` and reaches `HandCardPlan.caption`;
`renderPlan.test.ts` asserts it. The hand loop in `Court.ts` never read `card.caption`
— beneath a comment claiming *"`caption` on the plan says which"*. The card dimmed to
alpha 0.4 and the reason was discarded. **(Item 2.)**

**The discard row could not draw a face because the plan threw identity away.**
`RedactedView.players[].discardPile` has always carried `{cardId, value}`;
`buildRenderPlan` mapped it to `entry.value`. The right-hand side draws a portrait only
because `revealedCard` kept its `cardId`. **(Item 11.)**

**The deck's empty warning was colour alone.** Not on the list. UIX §6.4 specifies a
subtle pulse at three cards or fewer and a strong one at empty — *"a genuine warning
that the showdown is one play away"*. `DeckPlan.pulse` was computed, and
`renderPlan.test.ts` asserted all three levels, and nothing ever rendered it. The colour
changed and the urgency did not, which makes the state colour alone — the one thing
UIX §6.3 rules out.

It had already happened a fourth time, before this work: `drawSeat` once reinvented pip
packing with its own 18px step, so `fitPips`'s search for a size that provably fits was
computed, returned and thrown away. That one is documented in a comment in `Court.ts`.

### The measurement behind item 1

The nickname is sized from the chip — `max(14, chipH × 0.13)`, no ceiling — while the
token row sat at a literal `y + 26`, and the name's scrim is added to the container
*after* the medallions, so it paints over them.

| Viewport | chip height | name band | old `y + 26` |
| --- | --- | --- | --- |
| phone 390×844 | 110 | 26 | exactly clear |
| tablet 1024×768 | 154 | 32 | buried |
| desktop 1920×1080 | 216 | 40 | buried |
| 4:3 1633×1221 | 244 | 44 | buried |

One value scaled with the viewport and its neighbour was a literal. "As text grows with
screen size" was exact.

### Item 2 was a bigger defect than reported

The sheet printed *"Every other player is protected or eliminated"* whenever no target
was eligible. Off-turn the engine deliberately sends `legalPlays: []` and
`legalTargets: {}`, so that fired for the mundane reason that it was not your turn — a
rule of the game stated to every player, on every off-turn card view, that was not true.

One boolean, `playable`, covered three distinct situations and the sheet rendered the
first one's copy for all three.

| Reason | How the client knows | What it now says |
| --- | --- | --- |
| Not your turn | `currentPlayerId !== own.playerId` | Not your turn — this is what the card does. |
| Another card forces itself | it is your turn and `legalPlays` excludes this card | You must play *X* this turn. |
| Playable, nothing to aim at | playable, and no eligible target | Every other player is protected or eliminated. This card will be discarded with no effect. |

`unplayableReason` derives none of it. `currentPlayerId` is public board state every
client already draws, and the forced card is the one `legalPlays` returned — not one
inferred from the hand. Which rule made the others illegal stays `computeLegalPlays`'s
business.

---

## 3. Decisions taken

**One dock, two tabs.** *(Product decision.)* The card reference and the match log share
one panel with a tab switch. Two surfaces would want the same corner, and
`ui.css`'s `#ui-root[data-sheet] .reference-tab` already arbitrates that corner against
the action sheet — a second launcher needs its own copy of that rule and its own answer
for where it goes instead. One dock keeps the collision a single rule, and puts item 3's
ability column and item 6's history in the same surface.

**The dock overlays; the table does not shrink.** `LayoutInput` carries no chrome
margin, and threading one through `computeLayout` would touch every topology test for a
panel the player opens by choice. Revisit only if play testing shows it covering cards
that matter.

**Non-modal, not pinned.** The panel already survived state updates. What read as
transient was three things it did on open — `role="dialog"`, `focus()`, and a
document-level Escape. Removing those and persisting open state is the whole feature. No
pin concept was added.

**Auto-select never auto-plays.** *(Product decision.)* A sole eligible target is
pre-selected; Play stays a deliberate second press. The Informant still needs a guess
before Play enables, and a card that plays itself on one tap is how a player discards The
Mule by accident.

**Hover is an enhancement, never a dependency.** *(Product decision, against a stated
principle.)* UIX line 15 — *"touch-first, nothing depends on hover"* — and line 349 —
*"**Never depend on hover.** Touch is a first-class input."* Every sentence the hint
shows is already reachable by tapping the card or opening the dock, so the principle
holds; long-press gives touch the same accelerator.

**Round history belongs to the engine.** The alternative was a client snapshotting
`publicLog` when it noticed the array get shorter. Which round a devotion token was won
in is a fact about the match, and a client inferring it from a length change is exactly
the drift `store/targets.ts` was written to prevent.

**Seat chips keep numeric pips.** A chip is `contentW / opponentCount` wide and must wrap
eight discards; faces there would break the guarantee `discardCapacity.test.ts` makes.
The row the feedback named — bottom left — is the own row, and that is where faces went.

---

## 4. Item → change → commit

| # | Item | Where it landed | Commit |
| --- | --- | --- | --- |
| 1 | Tokens hidden under the nickname | `ChipSpec` in `layout/types.ts`; `chipBands`/`chipHeightForBands` in `tableLayout.ts`; `Court.drawSeat` reads the spec | `bd4b487` |
| 2 | Why a 5 or 6 will not play | `content/playability.ts`, `store/targets.ts`'s `unplayableReason`, `actionSheet.ts`; canvas half draws `HandCardPlan.caption` | `64189fa`, `d313a76` |
| 3 | Reference missing abilities | `QuickReferenceRow.effect`; Ability column | `156f943` |
| 4 | Reference stays visible | `ui/referenceDock.ts` — non-modal region, persisted open state | `3186832` |
| 5 | Stale card context | `ActionSheet.showing()`/`refresh()`; `resyncOpenSheet` in `main.ts` | `0d5d41e` |
| 6 | Match-log history | `MatchState.roundHistory`, `RedactedView.roundHistory`, `content/matchLog.ts`; token tap opens the round | `51847ab`, `3186832` |
| 7 | Hover hints | `ui/cardHint.ts`; `Court.attachCardGesture` | `63fd0cb` |
| 8 | Ten seconds, not five | `config.ts`'s `revealWindowMs`, plus four prose sites | `eb6f006` |
| 9 | Auto-select a sole target | `autoSelect()` in `actionSheet.ts` | `0d5d41e` |
| 10 | Match log always visible | the dock's second tab | `3186832` |
| 11 | Discard icons | `OwnStatusPlan.discards` keeps `cardId`; `OwnRowSpec` sizes the run | `d313a76` |
| — | Deck pulse (found, not requested) | `Court.draw` tween, reduced-motion aware | `d313a76` |

---

## 5. Stages, as executed

### Stage 1 — Content and constants · **Complete**

Items 3 and 8, which share nothing with the rest.

Every value's characters share one effect string, so one ability column per row is
correct — and `content/quickReference.test.ts` now asserts that invariant, so a card
added later that breaks it fails the suite rather than quietly showing one character's
ability beneath another's name.

The reveal window is one constant, `revealWindowMs`, restated in prose at `config.ts`,
`README.md`, two `countdown.test.ts` names and UIX §291. Every server test that cares
already overrides it, and `config.test.ts` compares against `DEFAULT_CONFIG` rather than
a literal, so none needed changing.

### Stage 2 — The action sheet, recomputed · **Complete**

Items 2 (DOM half), 5 and 9 as one change, because all three rewrite `open()`'s one-shot
snapshot. Shipped separately they would each have had to re-decide how they composed
with the other two's handling of `target = null`.

`refresh()` rebuilds only when something it renders actually moved. A `STATE_UPDATE`
lands for reasons that have nothing to do with the open decision — a seat reconnecting, a
pause — and rebuilding on each would throw away a half-made choice and the player's focus
with it. The sheet already patched nodes in place for that reason.

A sheet whose card leaves the hand — played, traded, redrawn — closes rather than
refreshing.

Three existing tests asserted that a target always had to be chosen by hand. Their
subjects now offer two eligible seats, so they still exercise choosing rather than the
new pre-selection.

Item 2's forced-play cases are driven from the **real engine**: hands of 7 beside a 5 and
7 beside a 6, asserting on what `computeLegalPlays` actually returns, so a change there
cannot land unnoticed here.

### Stage 3 — What the canvas tells the truth about · **Complete**

Items 1, 2 (canvas half) and 11 — all three repack the same seat chip.

`computeLayout` now budgets the chip's bands the way it already budgeted the pip block,
and grows the chip when they will not fit. The medallion scales with the chip too, which
was the same complaint the pips had before `fitPips`. `tableLayout.test.ts` sweeps five
viewports × three seat counts × four pile depths and asserts the bands never meet — the
bug was invisible at the size it was first written at.

The own-status row's geometry moved into `OwnRowSpec`; it was the last place the scene
still invented numbers. Eight faces fit at every supported viewport with real slack,
including a 320px phone narrower than anything supported.

This stage found `DeckPlan.pulse` and `SeatPlan.discardTotal` unread, and produced the
contract guard below.

### Stage 4 — Round history · **Complete**

`dealRound` starts every round with `publicLog: []`, so the previous round's narration
ceased to exist the instant the next was dealt.

`MatchState.roundHistory` archives a round when it is **replaced**, not when it
concludes: a concluded round is still `match.round` and still on screen, and archiving it
early would list it twice.

Safe to publish whole. `publicLog` is safe by construction — peeks never enter it,
reaching a viewer only through the per-viewer `revealed` — so an archived log discloses
exactly what it already disclosed while live. Tests assert every seat sees an identical
history and that no living player's held card is ever named.

Nothing to migrate: persistence stores `{seed, actionLog}` and replays through the same
`startNextRound`, so history is a consequence of the actions. `persistence.test.ts`
asserts a replayed match rebuilds it, and guards against passing vacuously on an empty
history.

### Stage 5 — The dock · **Complete**

Items 4, 10 and the reading half of 6.

The panel's `inset: 0` had to go with the modality. Full bleed is right for a modal and
wrong for something meant to stay up while playing: it left no play visible, and it would
have covered the action sheet's Cancel and Play, which anchor to the same bottom edge and
lose to the dock on z-index. The dock takes the top on narrow and the right edge on wide.
Written as **longhand offsets**, because `inset` is not readable back in jsdom and an
assertion that cannot fail is worse than none on the rule keeping those two apart.

`content/matchLog.ts` is one source both the dock and the seat dossier render, so the two
cannot disagree about what happened. It reads in rounds rather than one flat stream:
flattened, *"Ana takes the round"* would sit directly above an unrelated opening play with
nothing marking the boundary.

Tapping a run of devotion medallions — on any seat, including the viewer's own row, which
had no hit target at all — opens the log at the round that seat most recently won. That
is item 6's suggestion, and it is what `roundHistory` made possible.

### Stage 6 — Hover and long-press · **Complete**

Hand cards now select on pointer **up** rather than down. A long press cannot decide a
gesture was not a tap after the tap has already been dispatched, which is what firing on
pointerdown meant. It is better tap semantics regardless: a press that slides off a card
no longer counts as choosing it.

The hint is a DOM surface. `Court.draw` calls `this.table.removeAll(true)` on every
`STATE_UPDATE`, so hover state held on a Phaser object has its owner destroyed
mid-gesture the moment an opponent plays a card. The scene emits enter and leave and
holds nothing but the pending press timer, which `draw()` also clears.

Hover reaches hand cards, the own row's discard faces, and a seat's revealed card — the
last two being the ones most worth explaining, having no action sheet to open. The
revealed card's hit rect is added *after* the chip-wide one: Phaser picks the topmost
interactive object, so added first it would never have seen a pointer. It still opens the
dossier on a tap.

The hint is `aria-hidden`. The accessibility twin already names every card and the sheet
reads the same effect aloud; a live region echoing a card on every pointer move would
interrupt a screen-reader user constantly to repeat what they had been told.

---

## 6. Guards added

**`src/game/scenes/courtContract.test.ts`** reads `Court.ts` as source text and fails on
any field the pure layer publishes that the scene never mentions. No pure test can catch
that class — `computeLayout` and `buildRenderPlan` are correct in all four historical
cases; what was wrong is that the scene ignored them. It is a crude question and the
right one: drawing a field *correctly* is not something source text can prove, but never
drawing it is, and that is the failure that keeps happening. Fields deliberately not
drawn need a reason in `NOT_DRAWN`.

It also asserts `drawSeat` takes the token row, the nickname size and the pip top from
the spec, and never from the literal `y + 26` that caused item 1.

**`tableLayout.test.ts`'s chip sweep** holds the name band, the token band and the pip
block apart at every supported viewport, seat count and pile depth.

**`content/quickReference.test.ts`** holds characters sharing a value to a shared
ability, since a row can only carry one ability sentence.

**`axe.test.ts`** grew from 13 cases to 15: the card hint, and the reference dock twice,
because its two tabs render entirely different markup and checking only the one it
happens to open on would leave the other unchecked.

---

## 7. Verification

```
bun run test        # 1335 client/engine (was 1198) + 255 server, all passing
bunx tsc --noEmit    # clean
bun run build        # succeeds; embedded asset manifest regenerated
```

Test files went from 64 to 69. New suites: `content/playability.test.ts`,
`content/matchLog.test.ts`, `ui/referenceDock.test.ts`, `ui/cardHint.test.ts`,
`engine/roundHistory.test.ts`, `scenes/courtContract.test.ts`.

**Not verified on hardware.** `docs/plans/2026-07-24-uix-qa-checklist.md` still wants a
real-device pass (Task 34 of the UIX plan), and this branch adds two things that only a
phone can confirm:

- **Long-press.** 450 ms with a 10px movement cancel. Whether that reads as deliberate
  rather than sluggish is a judgement no test makes.
- **The dock at phone width.** It takes the top 55dvh; whether that leaves enough table
  visible to keep playing is the whole point of the change and cannot be asserted in
  jsdom, which has no layout.

Worth a look too: the pointer-up change to hand-card selection is the one behaviour
players will feel immediately.

---

## 8. Left undone, deliberately

- **Seat chips keep numeric pips.** Reasoning in §3.
- **The table does not shrink for the dock.** Reasoning in §3. Revisit if the dock
  covers cards that matter on a real phone.
- **`SeatPlan.discardTotal` stays undrawn on the chip.** UIX §6.2 keeps the running total
  in the seat dossier; the chip already carries every discard as a pip. Recorded in
  `NOT_DRAWN` with that reason rather than left silent.
- **The screenshots in `docs/gameplay/` are uncommitted**, at the author's instruction.

## 9. Second round of feedback

> When a player is protected by a `4`, or a `2` was played against them, the text is
> hard to read. The text for being protected is drawn over the same area of an
> opponent's discard.

The same class as item 1, one band further down. The state caption was drawn at a
literal `seat.rect.h - 16` while the pip block is measured up from the bottom edge, so
it landed inside the discard values at **every** viewport:

| Viewport | pips | caption |
| --- | --- | --- |
| phone 390×844 | 87–104 | 94–107 |
| tablet 1024×768 | 133–148 | 138–151 |
| desktop 1920×1080 | 188–210 | 200–213 |

Measuring it turned up two more faults nobody had reported:

- **The peek marker was colliding too.** `you know: 3 · Ebling Mis` was placed at
  `tokenTop + medallion + pad`, which on a rotated phone put it at 42–55 against a pip
  block at 43–56. The chip had always been too short for its contents there; it simply
  overlapped rather than growing.
- **Both lines carried no scrim, and neither scaled.** The chip's border is stroke-only,
  so the nickname and the pips have scrims. These two were the last table text without
  one — bare 11px over the nebula and over the numerals at once — and the only text left
  pinned to a phone's pixel count.
- **The caption was too wide for a chip.** "Protected — cannot be targeted" sets to
  roughly 165px at this size; a three-opponent phone chip is about 110px. It ran off the
  right edge.

`ChipSpec` now budgets all five bands — name, tokens, marker, caption, pips — and
`chipHeightForBands` grows the chip when they will not fit. The chip caption is shortened
to `Protected`; the sentence stays in `seatDossier.ts`, where there is room for it, and
matches what `a11yTwin.ts` already said. One `chipLine` method draws both small lines,
each on a scrim sized to its own text and clamped to the chip's width.

The only viewport that grows is the rotated phone, 62 → 90px, and that is the honest
cost of a band it was already drawing over. One composition test changed its measure as
a result: a landscape-narrow chip now claims a larger *fraction* of a much smaller
screen than a monitor's does, so "roomier seats" is asserted in pixels, which is what a
player actually sees.

`courtContract.test.ts` gained an assertion that `drawSeat` positions both lines from the
spec and never from `seat.rect.h - 16`.

## 10. Third round: the GPU at 80%

> There is an issue with resources. The GPU is at 80% utilization when the game is open
> in the browser.

**Root cause, from Phaser's own source rather than inference.** `Game.step` runs
`preRender`, `scene.render` and `postRender` on every animation frame with no dirty
check anywhere in the path. That is correct for a game with a simulation. This one is
turn-based, its table is a still image between actions, and **no scene here defines
`update()` at all** — so the renderer redrew an unchanged picture at the display's
refresh rate for as long as the tab stayed open.

Ruled out on the way, each by looking rather than guessing: no filters, post-pipelines
or particle emitters anywhere in `src/`; textures are 512×720 and 8.1 MB in total; the
ScaleManager sets `canvas.width` to the CSS size, so there is no devicePixelRatio
multiplication; and the stylesheets carry no `backdrop-filter`, no blur and no
continuous timers.

`renderPolicy.ts` owns the decision, for the reason `inputPolicy.ts` does — it can be
asserted without constructing a `Game`. **It fails awake:** every branch that cannot
prove the game is idle keeps drawing.

The failure mode that governed the design: Phaser's tween manager and clock are both
driven by the loop, so sleeping through a tween does not pause it, it stops it
*completing* — and `beats.ts` resolves its promise from `onComplete` while the
presentation queue awaits that promise. One missed tween would stall the table
permanently. So `Court.isAnimating()` names every source of motion explicitly rather
than inferring it, the animate thunk wakes the pump before each beat, and `pause`/
`resume` bracket the stop so the first frame back does not report the whole idle period
as one delta. Input is wired separately: the mouse and touch managers bind to the canvas
and *queue* what they receive, draining in the loop's pre-step, so a tap against a
stopped loop is captured and never processed.

`antialiasGL: false` alongside it. That flag is the one handed to `getContext`, and
every edge here is an axis-aligned rect or a textured quad with text rasterised before
it is drawn — multisampling cost a full-screen resolve per frame and smoothed nothing
jagged. The plain `antialias` flag stays `true`; that one is texture filtering, and
every portrait is drawn scaled.

**Measured, not assumed.** Kapture's browser extension is not installed, so the first
attempt at verification failed. Headless Edge driven over CDP worked instead — wrapping
`requestAnimationFrame` and `drawElements` before any page script runs, then standing up
two real clients and starting a match:

| | frames/s |
| --- | --- |
| table idle | **0** |
| during a mouse move | 75 |
| idle again | **0** |
| after a click | 71 |
| idle once more | **0** |
| observing client, across an opponent's play and its beat | 65 |
| observing client, the 3 s after | **0** |

No page errors on either client.

### The accessibility bug the harness found

With two real clients on a table it became visible that `[data-twin="hand"]` was empty —
so a keyboard or screen-reader player had **no hand at all** on the first deal.

`a11yTwin` positions its hand proxies from `court.currentLayout()`, and `renderView` is
what sets that layout — but the subscriber updated the twin *first*. It read the previous
push's layout, and on the first deal there was none. Confirmed by measurement: nought
proxies, then one the instant a second state update arrived. One line of reordering; two
proxies on the first deal now. `subscriberOrder.test.ts` reads `main.ts` as text and
holds the order, since the composition root has no test of its own.

### What this does not cover

The deck's low-deck pulse is a `repeat: -1` tween, so `isAnimating()` is true for as long
as it runs and the loop stays awake through the endgame. That is the design's warning
working as intended, but it does mean the last rounds cost what every round used to.
Worth watching on the real-device pass.

## 11. One unexplained observation

A single run of `bun test src/server` reported one failure in `roomRegistry.test.ts`
("a semantically corrupt actionLog fails replay on cold get"). It has not reproduced
across ten subsequent full runs, nor across six runs of that file alone. It is recorded
here rather than claimed fixed, because nothing was changed in response to it and the
cause is unknown.

---

## Carried through every stage

The accessibility twin (`ui/a11yTwin.ts`) is what actually reaches a screen-reader user.
Stages 2, 3, 5 and 6 each change what a card or seat communicates, and each had to ask
whether the twin needed the same fact. It is not separate work.

`purity.test.ts` reads raw file text, so `layout/`, `content/`, `store/` and `tokens/`
may not so much as name a DOM global in a comment.
