# Engine Core Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> Every task follows red → green → commit. Never write implementation before its failing test.

**Goal:** Build the headless, server-authoritative game engine for The Mule's Court, matching `docs/plans/2026-07-22-engine-architecture-design.md`.

**Architecture:** A pure reducer. `reduce(state, action)` returns the next state; `view(state, playerId)` returns a redacted per-player projection. State is plain JSON — card identities only, never behavior. Behavior lives in two static tables: eleven card identities mapping onto eight effect types. No Phaser, no I/O, no ambient randomness.

**Tech Stack:** TypeScript 5.7 (strict), Vitest, Bun. No Phaser in this layer.

**Design reference:** `docs/plans/2026-07-22-engine-architecture-design.md`. Cited below as *Design §N*. Read a section before implementing against it rather than copying types from memory.

---

## Conventions (read before Task 1)

| Rule | Detail |
| --- | --- |
| Imports | Extensionless relative paths — `from './cardCatalog'`, matching `src/game/main.ts` |
| Indent | 4 spaces, matching existing source |
| Test imports | Explicit: `import { describe, it, expect } from 'vitest'`. Do **not** enable globals |
| Typecheck | `bunx tsc --noEmit` — Vite never type-checks; run this before every commit |
| Commits | **GitButler only.** `but diff` for IDs, then `but commit engine/core -m "…" --changes <ids>`. Never `git commit` |
| Branch | All work lands on virtual branch `engine/core` |
| Purity | No `Date.now()`, no `Math.random()`, no `console.log` anywhere under `src/game/engine/` |

**On worktrees:** skip them. This repo uses GitButler virtual branches, and `git checkout` / linked worktrees fight GitButler's branch management. The virtual branch gives the same isolation.

---

## Stage 1: Foundation — harness, types, static data, RNG

**Goal:** A working test runner plus the three dependency-free modules everything else imports.
**Success criteria:** `bun run test` passes; catalog totals 16 cards; one seed reproduces one shuffle.
**Status:** Not Started

### Task 1: Install and prove the test runner

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `src/game/engine/__tests__/harness.test.ts`

**Step 1: Install Vitest**

```bash
bun add -d vitest
```

**Step 2: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts']
    }
});
```

**Step 3: Add scripts to `package.json`**

```json
"test": "bunx vitest run",
"test:watch": "bunx vitest"
```

**Step 4: Write a harness test that must fail**

```ts
import { describe, it, expect } from 'vitest';

describe('test harness', () => {
    it('runs', () => {
        expect(1 + 1).toBe(3);
    });
});
```

**Step 5: Run it, confirm it FAILS**

Run: `bun run test`
Expected: 1 failed — `expected 2 to be 3`. A failure here proves the runner executes; a *pass* would mean it collected nothing.

**Step 6: Correct the assertion to `toBe(2)`, re-run, confirm PASS**

**Step 7: Verify Vitest resolves against Vite 6.** If installation reports a peer conflict, pin the Vitest major that supports Vite 6 and re-run.

**Step 8: Commit**

```bash
but diff
but commit engine/core -c -m "Add Vitest test harness" --changes <ids>
```

---

### Task 2: Core types

**Files:**
- Create: `src/game/engine/types.ts`

Transcribe every type from *Design §3, §5, §6* — `PlayerId`, `CardTypeId`, `CardInstanceId`, `EffectType`, `RngState`, `PeekRecord`, `PublicLogEntry`, `DiscardEntry`, `RoundPlayerState`, `RoundResult`, `RoundState`, `MatchPlayer`, `MatchState`, `RedactedView`, `PlayCardAction`, `GameAction`, `ValidationError`, `ValidationResult`, `CardDef`, `EffectDef`.

This file holds **types only** — no runtime code, so no test accompanies it.

**Critical details, each a real bug if missed:**
- `MatchPlayer.lastStartedRound: number` — drives the co-win round-start rule.
- `MatchState.mode: 'normal' | 'sudden-death'` and `suddenDeathPlayers: readonly PlayerId[]`.
- `MatchState.seed: string` retained alongside the live `rng`.
- `RedactedView` is declared standalone. **Never** write `Omit<MatchState, …>` — the whole anti-cheat guarantee is that no field capable of holding a hand, deck, seed, or RNG exists on this type.

**Verify:** `bunx tsc --noEmit` passes. **Commit.**

---

### Task 3: Card catalog

**Files:**
- Create: `src/game/engine/cardCatalog.ts`
- Test: `src/game/engine/__tests__/catalog.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { CARD_CATALOG, cardTypeOf } from '../cardCatalog';

