# The Mule's Court — Game Engine Architecture

**Date:** 2026-07-22
**Status:** Approved. Ready for implementation planning.
**Scope:** The headless game engine only.

---

## 1. Scope

This design covers the engine core:

- the state model (match wrapping rounds),
- card-ability resolution,
- per-player view redaction,
- action validation,
- seeded, deterministic randomness.

It deliberately excludes the transport protocol, lobby, matchmaking, presence, and reconnection. Those need their own design. The engine stays identical no matter which transport wraps it, so nailing the engine first carries no rework risk.

### Constraints

Five constraints govern every decision below. The game ships as **online multiplayer**, and that single choice forces the rest.

1. **Server authority.** The engine runs on a trusted server. Clients are untrusted.
2. **Plain serializable state.** State holds card IDs and primitives — never functions, closures, or class instances. Behavior lives in a separate stateless registry.
3. **Per-player redaction.** A pure projection, `view(state, playerId)`, reveals to each player only what they may see. Deduction is the whole game; leaking a hand ends it.
4. **Determinism.** Shuffling draws from a seeded RNG stored in state. The engine calls neither `Date.now()` nor `Math.random()`. The same seed and the same actions always produce the same result.
5. **Validation before mutation.** The engine re-derives legality from true server state and rejects illegal actions. It never trusts a client's claim.

Constraint 3 deserves emphasis. If the engine ran on the client, every player could read opponents' hands and the deck order straight out of memory. Server authority is a requirement here, not a preference.

---

## 2. Architecture overview

The engine is a pure module under `src/game/engine/`, free of Phaser and free of I/O. Four functions form its entire gameplay surface:

```ts
createMatch(playerIds, seed)   → MatchState                              // pure setup
reduce(match, action)          → { ok: true; state } | { ok: false; error }  // SERVER-ONLY
validateAction(match, action)  → ValidationResult                        // pure legality gate
view(match, playerId)          → RedactedView                            // the only client-facing output
```

Three ideas carry the design.

**Identity differs from behavior.** Eleven card identities map onto eight effect types through a single `effectType` field. Han Pritcher and Bail Channis share the `PRIEST` behavior but keep separate names, values, and portraits. State stores identities; the registry supplies behavior.

**One action, one reducer.** Love Letter contains no chained sub-decisions — a card's target and guess are both known the moment a player chooses it. So the client-facing surface is exactly one action type, and a turn resolves in one synchronous call. No "awaiting target" protocol exists.

**`view()` is the security boundary.** The server holds the full `MatchState`. Each client receives only its own projection.

---

## 3. State model

A match wraps rounds. Tokens and the RNG persist across rounds; everything else resets when a new round is dealt.

```ts
type PlayerId       = string;                    // stable seat id, fixed for the match
type CardTypeId     = 'informant' | 'han-pritcher' | 'bail-channis' | 'ebling-mis'
                    | 'magnifico' | 'shielded-mind' | 'bayta-darell' | 'toran-darell'
                    | 'mayor-indbur' | 'first-speaker' | 'mule';
type CardInstanceId = `${CardTypeId}#${number}`;  // e.g. "informant#3"
type EffectType     = 'GUARD' | 'PRIEST' | 'BARON' | 'HANDMAID'
                    | 'PRINCE' | 'KING' | 'COUNTESS' | 'PRINCESS';

interface MatchPlayer {
  readonly id: PlayerId;
  readonly seat: number;
  readonly tokens: number;
  readonly lastStartedRound: number;   // most recent round this player led; 0 if never
}

interface MatchState {
  readonly schemaVersion: 1;
  readonly matchId: string;
  readonly playerCount: 2 | 3 | 4;
  readonly tokensToWin: 7 | 5 | 4;
  readonly players: readonly MatchPlayer[];
  readonly seed: string;                        // original seed, kept for replay from genesis
  readonly rng: RngState;                       // SERVER-ONLY; threads across rounds
  readonly mode: 'normal' | 'sudden-death';
  readonly suddenDeathPlayers: readonly PlayerId[];  // empty in normal mode
  readonly round: RoundState;
  readonly matchWinnerId: PlayerId | null;
  readonly actionLog: readonly PlayCardAction[];
}

