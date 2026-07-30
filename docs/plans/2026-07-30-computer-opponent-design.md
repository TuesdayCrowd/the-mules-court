# The Mule's Court — Computer Opponent Design

**Date:** 2026-07-30
**Status:** Proposed. §11 lists what is still open.
**Scope:** A built-in, non-LLM opponent so one person can play a whole match alone.
**Depends on:** `docs/plans/2026-07-22-engine-architecture-design.md`, `docs/plans/2026-07-22-transport-design.md`
**Adjacent:** `docs/plans/2026-07-28-mcp-seat-design.md` — the LLM answer to the same problem

---

## 1. Scope

`src/mcp/` already lets a person play alone, by seating a language model at the
other chairs. It costs an agent runtime, three model contexts, and a referee
loop. That is the right tool for a designer probing the game and the wrong one
for a player who opened the page.

This design covers the other answer: an opponent compiled into the game. It
covers where the bot runs, what it is allowed to know, how it decides, how its
parameters are trained, and how difficulty is expressed. It does not touch the
engine and may not change a rule.

### Fixed decisions

| Decision | Choice |
| --- | --- |
| Where the bot runs | Server-side, as an ordinary seat in an ordinary `Room` |
| What the bot sees | `RedactedView`, from the same `view()` humans get. Nothing else |
| How it evaluates | The real `reduce()`. No reimplementation of any rule |
| Decision method | Belief-driven heuristic, with ISMCTS layered on top for the strong tier |
| Where strength comes from | Self-play, not human games |
| Difficulty | Degraded knowledge, never degraded choice |
| Placement | `src/game/ai/` (pure) + `src/server/botSeat.ts` (the seat) |

---

## 2. The problem worth solving

The obvious plan is to learn from recorded human matches. It is the wrong plan,
and the reason is worth stating before any architecture, because it decides what
gets built.

**There will not be enough human games, and imitating them caps the ceiling.**
A hosted table might record hundreds of matches in a year. That is three orders
of magnitude short of what behavioural cloning needs for a game with this much
hidden state, and even given infinite data, a policy trained to reproduce human
moves converges on playing *like* the humans in the sample rather than beating
them.

**Meanwhile self-play is cheap here, for reasons this repo already
demonstrates.** The engine is a headless deterministic reducer with no I/O and
no ambient randomness — `src/game/engine/index.ts` says so in its header, and
`src/client/layout/discardCapacity.test.ts` already drives thousands of complete
matches through it inside a unit test to prove a layout bound.

Measured, once `selfPlay.ts` existed: **707 four-player matches per second on
one core, or 60,554 `reduce()` calls per second** (20,000 random-vs-random
matches, Bun 1.3.14, Apple Silicon). A hundred thousand matches — comfortably
more than one cross-entropy training run needs — is about two and a half
minutes. A million is twenty-four.

That is a training budget, not a research project. It is *not* the throughput a
deep search would want, which is the same number read the other way and is
tracked as the open risk in §11.

So the split this design takes:

> **Self-play produces strength. Human logs produce evaluation, opponent priors,
> and difficulty calibration.** Those are different jobs and neither substitutes
> for the other (§9).

The second problem is smaller but sharper. A bot that runs inside the process
that owns the match can trivially cheat, and nothing in a code review reliably
catches it — a single `match.round.players[x].hand` read looks like every other
line around it. §3 and §4 make cheating structurally impossible rather than
forbidden, on the same principle the MCP design uses for its seat handles:
*isolation is a missing capability, not a rule someone must remember.*

---

## 3. Architecture

### The bot is a seat, not a mode

Two placements were considered.

**Rejected: an offline client-side match.** The client would import the engine
and run the whole game in the browser with no socket. It sounds like the
lightweight option and is not. `src/client/` is built on interface rule 1 —
*render the view, decide nothing* — and `store.ts` states in its header that it
never derives a game rule. A local match means a second authority for turn
order, legality and elimination living inside the layer whose entire design is
not having one. It also buys nothing: there is no server-free deployment. The
client calls `POST /api/rooms` before it can do anything, `bun run dev` needs
`dev:server` beside it, and the single-file binary embeds the server precisely
so the standalone case still has one.