describe('CARD_CATALOG', () => {
    it('contains exactly 16 physical cards', () => {
        const total = Object.values(CARD_CATALOG).reduce((sum, c) => sum + c.count, 0);
        expect(total).toBe(16);
    });

    it('defines 11 card identities', () => {
        expect(Object.keys(CARD_CATALOG)).toHaveLength(11);
    });

    it('maps paired identities onto one shared effect type', () => {
        expect(CARD_CATALOG['han-pritcher'].effectType).toBe('PRIEST');
        expect(CARD_CATALOG['bail-channis'].effectType).toBe('PRIEST');
        expect(CARD_CATALOG['ebling-mis'].effectType).toBe('BARON');
        expect(CARD_CATALOG['magnifico'].effectType).toBe('BARON');
        expect(CARD_CATALOG['bayta-darell'].effectType).toBe('PRINCE');
        expect(CARD_CATALOG['toran-darell'].effectType).toBe('PRINCE');
    });

    it('gives Informant 5 copies and every other identity its spec count', () => {
        expect(CARD_CATALOG.informant.count).toBe(5);
        expect(CARD_CATALOG['shielded-mind'].count).toBe(2);
        expect(CARD_CATALOG.mule.count).toBe(1);
    });

    it('recovers the card type from an instance id', () => {
        expect(cardTypeOf('informant#3')).toBe('informant');
        expect(cardTypeOf('first-speaker#0')).toBe('first-speaker');
    });
});
```

**Step 2: Run, confirm FAIL** — `Cannot find module '../cardCatalog'`.

**Step 3: Implement** the eleven-row table from *Design §4* plus `cardTypeOf` and `makeCardInstanceId`.

`cardTypeOf` must split on the **last** `#`, since slugs like `first-speaker` contain a hyphen but no `#`. `id.slice(0, id.lastIndexOf('#'))` is safest.

**Step 4: Run, confirm PASS. Step 5: `bunx tsc --noEmit`. Step 6: Commit.**

---

### Task 4: Seeded RNG

**Files:**
- Create: `src/game/engine/rng.ts`
- Test: `src/game/engine/__tests__/rng.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { seedRng, nextRng, shuffle } from '../rng';

describe('rng', () => {
    it('produces the same stream for the same seed', () => {
        const a = nextRng(seedRng('mule'));
        const b = nextRng(seedRng('mule'));
        expect(a.value).toBe(b.value);
        expect(a.rng).toEqual(b.rng);
    });

    it('produces different streams for different seeds', () => {
        expect(nextRng(seedRng('alpha')).value).not.toBe(nextRng(seedRng('beta')).value);
    });

    it('returns values within [0, 1)', () => {
        let rng = seedRng('range');
        for (let i = 0; i < 500; i++) {
            const step = nextRng(rng);
            expect(step.value).toBeGreaterThanOrEqual(0);
            expect(step.value).toBeLessThan(1);
            rng = step.rng;
        }
    });

    it('shuffles deterministically and preserves every element', () => {
        const input = [1, 2, 3, 4, 5, 6, 7, 8];
        const first = shuffle(input, seedRng('deck'));
        const second = shuffle(input, seedRng('deck'));
        expect(first.shuffled).toEqual(second.shuffled);
        expect([...first.shuffled].sort()).toEqual(input);
    });

    it('leaves the input array untouched', () => {
        const input = [1, 2, 3];
        shuffle(input, seedRng('pure'));
        expect(input).toEqual([1, 2, 3]);
    });
});
```

**Step 2: Run, confirm FAIL. Step 3: Implement** mulberry32 + FNV-1a + Fisher-Yates from *Design §8*.

