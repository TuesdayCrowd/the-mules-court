# Gameplay feedback — design and staging

**Date:** 2026-07-27
**Source:** eleven items of playtest feedback, triaged against the code.

Two findings reshaped the work before any of it started.

**The forced-play explanation is already written and thrown away.** `renderPlan.ts:201`'s
`dimCaption(view)` returns `must play The First Speaker` and reaches
`HandCardPlan.caption`. `Court.ts` draws the hand at `:271-322` and never reads that
field, though the comment at `:277` says it does. The pure layer is correct; the scene
drops it on the floor.

**The discard row cannot draw an icon because the plan discards identity.**
`RedactedView.players[].discardPile` carries `{cardId, value}`. `renderPlan.ts:247`
maps it to `entry.value`. The right-hand side draws a portrait only because
`revealedCard` kept its `cardId`.

Neither needed an engine change. Both had been read as rendering problems.

## Decisions taken

**One dock, two tabs.** The card reference and the match log share a single panel with
a tab switch, rather than two surfaces competing for the same corner. `ui.css`'s
`#ui-root[data-sheet] .reference-tab` rule already arbitrates that corner against the
action sheet; one dock keeps that a single rule instead of two special cases.

**The dock overlays; the table does not shrink.** `LayoutInput` carries no chrome
margin, and threading one through `computeLayout` would touch every topology test for a
panel the player opens by choice and closes the same way. Revisit only if play testing
shows the dock covering cards that matter.

**Non-modal, not pinned.** The panel already survives state updates. What reads as
transient is `role="dialog"`, the `focus()` on open, and the document-level Escape.
Remove those three, persist open-state, and "stays visible while playing" follows. No
pin concept is added.

**Auto-select never auto-plays.** A sole eligible target is pre-selected; Play stays a
deliberate second press. The Informant still needs a guess before Play enables, and a
card that plays itself on one tap is how a player discards The Mule by accident.

**Hover is an enhancement, never a dependency.** UIX §349 — *"Never depend on hover"* —
stands. Tapping a card still opens the sheet with the same ability text. Hover and
long-press are faster paths to copy that is already reachable.

## Three reasons a card will not play

Today one boolean, `playable`, covers all three, and the sheet renders the first one's
copy for every case.

| Reason | How the client knows | What it says |
| --- | --- | --- |
| Not your turn | `view.currentPlayerId !== view.own.playerId` | Not your turn — this is what the card does. |
| Another card forces itself | it is your turn, and `legalPlays` excludes this card | You must play *X* this turn. |
| Playable, but nothing to aim at | `playable`, and no eligible target | Every other player is protected or eliminated. This card will be discarded with no effect. |

The third sentence is the one the sheet prints today in all three cases. Off-turn it is
a statement about the rules of the game that is not true.

The client derives nothing here. `currentPlayerId` is public board state. `legalPlays`
is the engine's own answer, and `dimCaption` already names the forced card from it
under a comment explaining why that is reading rather than deriving.

## Stages

### Stage 1: Content and constants

**Goal:** the two items that share nothing with the rest.
**Success criteria:** ability text appears per row in the card reference; the
between-round window is ten seconds everywhere it is stated.
**Tests:** `ui/quickReference.test.ts` asserts each row carries its effect sentence;
`content/quickReference.test.ts` asserts every catalog value is covered; existing
`countdown.test.ts` cases move to ten.
**Notes:** every value's characters share one effect string, so one column per row is
correct and provably so. The window is `config.ts:40`, restated in prose at
`config.ts:64`, `README.md:318`, `countdown.test.ts:19,28` and UIX §291.
**Status:** Complete

### Stage 2: The action sheet, recomputed