**Chosen: bot seats in a real room.** A match against the computer is a normal
four-player match where three seats are filled by `botSeat.ts` instead of by
WebSockets. Everything downstream is reused unchanged — `dispatch`'s validation
pipeline, `persistence.ts`'s `{seed, actionLog}` storage, room reaping,
reconnection for the one human.

The decisive property is the one that falls out for free:

> A bot seat receives its position through `view(match, botId)` — the same
> function, the same redaction, as a browser. `RedactedView` is declared
> standalone rather than as `Omit<MatchState, …>` specifically so that "no field
> here can hold `deckOrder`, `setAsideFaceDown`, `rng`, `seed`, `actionLog`,
> `privateKnowledge`, or another player's hand" (`types.ts:339`). **A bot that
> tried to peek would not compile.**

The second property is nearly as good: because bot actions enter through
`dispatch` like any other, they land in `actionLog`, so **every game against the
computer is automatically a replayable training and evaluation record in the
format the server already persists.** No data pipeline needs building.

### Module layout

```
src/game/ai/            pure, no DOM, no Phaser, no transport
  policy.ts             the Policy interface, and the seam everything plugs into
  beliefs.ts            RedactedView + public log  ->  constraint set
  determinize.ts        constraint set + rng       ->  a consistent MatchState
  features.ts           belief + view              ->  a feature vector
  heuristic.ts          features x weights         ->  a scored action ranking
  weights.generated.ts  the trained weight vector. Generated, committed
  search.ts             ISMCTS over determinized worlds, using real reduce()
  selfPlay.ts           headless N-policy match driver
  arena.ts              win rates with confidence intervals

src/server/botSeat.ts   pacing, scheduling, and the bridge into dispatch
scripts/trainAi.ts      offline trainer. Not shipped, not imported by src/
```

`src/game/ai/` rather than a new top-level directory, and that is deliberate.
`vitest.config.ts` enumerates `src/game/**/*.test.ts`, so tests here are
collected the moment they are written. AGENTS.md records the asymmetry that
makes the alternative dangerous: a new top-level directory under `src/` is
type-checked by `tsconfig.json` wholesale but **silently untested** until a
script names it, which is how `test:mcp` came to exist.

### The one interface

```ts
export interface Policy {
    readonly id: string;
    decide(view: RedactedView, rng: Rng): PlayCardAction | null;
}
```

`RedactedView` in, an action out, an injected `Rng` so every decision is
reproducible from a seed. `null` means "no legal play", which the caller treats
as *do nothing* rather than as an error — the contract `chooseFallbackPlay`
already established.