**Step 4: Run, confirm PASS. Step 5: Add the purity guard test:**

```ts
it('never calls Date.now or Math.random anywhere in the engine', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const walk = (dir: string): string[] =>
        readdirSync(dir).flatMap(entry => {
            const full = join(dir, entry);
            return statSync(full).isDirectory() ? walk(full) : [full];
        });
    const sources = walk('src/game/engine')
        .filter(f => f.endsWith('.ts') && !f.includes('__tests__'));
    for (const file of sources) {
        const text = readFileSync(file, 'utf8');
        expect(text, `${file} must stay deterministic`).not.toMatch(/Date\.now|Math\.random/);
    }
});
```

**Step 6: Run, confirm PASS. Step 7: `bunx tsc --noEmit`. Step 8: Commit.**

---

## Stage 2: Legality and validation

**Goal:** One shared implementation of "what may be played and targeted," consumed later by both the validator and `view()`.
**Success criteria:** Forced-play, protection, self-target, and fizzle rules all enforced; every `ValidationError` variant has a passing and a failing case.
**Status:** Not Started

### Task 5: Effect registry

**Files:**
- Create: `src/game/engine/effectRegistry.ts`
- Create: `src/game/engine/resolvers/noop.ts`
- Test: `src/game/engine/__tests__/effectRegistry.test.ts`

Build `EFFECT_DEFS` from *Design §4* with metadata only; point every `resolve` at `noopResolve` for now and replace them in Stage 3.

**Test these invariants:**
- Exactly 8 effect types exist.
- `PRINCE` alone sets `canTargetSelf`.
- `GUARD` alone sets `requiresGuess`.
- `PRINCESS` alone sets `eliminatesOnDiscard`.
- `COUNTESS.forcedPlayTriggers` equals `['KING', 'PRINCE']`; every other type's is empty.
- Every `CardTypeId` in `CARD_CATALOG` maps to a key present in `EFFECT_DEFS`.

**Red → green → typecheck → commit.**

---

### Task 6: Legality rules

**Files:**
- Create: `src/game/engine/legality.ts`
- Test: `src/game/engine/__tests__/legality.test.ts`

Write a local `makeRound(overrides)` helper in the test file that builds a minimal `RoundState`. Later suites reuse this shape, so keep it small and obvious.

**`computeLegalPlays(round, playerId)` — required cases:**
- A hand without First Speaker returns both cards.
- First Speaker + Mayor Indbur (KING) returns **only** the First Speaker instance.
- First Speaker + a Darell (PRINCE) returns **only** the First Speaker instance.
- First Speaker + Informant (GUARD) returns **both** — GUARD is not a trigger.
- A one-card hand returns that card.

**`computeLegalTargets(round, actorId, effectDef)` — required cases:**
- Excludes eliminated players.
- Excludes protected opponents.
- Excludes the actor when `canTargetSelf` is false.
- **Includes the actor when `canTargetSelf` is true, even while the actor is protected.**
- **Excludes a protected opponent even when `canTargetSelf` is true.** This is the audited bug the design fixes — write this test explicitly.
- Returns `[]` when every opponent is protected or eliminated and the effect forbids self-targeting.

**Implementation shape — do not collapse these two branches into one predicate:**

```ts
const isLegalTarget = (pid: PlayerId): boolean =>
    pid === actorId
        ? effectDef.canTargetSelf
        : round.players[pid].alive && !round.players[pid].protected;
```

**Red → green → typecheck → commit.**

---

### Task 7: Action validation

**Files:**
- Create: `src/game/engine/validation.ts`
- Test: `src/game/engine/__tests__/validation.test.ts`

Implement `validateAction` in the exact check order from *Design §5*. Return `{ ok: false, error }`; never throw on client input.

**Write one passing and one failing case per `ValidationError` variant**, plus these adversarial attempts:
- Playing a second card while holding First Speaker + King → `FORCED_PLAY_VIOLATION`.
- Supplying a target when the legal-target set is empty → `TARGET_NOT_ALLOWED`.
- Guessing `'informant'` → `GUESS_CANNOT_BE_INFORMANT`.
- A Prince targeting a protected opponent → `TARGET_NOT_LEGAL`.
- Playing on another player's turn → `NOT_YOUR_TURN`.
- Naming a card instance absent from the hand → `CARD_NOT_IN_HAND`.