**Goal:** items 2, 5 and 9 as one change, because all three rewrite `open()`'s one-shot
snapshot.
**Success criteria:** an open sheet re-renders when the turn reaches its viewer; each of
the three unplayable reasons prints its own sentence; a sole eligible target arrives
pre-selected and Play still requires a press.
**Tests:** `actionSheet.test.ts` — a sheet opened off-turn becomes playable on the state
push that grants the turn; the forced-play sentence names the forcing card; the
protected-or-eliminated sentence appears only when it is the viewer's turn; one eligible
target is `aria-pressed=true` on open and two are not; focus survives a recompute.
**Notes:** the sheet deliberately patches nodes in place rather than rebuilding, to keep
focus (`actionSheet.ts:87-93`). The recompute must honour that.
**Status:** Not Started

### Stage 3: What the canvas tells the truth about

**Goal:** items 1, 2's canvas half, and 11 — all three repack the same seat chip.
**Success criteria:** the forced-play caption is drawn under a dimmed hand card; discard
history shows card icons beside values on both sides of the table; devotion tokens stay
clear of the nickname at every viewport size.
**Tests:** `tableLayout.test.ts` asserts the name band and token band never overlap
across a sweep of viewports and seat counts; `renderPlan.test.ts` asserts discard
entries keep `cardId`; the existing `discardCapacity.test.ts` must keep passing
unedited, since icons need more room than numerals at eight discards.
**Notes:** the collision is a units mismatch — `nameH` scales with the chip
(`Court.ts:337`, no ceiling) while the token row sits at a literal `y + 26` (`:363`),
and the name scrim is added to the container after the medallions, so it paints over
them. Fix the budget in `tableLayout.ts` where the pip block is already budgeted, and
let the scene draw what it is handed.
**Status:** Not Started

### Stage 4: Round history

**Goal:** the engine retains completed rounds' logs so the client can show more than the
round in progress.
**Success criteria:** a completed round's log survives into the next round; each entry
set is attributable to the round that produced it and to its winners.
**Tests:** engine — a two-round match exposes round one's log while round two is live;
`view.test.ts` asserts history is redaction-safe; server — a replayed match rebuilds the
same history.
**Notes:** `setup.ts:94` starts each round with `publicLog: []`. Retention belongs to the
engine rather than a client heuristic that watches the log get shorter: which round a
devotion token came from is a fact about the match, and the client restating it is the
drift `targets.ts` exists to prevent. Persistence stores `{seed, actionLog}` and replays,
so history rebuilds without a migration.
**Status:** Not Started

### Stage 5: The dock

**Goal:** items 4, 10 and the reading half of 6.
**Success criteria:** one tab opens a panel with Card reference and Match log; the panel
stays open across turns and reloads; it steals no focus and traps none; the match log
reads the current round and any completed one.
**Tests:** `referenceDock.test.ts` — tab switching, persistence across a remount, no
`role="dialog"`, focus stays where the player left it; `axe.test.ts` covers the new
surface; `a11yTwin` still announces without doubling the dock.
**Notes:** `seatDossier.ts:131` already implements a two-tab panel; copy that shape.
**Status:** Not Started

### Stage 6: Hover and long-press

**Goal:** ability text on hover for pointer devices, and on long-press for touch.
**Success criteria:** hovering a card on canvas or in the dock shows its effect;
long-press shows the same without firing the tap that opens the sheet; neither is
required to reach the copy.
**Tests:** tooltip surface unit tests; a press that moves or ends early opens the sheet
instead; a rebuild of the table clears any showing tooltip.
**Notes:** `Court.ts:120` destroys every interactive object on each `STATE_UPDATE`, so
the tooltip must be a DOM surface owning its own lifetime while the scene emits only
enter and leave. Suppress the tooltip for a card whose action sheet is open, or the same
sentence renders twice.
**Status:** Not Started

## Carried through every stage

The accessibility twin (`ui/a11yTwin.ts`) is what actually reaches a screen-reader user.
Stages 2, 3, 5 and 6 each change what a card or seat communicates, and each must ask
whether the twin needs the same fact. It is not separate work.

`purity.test.ts` reads raw file text, so `layout/`, `content/`, `store/` and `tokens/`
may not so much as name a DOM global in a comment.