`chooseFallbackPlay` in `src/mcp/fallbackPlay.ts` is the ancestor of this whole
module and satisfies the interface almost as written. It stays where it is,
because it serves a different purpose there (a stalled agent's dull move) and
because it becomes the honest floor every trained policy must beat in `arena.ts`.

---

## 4. Beliefs: the part that actually matters

Before any learning, the highest-value component is not a learner. It is an
exact tracker of what is possible, and it is arithmetic.

### Why exactness is achievable here

`setup.ts` sets aside `{faceUp: 1, faceDown: 2}` at two players, `{0, 1}` at
three, and **`{0, 0}` at four**. In the four-player game — the one "play against
the computer" ships — every one of the sixteen cards is in a hand, in the deck,
or face-up on the table. There is no permanently hidden card blurring the count,
so a seat's uncertainty is exactly "which of the unseen cards are where", with
nothing unknowable mixed in.

That is a small enough space to reason over exactly rather than approximately.

### What a seat may condition on

All of it is already in `RedactedView`, and the public log is far richer than a
list of plays:

| Signal | What it establishes |
| --- | --- |
| `players[].discardPile` | Exact card types, publicly, for every discard |
| `own.hand` | Two cards that are in no one else's hand |
| `revealed` | Live peeks, re-derived every call, auto-expiring |
| `deckCount`, `removedFaceDownCount` | How much mass is unassigned |
| `GUESS` with `hit: false` | The target did **not** hold that value, then |
| `GUESS` with `hit: true` | Plus the discard names the exact card |
| `COMPARE` `'tie'` | The two remaining cards were **equal** — very strong |
| `COMPARE` `'actor-eliminated'` | Actor's remaining card `<` target's, and the actor's is now face up, so the target's is bounded from below |
| `TRADED` | Two hands swapped. Constraints must travel with the cards |
| `REDREW` + `drewFrom` | The old card is face up; the new one is unconstrained |
| `PROTECTED` | Not information about a hand, but changes legal targets |
| `ELIMINATED` `'mule-forced'` vs `'mule-voluntary'` | Whether a Mule discard was chosen |
| A `first-speaker` discard | Possibly forced, which implies a 5 or 6 alongside it |

Two of these deserve emphasis because a naive tracker gets them wrong.

**`COMPARE 'tie'` is the strongest single line in the log.** Nothing is
eliminated, so it reads as a non-event, and it tells you two specific players
held the same value at that instant.

**A Baron compare is mutual.** `resolveBaron` calls `recordPeek` twice — "the
mutual reveal is unconditional and happens BEFORE the tie check". So the log
entry publicly announces that *both* those players now privately know each
other's card. A bot that models only its own knowledge will walk into an
opponent who has a certainty. This is not hypothetical: the same dynamic decided
round 1 of the match this design was written during, where a look-at-hand card
turned into a guaranteed kill six turns later.

### The discipline: constraints bind to instances, never to seats

This is the design decision most likely to be got wrong, so it is stated as a
rule.

A missed guess does not mean "p2 never holds a 3". It means **the specific card
p2 was holding at turn 6 is not a 3**. If p2 then plays it, the constraint
retires. If Mayor Indbur trades it to p4, the constraint *moves to p4* — and
that inference is free, correct, and invisible to any tracker keyed on seats.

The engine already solved this exact problem and the solution is the model to
copy. `PeekRecord` is bound to `(viewerId, subjectId, cardInstanceId)` and never
to a hand position, so "a traded or discarded card silently stops resolving
instead of being misreported as knowledge about its replacement"
(`types.ts:119`). Beliefs follow the same rule: every constraint names a
`CardInstanceId` or a `(player, turn)` pair that resolves to one.

### Determinization, and the invariant that keeps it honest

```ts
determinize(view: RedactedView, rng: Rng): MatchState
```

Sample an assignment of the unseen cards to hands, deck order, and set-aside
that satisfies every accumulated constraint. This single function serves both
consumers: marginals for the heuristic come from averaging many samples, and
search (§5) needs exactly this to have a `MatchState` to call `reduce()` on.

The correctness property is crisp and belongs in the test suite as the module's
headline gate:

> **`view(determinize(v, rng), v.own.playerId)` must deep-equal `v`.**

A sampled world the bot could distinguish from reality is a world where the bot
is either cheating or reasoning about a game that cannot exist. One assertion
catches both.

---

## 5. Deciding: two layers, not two options

The heuristic and the search are frequently posed as alternatives. They are not;
they compose, and building them in order means the first is useful before the
second exists.

### Layer 1 — the belief-driven heuristic

A linear score over features extracted from the belief state, argmax over the
legal action set. `own.legalPlays` and `own.legalTargets` are the engine's
answers; the policy ranks them and never extends them.

Features worth naming because they are not obvious from the rules:

- **`P(target holds value v)`** per candidate guess — the Informant's whole game.
- **Expected compare outcome** — `P(my remaining card > target's)` from the
  marginals. The trap the fallback policy walks into is here: playing a 3 while
  holding a 1 compares the *1*, because `reduce()` discards the played card
  before resolving. Round 2 of the live match presented exactly that choice.
- **`discardValueTotal`.** `checkRoundEnd` breaks a deck-out tie on highest card
  and *then* on the larger discard total. Shedding high cards has real endgame
  value that no reading of the rules text surfaces.
- **Turns until deck-out**, from `deckCount` and the living-player count —
  which decides whether holding the Mule is a win condition or a countdown.
- **Threat exposure**: how many unseen cards, if drawn by an opponent, kill me
  next turn. This is the number that should make a Shielded Mind feel urgent.
- **Who knows what about me**, from `COMPARE` and `TRADED` entries naming this
  seat. The Priest is deliberately *not* among them: `resolvePriest` records a
  peek and logs nothing beyond the play itself, so the table learns a
  look-at-hand card was spent but never at whom. A seat therefore cannot tell
  whether it is the one being read — which is the asymmetry that makes the card
  worth its two points.

The weights are learned (§6). The structure is hand-written, which keeps the bot
readable, debuggable, and small enough to ship as a JSON constant.

**Measured, with hand-set weights and no search at all:** one heuristic seat
against three random ones wins **87.9%** of 1,000 matches (interval 85.7–89.8,
against a 25% baseline). Inverted — three heuristic seats against one random —
the random seat is held to **0.8%**. Four heuristic seats split 26.5 / 25.5 /
24.5 / 23.5, every interval straddling 25%, which is the shape correctness takes
here and rules out a turn-order pathology in the policy itself.

The size of that gap is a caution as much as a result. Random is a very low bar,
and the next comparison that means anything is against the MCP fallback policy
and then against the trained weights. It does establish that the census
marginals carry most of the signal: nothing above searches a single ply.

### Layer 2 — ISMCTS on top

For the strong tier: sample a determinized world, run MCTS over it with the real
`reduce()`, share one statistics tree across determinizations, and use the
layer-1 heuristic as the rollout policy and action prior.

**Search calls `reduce()`. It does not model the rules.** This is the same
lesson `src/server/staticAssets.ts` records for hosting policy — *do not fork
the policy* — and the failure mode is identical in shape: a second copy of a
rule drifts, and the drift shows up as a bot that plays a game slightly
different from the one on screen, with nothing in the test run to catch it.

Search budget is a wall-clock cap, not an iteration count, so the tier behaves
the same on a phone and a workstation.

**The honest caveat.** Determinized search has two well-documented weaknesses:
*strategy fusion* (each rollout assumes perfect information from that node
onward, so the search systematically undervalues information-gathering plays —
precisely the Priest and Baron) and an inability to represent deception. Sharing
one tree across determinizations, which is what makes this ISMCTS rather than
plain Perfect-Information Monte Carlo, mitigates but does not remove them. The
practical answer is that layer 1 values information *directly* from the belief
marginals, so the two layers cover each other's blind spot. Expect the arena to
show the combined policy beating pure search.

---

## 6. Training

**Method: cross-entropy method over self-play.** Sample a population of weight
vectors, play each against the incumbent over a fixed set of seeds, keep the
elite fraction, refit the sampling distribution, repeat. It is a dozen lines,
has no hyperparameter that ruins a run, and produces a few dozen interpretable
floats.

Deliberately not a neural network, for three reasons that are about this project
rather than about ML: the client ships as a self-contained bundle and `bun run
compile` embeds every asset into one binary, so an ONNX or tfjs runtime fights
both; a weight vector is reviewable in a diff and a tensor is not; and the
feature set is small enough that the linear model is unlikely to be the binding
constraint before the search is.

**`weights.generated.ts` is generated but committed**, exactly as
`src/server/embeddedAssets.generated.ts` is, and for the same reason: `src/`
imports it, so a fresh clone that lacks it fails `bunx tsc --noEmit`. Regenerate
it with `scripts/trainAi.ts`; never hand-edit it. Unlike the asset manifest it
needs no `@ts-nocheck` — it is plain numbers with an annotated exported type.

Determinism throughout. `selfPlay.ts` takes a seed list; a training run is
reproducible; `arena.ts` reports win rate with a confidence interval, because
"54% over 200 games" is noise and reading it as progress is how a tuning loop
wastes a week.

---

## 7. Difficulty: degrade knowledge, never choice

The rule, because it decides how the bot *feels* and is the easiest thing to get
backwards:

> An easy bot should reason well about less. It should not reason badly about
> everything.

A bot that plays a random legal card reads as broken and teaches a new player
nothing. A bot that forgets a discard from four turns ago, misses that a compare
was a tie, and therefore guesses wrong, reads as a person — and its mistakes are
legible, which is what makes losing to the next tier up feel earned.

So every tier runs the *same* policy, differing only in what reaches it:

| Tier | Belief input | Search |
| --- | --- | --- |
| Easiest | Current discard piles only. No log inference, no peek memory past the current turn | None |
| Middle | Full discard counting, peeks retained, log inference limited to a sliding window of recent turns | Small budget |
| Hardest | Every constraint in §4, full history | Full budget |

Tier names are player-facing copy and therefore belong in
`src/client/content/`, not here — the same boundary that keeps every other
string a player reads out of the store.

---

## 8. Running a bot seat

`botSeat.ts` holds no socket. It registers with the room as an occupant, and
when the room's state advances to a turn it owns, it schedules a decision.

Four integration points, each of which is a bug if missed:

- **Bots are never missing seats.** `paused` and `missingSeats` in the table
  snapshot key off disconnection. A bot cannot disconnect, so it must never
  contribute to either, or a solo match starts life paused.
- **Pacing is deliberate.** An instantaneous reply reads as a scripted cutscene
  rather than an opponent, and it outruns the client's own beat cadence. The
  delay is a UIX constant, not an artifact of how long thinking took.
- **Thinking must not block the room.** One Bun process serves every room. A
  synchronous 150 ms search stalls every other socket it holds. The search
  budget is therefore a wall-clock slice with yields between iterations, and
  the budget is the thing that gets tuned, not the iteration count.
- **Bot actions go through `dispatch` unchanged.** No side door. That is what
  keeps them in `actionLog`, which is what makes a solo match replayable and
  persistable exactly like any other.

Rounds need no help — `room.ts` advances them on `revealWindowMs`, so a bot that
does nothing at round end is behaving correctly, the same property the MCP
design relies on.

---

## 9. What human match logs are actually for

Three jobs, none of which is "make the bot strong". All three read the same
persisted `{seed, actionLog}` and replay it through `reduce()`, which
`persistence.ts` already does.

**Evaluation.** Self-play win rate is circular — it measures a policy against
its own blind spots. Human games are the out-of-distribution check, and the only
evidence that a tier is calibrated to the person it is meant to entertain.

**Opponent priors, which is the one thing self-play can never learn.** Self-play
converges on beating itself; humans have habits it will therefore never model.
The seat notebooks from the live MCP match recorded one unprompted after a
single round: *"p1 opens with an informant when they have one, and guesses 4
blind."* That is a measurable empirical distribution — first-turn guess
frequencies, target preference by seat position, how often a 5 is held versus
spent — and it belongs in the **belief sampler's prior**, not in the policy.
Human data shapes what the bot thinks is likely; self-play shapes what it does
about it. Keeping those separate is what stops a strong bot from being retuned
into a weak one by a hundred games of noisy data.

**Difficulty calibration.** Which tier actually produces a 50% win rate against
a real player is an empirical question with an empirical answer, and no amount
of self-play contains it.

---

## 10. Placement and testing

Pure modules under `src/game/ai/`, collected automatically by the existing
Vitest glob. `botSeat.ts` under `src/server/`, run by `bun test src/server`.
Nothing new needs adding to `bun run test`, which is the point of the placement.

Four gates, in descending order of what they protect:

**1. The bot cannot cheat.** Two assertions. The `determinize` roundtrip of §4 —
`view(determinize(v), me)` deep-equals `v`. And a purity test in the spirit of
`src/client/__tests__/purity.test.ts`: nothing under `src/game/ai/` may import
`MatchState` outside `determinize.ts` and `search.ts`, the two modules that
construct their own. Like the client's, it reads raw file text, so the ban holds
against a comment as well as an import.

**2. The bot cannot desynchronise from the rules.** Every action a policy
returns is fed to `validateAction` in self-play, and a rejection fails the test
rather than being retried. A policy that proposes an illegal move has restated a
rule somewhere.

**3. The bot is actually good.** A seeded arena run asserting the trained policy
beats `chooseFallbackPlay` at a floor well outside the confidence interval, and
that each difficulty tier beats the one below it. Deterministic from seeds, and
directly modelled on `discardCapacity.test.ts`, which already establishes that
driving thousands of real matches inside a unit test is a thing this repo does.

**4. A solo match completes.** One integration test creating a room with three
bot seats and one scripted human, driving it to a match winner through the real
transport. The analogue of `wholeMatch.test.ts` in `src/mcp/`.

---

## 11. Staging, and what is still open

Each stage ends somewhere shippable, and stage 2 is already a playable opponent.

| Stage | Deliverable | Done when |
| --- | --- | --- |
| 1 | `Policy`, `selfPlay.ts`, `arena.ts`, with the fallback policy as the floor | Two policies play 10k seeded matches and the arena reports a win rate with an interval |
| 2 | `beliefs.ts`, `determinize.ts`, and a hand-weighted `heuristic.ts` | The roundtrip invariant holds; the heuristic beats the fallback decisively |
| 3 | `botSeat.ts` and the client entry point | A person can play a four-player match alone in a browser, start to finish |
| 4 | `scripts/trainAi.ts` and `weights.generated.ts` | The trained weights beat the hand-written ones over a held-out seed set |
| 5 | `search.ts` and the difficulty tiers | Each tier beats the one below; the hardest stays inside its wall-clock budget |

Open questions, none of which block stage 1:

- **Search cost is measured, and it is the real constraint.** `reduce()` calls
  `structuredClone` on the round every action, which is right for the engine and
  costs about 16 µs — **60,554 `reduce()` calls per second**. A 50 ms thinking
  budget therefore buys roughly 3,000 of them, and a full round is 12–16
  actions, so a naive playout-to-the-end ISMCTS gets only ~200 iterations per
  decision. That is a thin tree for a game this branchy.

  The answer is **truncated rollouts**, not a faster engine: cut the playout at
  a depth cap and score the leaf with the layer-1 heuristic instead of playing
  to a winner. Cutting at three plies multiplies iterations by roughly five for
  the same budget, and a heuristic leaf evaluation is strictly more informative
  than one random terminal. What must *not* happen is a clone-free fast path
  that forks the rules — the failure §5 already forbids.
- **Two and three players are out of scope for now.** Both set cards aside face
  down, so the exactness §4 leans on weakens, and `tokensToWin` differs. The
  belief tracker should handle unassigned mass from the start; the tuning and
  the arena can stay four-player until the four-player bot is good.
- **Sudden death is untested territory for a bot.** A tied-leaders round changes
  the participant count mid-match, and `dealRound` reuses ordinary setup for it,
  so a two-player sudden-death round burns cards like a two-player game. Worth a
  targeted arena run once stage 3 lands.
- **Whether the bot should ever bluff.** Nothing above models an opponent
  modelling the bot. It is the right thing to defer and the wrong thing to
  forget: the strongest human play in this game is making a seat *look* like it
  holds something it does not.