Ban the Informant guess by **identity** (`guess === 'informant'`), never by value.

**Red → green → typecheck → commit.**

---

## Stage 3: Shared primitives and resolvers

**Goal:** All eight effects resolve correctly, with every elimination routed through one primitive.
**Success criteria:** One test file per effect type; the paired identities prove identical behavior.
**Status:** Not Started

### Task 8: Discard and elimination primitives

**Files:**
- Create: `src/game/engine/discard.ts`
- Test: `src/game/engine/__tests__/discard.test.ts`

Implement `discardPlayedCard(round, playerId, instanceId)` and `eliminate(round, playerId)`.

**`eliminate` must, in one place:** move the player's remaining card to their public `discardPile`, add its value to `discardValueTotal`, and set `alive` to false. Test that a player eliminated with a card in hand ends with that card **public** — this is the rule three of four candidate designs forgot.

**`discardPlayedCard` must:** remove the named instance from the hand, append it to `discardPile`, add its value to `discardValueTotal`, and — when the card's effect sets `eliminatesOnDiscard` — eliminate the actor.

**Test:** playing The Mule voluntarily leaves the actor dead with **both** cards in their discard pile.

**Red → green → typecheck → commit.**

---

### Tasks 9–14: One resolver per effect type

Create `src/game/engine/resolvers/<name>.ts` and `src/game/engine/__tests__/resolvers/<name>.test.ts`, then point `EFFECT_DEFS` at the real function. **One task per resolver, one commit each.**

Every resolver runs **after** `discardPlayedCard`, so the actor's hand holds at most one card on entry. Write each test fixture that way.

| Task | Resolver | Required test cases |
| --- | --- | --- |
| 9 | `guard` | Correct guess eliminates and reveals the victim's card; wrong guess changes nothing but the log; absent target fizzles |
| 10 | `priest` | Appends exactly one `PeekRecord` keyed to `(actor, target, instance)`; absent target fizzles |
| 11 | `baron` | Higher value survives; **a tie eliminates nobody yet still writes both peek records**; the loser's card becomes public; absent target fizzles |
| 12 | `handmaid` | Sets the actor's `protected` flag and takes no target |
| 13 | `prince` | Opponent discards and redraws; **self-target discards the actor's remaining card**; discarding the Mule eliminates and **skips the redraw**; an empty deck draws the set-aside; an empty deck with no set-aside leaves a zero-length hand |
| 14 | `king` | Swaps two single-card hands; creates no peek records; a prior peek about either traded card stops resolving |

The Prince self-target case is the one the purity candidate got wrong. Assert the actor discards the **other** card, never the Prince itself.

---

## Stage 4: Setup and orchestration

**Goal:** Deal a match, run a turn end to end, resolve rounds and matches.
**Success criteria:** A full scripted round plays to a winner; sudden death triggers on a simultaneous token target.
**Status:** Not Started

### Task 15: Match and round setup

**Files:** `src/game/engine/setup.ts`, test alongside.

`createMatch(playerIds, seed)` builds all 16 instances, shuffles, applies the per-count removal table, deals one card each, and draws for the first player.

**Test the removal table exactly:** 2 players → 1 face-up + 2 face-down, deck 11. 3 players → 1 face-down, deck 12. 4 players → none removed, deck 12. Also assert `tokensToWin` resolves to 7 / 5 / 4.

Add `dealNextRound`, accepting the participant subset so sudden death reuses it unchanged.

### Task 16: Turn advance and round end

**Files:** extend `src/game/engine/discard.ts`, test alongside.

`advanceTurn` must **clear the incoming player's `protected` flag first**, then skip dead players, then draw.

`checkRoundEnd` detects the last survivor, then deck-out. Run the deck-out check **after** the play resolves and **before** the next draw — that ordering is what matches "a round ends when a player cannot draw."

