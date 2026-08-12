# Remaining Gameplay Follow-Ups

**Date:** 2026-08-11
**Status:** Not started. Four items, in the order they should be taken.
**Origin:** A real four-player match against computer opponents, plus one finding that fell out of fixing it.
**Depends on:** `docs/plans/typescript/2026-07-22-transport-design.md`, `docs/plans/typescript/2026-07-23-uix-design.md`, `docs/plans/typescript/2026-07-30-computer-opponent-design.md`

---

## Where this came from

Seven complaints came out of one match. Three are shipped or in review:

| Complaint | Outcome |
| --- | --- |
| A stale invite link hung on *"Taking your seat…"* and threw on the server | Fixed, merged (PR #67) |
| A trade never said which card you gave away | Fixed (PR #68) |
| A computer opponent whose hand was taken could not guess it back | Same fix (PR #68) |
| A computer opponent did not guess a card it had looked at | **No work needed** — novice's `Recall` sets `peeks: false` deliberately (`difficulty.ts`); adept and master already do this, and `heuristic.test.ts` asserts it |

The four below remain. They are independent of one another except where noted, and §4 is by far the largest.

---

## 1. The round starts before anyone can read their hand

**The complaint.** When a round begins and a computer opponent moves first, there is not enough time to look at your own cards before the table moves.

**What is actually happening.** `botThinkMs` is `1_200` (`config.ts`), and `scheduleBotTurn` starts that clock the moment the round commits. But the client is still *dealing* — the presentation queue runs a staggered flight for every card, and the announcement of the bot's play is queued behind beats that have not finished. So the 1.2 seconds is not 1.2 seconds of looking; it is 1.2 seconds minus however long the deal takes, and the player never sees a still table at all.

Note this is a **pacing** bug, not a fairness one. Nothing is decided during the deal; the bot's move is committed server-side either way. What is lost is the beat of quiet the player needs to form a plan.

### The approach

A **distinct, longer delay for the first bot move of a round**, separate from `botThinkMs`.

Deliberately not the two more thorough options:

- *Gate the bot on a client acknowledgement that the deal has finished rendering.* Correct in principle, and it needs a new `ClientMessage`, validation in `dispatch.ts`, a fallback timeout for a client that never acks, and — in a multi-human game — a decision about whether the table waits for every human or only the one about to be acted on. Medium work for a problem a longer delay may simply solve.
- *An explicit "Ready" control.* A new surface, new protocol messages, a new room-state gate, and a product decision about pacing on every round of every match. Large, and it is a design change rather than a fix.

Reach for the ack only if a longer delay proves insufficient in play.

### Seams

- `src/server/config.ts` — a new tunable beside `botThinkMs`. Name it for what it is: the pause before the *first* move of a round, not a "long think".
- `src/server/room.ts` — `scheduleBotTurn` picks between the two. The condition is "this is the first play of the round", which the round state can already answer (`turnNumber`); do not thread a flag down from the callers, which would put the same decision in `startMatch` and `advanceRound` separately and let them drift.
- `CHANGELOG.md` — player-visible.

### Traps

- **Do not simply raise `botThinkMs`.** It governs every bot move, and the comment on it argues for 1,200ms specifically: a bot that answers instantly reads as a cutscene, and one that is slower than that drags every turn of every round.
- The value has to cover the deal, so **derive it from the client's own deal duration rather than guessing a round number.** `dealSequenceMs` in the client's motion layer is the figure to look at; if the server cannot import it, state the relationship in a comment at both ends so a change to one prompts a look at the other.
- Reduced motion shortens or removes the deal, so a player with `prefers-reduced-motion` waits longer than they need to. Acceptable — the delay is a floor, not a sync — but say so in the comment rather than leaving it to be rediscovered.

### Tests

`room.test.ts`, with the injected clock the file already uses: assert the first bot move of a round is scheduled at the new value and the second at `botThinkMs`. Both, in one test — asserting only the first would pass against an implementation that slowed every turn.

---

## 2. The match log needs its own button

**The complaint.** Stated plainly: *"Match log needs broken out into its own button."*

Today it is the third tab of the reference dock, behind a launcher labelled *Reference* — so a player looking for the history of the round has to know it lives behind a word that does not mean history.

### The approach, and the part that needs deciding first

The corner it would naturally go in is **full**. `ui.css` already arbitrates two controls there:

- `.reference-tab` at `bottom: var(--space-3)`, right-aligned
- `.chat-launcher` stacked above it
- and **both** cross to `left: var(--space-3)` under `#ui-root[data-sheet]`, because the action sheet owns the bottom-right while it is open

A third pill makes a column climbing the right edge of a phone, and needs a third crossing rule. That is the coupling the dock's own header comment warns about — it says one dock keeps the collision a single rule, and this would be the third instance of it.

**Put the log's control in the top chrome cluster instead**, beside `.connection-dot` and `.sound-toggle` (`z-index: 1`). It belongs there on the merits: those are the persistent, always-available affordances, and a match history is reference material rather than an in-the-moment action. The action sheet is bottom-anchored, so no crossing rule is needed at all.

The log then becomes its own surface, and the dock keeps `reference` and `rules`.

### Seams

- **Create** `src/client/ui/matchLog.ts` — a `Surface` in the dock's shape: a labelled `role="region"` rather than a `dialog`, Escape bound to the panel rather than the document, focus left alone on open. Reuse `content/matchLog.ts` for the sections and `ui/scrollFollow.ts` for the follow-the-bottom behaviour; neither needs changing.
- `src/client/ui/referenceDock.ts` — drop `'log'` from `DockTab` and the tab list, and remove the log body.
- `src/main.ts` — construct and `uiRoot.add` the new surface; repoint `onTokensSelected` (tapping a devotion token opens the log at that round) at it.
- `src/client/styles/ui.css` — the button in the top cluster, and the panel.
- `src/client/content/` — the button's accessible name and title.

### Traps

- **The dock persists its active tab in `localStorage` under a global key.** A player who last used the log has `'log'` stored. `isTab` must reject it and fall back, or the dock opens on a tab that no longer exists. Check that guard before changing the union — it is the kind of thing that only breaks for people who used the feature.
- **`seatDossier` also renders a match log** and is unaffected. Do not consolidate them in this change; it is a separate question.
- The top cluster sits at `z-index: 1` specifically so it outranks a `.screen` and stays under the fatal wall at 2. A panel opened from it needs its own place on the ladder — do not inherit 1.
- `main.ts`'s resize handler refreshes the table and then the dock, in that order, for a stated reason. If the new panel reads any table geometry, it joins that ordering; if it does not, say so in a comment so nobody adds it later by symmetry.

### Gates

- `__tests__/axe.test.ts` — a new `SURFACES` entry and the hard-coded count bumped. Two entries if the open and closed states render different markup, as the dock's do.
- `visual/gallery.ts` + `visual/harness.ts` — a specimen with a populated log and a `judgeSpecimen` branch. A long narration line is the thing worth measuring; a specimen without assertions buys a picture and no test.
- `referenceDock.test.ts` — the tab list shrinks.

---

## 3. Back to the lobby after a match

**The complaint.** *"After the match is over, bring the human players back into a lobby. Remove any computer players. This will allow those who are already playing together to either drop out or invite new people to their lobby. The host can repopulate empty seats with computer opponents if they so choose."*

This is the largest item by a wide margin. It should get its own design document before any code.

### Two decisions already made

**Reuse the room; do not mint a new one.** *"Invite new people"* means the invite link has to keep working, and every client captures `matchId` once at boot and threads it through the composition root — so moving live clients to a new room means a full page reload for each of them, which is the cost this feature exists to avoid.

**The host transfers to the next non-bot seat.** Confirmed by the owner. Today `p1` *is* the host by fixed convention, duplicated as a constant in both `room.ts` and `dispatch.ts`, and `sweep()` refuses to ever reopen seat 0 — deliberately, because whoever claimed a reopened seat 0 would become `p1` and pass every host gate. That is a security rule, so the transfer must be **explicit**: the room grows a `hostSeat` field and every gate reads it, rather than anyone claiming their way into the role. `LOBBY_UPDATE` already carries `hostSeat`, so the client half is largely in place.

### The hard part: replay

A room persists `{seed, actionLog}` and is rebuilt by replaying actions through `reduce()`. A room that hosts a *second* match cannot simply append — the log would describe two matches and the replay would be nonsense.

**Recommendation: on returning to the lobby, clear the action log and drop the seed; mint a fresh seed when the next match starts.** A rebuilt room then replays only the match in progress, which is the only one anyone can still be playing. Past matches are not recoverable, and nothing needs them: devotion tokens live in `MatchState` and reset with it, and the match-over overlay has already been seen by everyone who was there.

The alternative — a match sequence number, keeping every match's log — buys a history nothing reads, and it changes the persistence schema.

### What the transition must reset

Enumerate it in the design doc and check each against the code; this list is the starting point, not the finished answer:

- `match`, `endReason`, `winnerSeat`, `endedAt`
- any armed reveal timer, and any pending bot timer
- every bot seat: token, nickname, `bot`, `difficulty`, back to open
- the persisted `seed` and `actionLog`
- the persisted phase, back to `lobby`

And two things that must **not** reset: the human seats' tokens and nicknames — that is the whole point — and the chat transcript, which lives on the room. Note that this makes the transcript outlive a match for the first time; the chat design says it dies with the *room*, which is still true, but the sentence deserves revisiting there.

### The two landmines

Both were found during recon and are prerequisites, not polish:

1. **The lobby TTL is anchored to `createdAt`**, fixed at construction. A room returning to the lobby after a normal-length match is already past `lobbyTtlMs`, so the very next reaper tick closes it. Add a separate "lobby opened at" stamp and anchor the sweep to that.
2. **The per-room RNG streams are seeded once at construction** — `bots:${matchId}` and `names:${matchId}`. A second match carries the first match's cursor, so bot naming and tie-breaking continue mid-stream rather than starting fresh. Decide deliberately which behaviour is wanted and write down why; either is defensible, but silently inheriting a cursor is not.

### New protocol surface

- `LEAVE_SEAT` — a human vacating their own seat. No equivalent exists; `REMOVE_BOT` explicitly refuses to target a person.
- Host transfer needs no message of its own if it is a consequence of `LEAVE_SEAT` and of the reaper, but the rule ("the next occupied non-bot seat in index order") belongs in exactly one function.

### Traps

- **Every guard that currently means "the match is over, refuse" has to be re-read.** `claimSeat`, `playCard`, `sendChat` and `endMatch` all answer `MATCH_OVER` on `phase === 'ended'`. Some of those should now succeed against a room that has returned to the lobby.
- **`resumeSeat` was just fixed** for a room that ended without ever holding a match. That fix keys on `phase === 'ended' && match === null`, which is exactly the shape a room in the *new* lobby state will resemble. Re-read it as part of this work; the guard may need to distinguish "closed" from "between matches".
- Tests across `room.test.ts`, `roomRegistry.test.ts` and `reconnect.test.ts` encode *"ended is terminal"* as an assumption. Expect to rewrite rather than extend them.
- The client's `overlays.ts` offers "Back to menu" from the match-over screen. That path stays — leaving should still be possible — but it is no longer the only exit.

---

## 4. `retention` credits a King for keeping the card it gives away

**Not from the match — found while fixing it**, and recorded here because it should not live only in a pull request description.

`heuristic.ts` adds `retention = keepValue * keptValue * showdown` to the score of **every** move, including `KING`. But `keptValue` names precisely the card a trade hands over. So a trade is credited for holding onto the card it is in the act of surrendering.

Measured magnitude: up to roughly **32 late in a round**, comparable to `kingGain` and the new `kingLeak`, and pointing the wrong way.

### Why it matters more now than it did

`kingLeak` was trained against the scorer *including* this bug. The weights are honest about the game as it currently computes — nothing is wrong today — but the two are entangled: fixing `retention` without retraining would leave `kingLeak` compensating for a term that no longer exists. Anyone reading `kingLeak: -114` as a pure measure of the disclosure cost would be reading it wrong.

### The approach

Exclude the traded card from `retention` in the `KING` branch, then retrain and re-check the holdout gate. Treat it exactly as the King change was treated: a test that fails against the current scorer first, then the retrain, and no lowering of the gate. The trainer refuses to write a result that does not clear break-even, so a failure announces itself and costs only wall clock.

Expect `kingLeak` to move. That movement is the evidence the two were entangled.

---

## Suggested order

1. **Pacing** — smallest, and the complaint most likely to recur every single game.
2. **`retention`** — while the King work is fresh and the entanglement is understood. Independent of everything else.
3. **Match log button** — self-contained, client-only, touches no server or engine code.
4. **Post-match lobby** — design document first. It is the only one that changes the room lifecycle, and the only one that should not be attempted alongside anything else that edits `room.ts`.