interface RoundPlayerState {
  readonly id: PlayerId;
  readonly hand: readonly CardInstanceId[];       // 0, 1, or 2 cards
  readonly discardPile: readonly DiscardEntry[];  // PUBLIC, oldest first
  readonly discardValueTotal: number;             // running sum, never recomputed
  readonly alive: boolean;
  readonly protected: boolean;
}

interface RoundState {
  readonly roundNumber: number;
  readonly seatOrder: readonly PlayerId[];
  readonly currentPlayerIndex: number;
  readonly turnNumber: number;                        // audit trail only
  readonly deckOrder: readonly CardInstanceId[];      // SERVER-ONLY
  readonly setAsideFaceDown: readonly CardInstanceId[]; // SERVER-ONLY (2p:2, 3p:1, 4p:0)
  readonly setAsideFaceUp: CardInstanceId | null;     // PUBLIC (2p only)
  readonly players: Readonly<Record<PlayerId, RoundPlayerState>>;
  readonly privateKnowledge: readonly PeekRecord[];   // SERVER-ONLY
  readonly publicLog: readonly PublicLogEntry[];      // PUBLIC
  readonly phase: 'awaiting-play' | 'round-over';
  readonly roundResult: RoundResult | null;
}

interface RoundResult {
  readonly reason: 'last-survivor' | 'deck-out';
  readonly winnerIds: readonly PlayerId[];            // more than one on a co-win
  readonly revealedHands?: Readonly<Record<PlayerId, CardTypeId | null>>;  // deck-out only
}
```

Two properties matter most.

**Every physical card carries a `CardInstanceId`.** The engine assigns all sixteen instances from the static catalog before the shuffle. The format stays public; only an instance's *location* stays secret. Instance IDs make replay exact and remove any ambiguity when a hand holds two cards of one type.

**`discardValueTotal` accumulates incrementally.** The deck-out tiebreak reads a field rather than folding over history, so it cannot drift.

---

## 4. Card identity and effect behavior

Two static tables hold all rules data. Neither ever enters game state.

**`CARD_CATALOG` — eleven identities:**

```ts
interface CardDef {
  readonly id: CardTypeId;
  readonly displayName: string;
  readonly value: 1|2|3|4|5|6|7|8;
  readonly count: number;
  readonly assetSlug: string;      // public/assets/<slug>/portrait_*.png
  readonly effectType: EffectType; // the only link from identity to behavior
}
```

| Card | Value | Count | Asset slug | Effect type |
| --- | --- | --- | --- | --- |
| Informant | 1 | 5 | `informant` | `GUARD` |
| Han Pritcher | 2 | 1 | `han-pritcher` | `PRIEST` |
| Bail Channis | 2 | 1 | `bail-channis` | `PRIEST` |
| Ebling Mis | 3 | 1 | `ebling-mis` | `BARON` |
| Magnifico Giganticus | 3 | 1 | `magnifico` | `BARON` |
| Shielded Mind | 4 | 2 | `shielded-mind` | `HANDMAID` |
| Bayta Darell | 5 | 1 | `bayta-darell` | `PRINCE` |
| Toran Darell | 5 | 1 | `toran-darell` | `PRINCE` |
| Mayor Indbur | 6 | 1 | `mayor-indbur` | `KING` |
| The First Speaker | 7 | 1 | `first-speaker` | `COUNTESS` |
| The Mule | 8 | 1 | `mule` | `PRINCESS` |

Counts total sixteen. A test asserts it.

**`EFFECT_DEFS` — eight behaviors:**

```ts
interface EffectDef {
  readonly effectType: EffectType;
  readonly requiresTarget: boolean;
  readonly canTargetSelf: boolean;                    // PRINCE only
  readonly requiresGuess: boolean;                    // GUARD only
  readonly isPassive: boolean;                        // HANDMAID, COUNTESS, PRINCESS
  readonly eliminatesOnDiscard: boolean;              // PRINCESS only
  readonly forcedPlayTriggers: readonly EffectType[]; // COUNTESS: ['KING','PRINCE']
  readonly resolve: EffectResolver;
}
```

Two cards need no resolver at all. First Speaker and The Mule both resolve to a no-op; their behavior lives in metadata. `forcedPlayTriggers` drives the validator, and `eliminatesOnDiscard` drives the generic discard step.

### The `reduce()` pipeline

Every `PLAY_CARD` action runs the same fixed sequence:

```
validateAction
  → discardPlayedCard   remove the played instance from the actor's hand;
                        if eliminatesOnDiscard, eliminate the actor
  → resolve             dispatch EFFECT_DEFS[effectType].resolve, only if the actor still lives
  → checkRoundEnd       last survivor, then deck-out with reveal and tiebreak
  → advanceTurn | dealNextRound | set matchWinnerId