**Test:** last-survivor win; deck-out won on high card; a tie broken by `discardValueTotal`; a double tie producing `winnerIds.length > 1`; `revealedHands` populated on deck-out; an empty hand ranking below every card.

### Task 17: The reduce pipeline

**Files:** `src/game/engine/reduce.ts`, test alongside.

Sequence exactly: `validateAction` → `discardPlayedCard` → `resolve` (only while the actor lives) → `checkRoundEnd` → `advanceTurn` | `dealNextRound` | set `matchWinnerId`.

**Discarding before resolving is mandatory.** Reversing it reintroduces the wrong-card bug in Baron, King, and self-Prince. Add a regression test proving a Baron play compares the actor's *other* card.

Append each validated action to `actionLog`.

### Task 18: Round-start rule and sudden death

**Files:** extend `setup.ts` and `reduce.ts`, test alongside.

**Round start:** the previous winner leads. On a co-win, choose the tied player with the highest `lastStartedRound`. When none has ever led, fall back to turn order in the round just ended. Stamp `lastStartedRound` whenever a player takes a round's first turn.

**Sudden death:** when a token award carries two or more players to `tokensToWin` at once, set `mode` to `'sudden-death'`, record those players, and deal among only them. A single-winner round sets `matchWinnerId`. A further tie narrows the participant set and deals again.

**Test:** a two-way simultaneous target-reach enters sudden death rather than ending; a clean sudden-death round ends the match; a tied sudden-death round deals again with the narrowed set.

---

## Stage 5: Redaction, public API, and integration

**Goal:** Clients receive only what they may see, and the whole engine replays deterministically.
**Success criteria:** The leak fuzzer passes after every single `reduce` across a scripted multi-round match.
**Status:** Not Started

### Task 19: The redacted view

**Files:** `src/game/engine/view.ts`, test alongside.

Build `RedactedView` field by field per *Design §6*. `deckCount` is an integer — never an array, not even null-padded.

Resolve peek records **live** on every call: surface a record only when its `roundNumber` matches and the subject still holds that exact instance. Never mutate or delete records in a resolver.

Add `broadcastViews(match, playerIds)`.

### Task 20: Public API barrel

**Files:** `src/game/engine/index.ts`, test alongside.

Re-export only the sanctioned surface from *Design §11*. **Test that internals stay private** — importing the barrel must expose no resolver, no RNG internal, and no `discard.ts` primitive.

### Task 21: The redaction leak fuzzer

**Files:** `src/game/engine/__tests__/view-redaction.test.ts`

Script a multi-round, 4-player match. After **every** `reduce`, for **every** player, assert:
- `JSON.stringify(view(...))` contains no `CardInstanceId` the viewer may not see (deck, set-aside, another hand).
- It contains no `rng` and no `seed`.
- **It still contains the viewer's own hand and every peek they are entitled to.**

That last assertion matters as much as the others. A redaction test checking only absence passes when the projection returns nothing at all.

### Task 22: Replay determinism

**Files:** `src/game/engine/__tests__/replay-determinism.test.ts`

- The same seed and action sequence, run twice, deep-equal.
- `JSON.parse(JSON.stringify(state))` deep-equals `state` — the plain-serializability contract.
- Replaying from the stored `seed` plus `actionLog` reproduces a live-played match.

### Task 23: Named edge-case suite

**Files:** `src/game/engine/__tests__/edgeCases.test.ts`

One test per ruling in *Design §9*, named to match, giving direct traceability from each audit finding to the regression test that catches it. Include the two rules settled in brainstorming: the co-win round-start tiebreak and sudden death.

---

## Definition of done

- [ ] `bun run test` — every suite passes
- [ ] `bunx tsc --noEmit` — clean
- [ ] No `Date.now`, `Math.random`, or `console.*` under `src/game/engine/`
- [ ] `src/game/engine/index.ts` exports only the sanctioned surface
- [ ] Every ruling in *Design §9* has a named test
- [ ] Work committed on `engine/core`; PR opened against `main`

**Out of scope:** transport, lobby, matchmaking, reconnection, and all Phaser rendering. The engine must remain importable in a plain Node process with no DOM.