```

**Discard before resolve.** This ordering is the design's linchpin. Once the played instance leaves the actor's hand, the actor's remaining hand holds at most one card. Baron's comparison, King's swap, and a self-targeted Prince's discard all become unambiguous, with no index arithmetic and no filtering. Resolving first and discarding afterward — the obvious order — lets `hand[0]` grab the very card being played and misplays roughly half of all Baron and King turns.

### The `eliminate()` primitive

One function removes a player's remaining card, moves it to their public discard pile, adds its value to `discardValueTotal`, and clears `alive`. Exactly four sites call it: a voluntary Mule play, a Prince-forced Mule discard, an Informant hit, and a Baron loss. Routing every elimination through one primitive makes "an eliminated player's card becomes public" true by construction rather than by discipline at four call sites.

### Effect resolution

| Effect | Cards | Resolution |
| --- | --- | --- |
| `GUARD` | Informant | Compare the **value** of the target's single card against the guessed value. On a hit, call `eliminate()`. On a miss, log only. |
| `PRIEST` | Han Pritcher, Bail Channis | Append one `PeekRecord` naming the target's card, visible to the actor alone. |
| `BARON` | Ebling Mis, Magnifico | Append two mutual `PeekRecord`s **before** comparing, then eliminate the lower value. Equal values eliminate nobody. |
| `HANDMAID` | Shielded Mind | Set the actor's `protected` flag. |
| `PRINCE` | Bayta Darell, Toran Darell | Discard the target's single card. If it is the Mule, eliminate them and skip the redraw. Otherwise draw from the deck, else the face-down set-aside, else leave the hand empty. |
| `KING` | Mayor Indbur | Swap the two single-card hands atomically. Create no new peek records. |
| `COUNTESS` | The First Speaker | No-op. The forced-play rule lives in `legality.ts`. |
| `PRINCESS` | The Mule | No-op. Elimination on discard lives in `discard.ts`. |

---

## 5. Actions and validation

One action type covers all play:

```ts
interface PlayCardAction {
  readonly type: 'PLAY_CARD';
  readonly playerId: PlayerId;
  readonly cardInstanceId: CardInstanceId; // the exact physical card
  readonly target?: PlayerId;              // omitted when no legal target exists
  readonly guess?: CardTypeId;             // Informant only; never 'informant'
}
```

`validateAction` runs these checks in order and returns a typed error rather than throwing:

1. The round accepts plays and the match continues.
2. The claimed player is the true current player.
3. The named instance sits in that player's hand.
4. The instance appears in `computeLegalPlays(round, playerId)`. This single check enforces the entire First Speaker forced-play rule.
5. Compute `computeLegalTargets`. A candidate is legal when — for the actor — the effect permits self-targeting, and — for every opponent — that opponent lives and stands unprotected.
6. When the effect requires a target: an empty legal-target set demands an omitted target (the fizzle); a non-empty set demands a target drawn from it.
7. When the effect requires a guess and a target exists, the guess must be an integer value the deck contains and must not be 1, the Informant's own value.

Rule 5 splits the actor's check from each opponent's check deliberately. A single combined predicate — `canTargetSelf || !isProtected(pid)` — reads well and lets a Prince target a *protected opponent*, an audited bug in one candidate design.

`computeLegalPlays` and `computeLegalTargets` each have exactly one implementation, imported by both `validateAction` and `view()`. The legality a client displays and the legality the server enforces therefore cannot drift.

---

## 6. Redaction and private knowledge

`view(match, playerId)` produces the only value that may reach a client.

**`RedactedView` is a structurally distinct type — never `Omit<MatchState, …>`.** It holds no field capable of carrying a deck order, a set-aside card, the RNG, the seed, the action log, or another player's hand. Leaking hidden state becomes a compile error instead of a filtering bug a reviewer must catch by inspection.

```ts
interface RedactedView {
  readonly matchId: string;
  readonly playerCount: number;
  readonly tokensToWin: number;
  readonly players: ReadonlyArray<{
    readonly id: PlayerId; readonly seat: number; readonly tokens: number;
    readonly alive: boolean; readonly protected: boolean;
    readonly discardPile: readonly { cardId: CardTypeId; value: number }[];
    readonly discardValueTotal: number;
  }>;
  readonly deckCount: number;                  // an integer, never an array
  readonly setAsideFaceUp: CardTypeId | null;  // 2p public burn only
  readonly currentPlayerId: PlayerId;
  readonly turnNumber: number;
  readonly publicLog: readonly PublicLogEntry[];
  readonly own: {
    readonly playerId: PlayerId;
    readonly hand: readonly CardInstanceId[];
    readonly legalPlays: readonly CardInstanceId[];  // populated only on your turn
  };
  readonly revealed: ReadonlyArray<{ subjectId: PlayerId; cardTypeId: CardTypeId }>;
  readonly roundResult: RoundResult | null;
  readonly matchWinnerId: PlayerId | null;
}
```

`deckCount` reports an integer rather than a padded array, which closes the classic positional leak.

### Private knowledge

Priest peeks and Baron comparisons append a `PeekRecord` bound to an immutable triple:

```ts
interface PeekRecord {
  readonly id: string;
  readonly kind: 'priest' | 'baron';
  readonly viewerId: PlayerId;
  readonly subjectId: PlayerId;
  readonly cardInstanceId: CardInstanceId;  // bound to the instance, never to a slot
  readonly cardTypeId: CardTypeId;
  readonly roundNumber: number;
  readonly createdAtTurn: number;
}
```

No resolver ever mutates or deletes a record. Instead `view()` recomputes each record's currency on every call: a record surfaces only when its round matches and the subject still holds that exact instance. The moment a King trade, a Prince redraw, or an ordinary play changes that hand, the record stops rendering — with no cleanup code anywhere.

Binding knowledge to the instance rather than to a hand position is what makes this correct. A slot-bound design would show you the subject's *replacement* card after a trade, a silent leak.

Baron writes two records, unconditionally and before the tie check; the mutual reveal always happens, and only the elimination depends on the comparison. King writes none, because each trader simply holds and sees a new card.

`reduce()` returns the full `MatchState` for server-side persistence alone. Every transport-facing signature returns `RedactedView`, and `broadcastViews(state, playerIds)` gives transport authors a sanctioned wrapper so nobody hand-rolls per-client serialization.

---

## 7. Round and match resolution

### Ending a round

A round ends when one player remains, or when the deck empties. The engine checks for deck-out after resolving a play and before the next player draws, which matches the physical rule that a round ends when a player cannot draw.

On deck-out, every survivor reveals. The highest hand value wins. Equal values break on `discardValueTotal`. Players tied on both **share the win**, and each earns a Devotion Token. `RoundResult.revealedHands` records the showdown and reaches clients once the round ends, so a declared winner is never unexplained.

### Starting the next round

The player who won the previous round leads the next.

When a round ends in a co-win, the tie breaks toward **the co-winner who most recently won a token** — equivalently, whoever most recently led a round, since a round's leader is the previous round's winner. The engine reads `lastStartedRound` and picks the highest. A co-winner who led the round that just tied therefore leads again.

Should no co-winner have ever led a round, the engine falls back to turn order within the round just ended, taking the tied player reached earliest from that round's leader. This case can arise only before either player holds a token.

### Ending the match

A player who reaches `tokensToWin` alone wins the match.

When a co-win carries **two or more players to the target at once**, the match continues into **sudden death**. The engine sets `mode` to `sudden-death`, records the tied leaders in `suddenDeathPlayers`, and deals a fresh round among only them, using the normal setup for that participant count. A sudden-death round with a single winner ends the match. A sudden-death round that ties again narrows `suddenDeathPlayers` to those co-winners and deals again, repeating until one player wins cleanly.

Token totals stop deciding the match in sudden death; a clean round win decides it. The engine still increments tokens so the interface can display them.

Sudden death reuses the round engine untouched. Only `setup.ts`, which deals to a subset, and the match-end check learn about `mode`. No card logic changes.

---

## 8. Determinism and randomness

A single-field mulberry32 generator supplies all randomness as plain, immutable data. Its state advance is a bare constant addition — a bijection over 32-bit integers, so the stream has a full period and distinct seeds never converge. The mixing steps shape the output only and must never feed back into the state:

```ts
interface RngState { readonly s: number; }
function nextRng(rng: RngState): { rng: RngState; value: number };
function shuffle<T>(items: readonly T[], rng: RngState): { shuffled: T[]; rng: RngState };
function seedRng(seed: string): RngState;   // FNV-1a fold of the seed string
```

`MatchState` stores both the original `seed` and the current `rng`. One continuous stream threads the whole match; rounds never re-seed. Only shuffling consumes randomness — no resolver does. Given the same `seed` and `actionLog`, replaying `createMatch` and every `reduce` reproduces an identical `MatchState`.

---

## 9. Edge-case rulings

| Edge case | Ruling |
| --- | --- |
| Informant names itself | Rejected on identity (`guess === 'informant'`), never on value, so the rule survives a future value-1 card. |
| No legal target exists | The player still plays and discards the card; the effect does nothing and the log records a fizzle. |
| Prince and the fizzle rule | Prince never fizzles, because the actor always counts as a legal target. |
| Shielded Mind window | A boolean, cleared unconditionally at the start of that player's own next turn — never by a stored expiry number. |
| Prince targeting | The actor may target themselves; no card may ever target a protected opponent. |
| Baron, King, self-targeted Prince | Read the correct card by construction, because the played card leaves the hand first. |
| Prince forces a Mule discard | The target is eliminated and draws no replacement. |
| Empty deck, no set-aside (4 players) | The target keeps an empty hand, which ranks below every card value at the showdown. |
| Baron tie | Both players still learn each other's card; only the elimination is skipped. |
| Informant hit, Baron loss | The victim's card enters their public discard pile through `eliminate()`. |
| Priest peek after a trade or redraw | Invalidates automatically through the live instance check. |
| The Mule discarded | The same rule applies to a voluntary play and to a Prince-forced discard. |
| Deck-out double tie | All tied players share the round win and each earns a token. |
| Two players reach the target together | Sudden death decides the match. |

---

## 10. Key decisions

| Decision | Rationale | Rejected alternative |
| --- | --- | --- |
| Discard the played card before resolving | Reduces the actor's hand to one card, which removes the Baron, King, and self-Prince wrong-card bugs structurally | Resolve first, then discard, filtering the played instance at each call site — duplicated logic in three resolvers |
| Actions name a `CardInstanceId` | Removes duplicate-copy ambiguity and makes replay exact | Selecting by `CardTypeId`, which forces resolvers to guess which copy |
| One shared `eliminate()` primitive | Makes the public-reveal rule true by construction at all four elimination sites | Per-resolver elimination handling, which three candidate designs got wrong |
| `protected` as a positional boolean | Matches the rule's own wording and needs no invariant about mid-window eliminations | A precomputed expiry turn number compared against a counter |
| Self-target exemption applies only to the actor | Prevents a Prince from targeting a protected opponent | A single disjunctive predicate shared by actor and opponents |
| `RedactedView` as a distinct type | Turns an accidental raw-state forward into a compile error | Prose documentation and reviewer vigilance |
| Eight effect types, keeping `COUNTESS` and `PRINCESS` apart | Their metadata differs; merging them would overload one no-op row with unrelated flags | A single shared `NOOP` effect type |
| Peek records bound to `(viewer, subject, instance)` and checked live | A moved card stops rendering with no cleanup code and no misattribution | Slot-bound knowledge, which misreports a card after a King trade |
| Single-field mulberry32 RNG | Simple to verify by hand and easy to thread across rounds | A four-word xorshift128, more machinery for no benefit at sixteen cards |

---

## 11. File layout

```
src/game/engine/
  types.ts            shared types only; no runtime code
  cardCatalog.ts      CARD_CATALOG, cardTypeOf, makeCardInstanceId
  effectRegistry.ts   EFFECT_DEFS, wiring metadata to resolvers
  resolvers/
    guard.ts  priest.ts  baron.ts  handmaid.ts  prince.ts  king.ts  noop.ts
  rng.ts              seedRng, nextRng, shuffle
  setup.ts            createMatch, dealNextRound (incl. sudden-death subsets)
  legality.ts         computeLegalPlays, computeLegalTargets
  validation.ts       validateAction
  discard.ts          discardPlayedCard, eliminate, advanceTurn, checkRoundEnd
  reduce.ts           reduce — sequences the pipeline
  view.ts             view, broadcastViews
  index.ts            public API barrel
```

`index.ts` exports `createMatch`, `reduce`, `validateAction`, `view`, `broadcastViews`, `computeLegalPlays`, `computeLegalTargets`, `CARD_CATALOG`, `EFFECT_DEFS`, `isMatchOver`, `getMatchWinner`, and the public types. It exports no resolver, no RNG internal, and no primitive from `discard.ts`.

---

## 12. Test strategy

The project has no test runner today, so implementation starts by adding **Vitest** and wiring it into `package.json`. A pure engine repays test-first development completely: no mocks, no fake timers, no async. Every test calls a function and compares values.

Nine suites, cheapest first:

1. `catalog.test.ts` — counts total sixteen; values, counts, and effect types match the table.
2. `rng.test.ts` — one seed yields one stream; a source scan proves no `Date.now()` or `Math.random()` appears in the engine.
3. `setup.test.ts` — deck sizes after the deal (11, 12, 12) and burn composition per player count.
4. `resolvers/*.test.ts` — one file per effect type; paired identities share a parametrized case.
5. `validation.test.ts` — each error fires and its adjacent legal case passes, plus deliberate bypass attempts.
6. `view-redaction.test.ts` — after **every** `reduce` in a scripted multi-round game, each player's view contains no card they may not see, no `rng`, and no `seed`, **and still contains** everything they may see.
7. `roundEnd.test.ts` — last survivor; deck-out; discard-sum tiebreak; shared co-win; the empty-hand reveal.
8. `replay-determinism.test.ts` — the same seed and actions twice deep-equal; `JSON.parse(JSON.stringify(state))` deep-equals state.
9. `edgeCases.test.ts` — one named test per ruling in section 9, including the co-win round-start rule and sudden death.

Suite 6 checks presence as well as absence deliberately. A redaction test that only asserts absence passes when the projection returns nothing at all.

---

## 13. Deferred

- Transport protocol, hosting, lobby, matchmaking, presence, reconnection.
- Whether `{seed, actionLog}` alone suffices as persisted history, or whether spectating and undo demand snapshots.
- How the interface labels two same-type cards, now that actions name instances.
- All Phaser rendering.

---

## 14. Risks

- `reduce()` does substantial work in one call: resolve, possibly advance a turn, possibly deal a new round, possibly end a match. Named phase functions keep it testable, but integration tests must cover every branch.
- The type split between `MatchState` and `RedactedView` stops accidental leaks, not deliberate casts. Pair it with suite 6 and a review checklist.
- `privateKnowledge` grows append-only within a round. At sixteen cards this stays trivial; a larger deck would want pruning.
- The engine verifies that a claimed `playerId` matches the current player. It cannot verify that a real person owns that seat. Authentication belongs to the transport layer.
