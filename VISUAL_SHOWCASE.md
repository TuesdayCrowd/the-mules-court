# The Mule's Court — Visual Showcase

> **[`docs/plans/typescript/2026-07-23-uix-design.md`](docs/plans/typescript/2026-07-23-uix-design.md) is authoritative where the two disagree.** This document is the interface reference — seat states, the action panel, the quick reference, the palette, the interface rules. It carries no layout metrics, because there are none to carry: geometry is computed from the live viewport.

Design reference for the game's interface, and all of it is implemented. Every surface is DOM, one factory each in `src/client/ui/`: the chrome, and the table itself in `table.ts`, laid out from a `LayoutSpec` computed by `src/client/layout/` and animated by `beats.ts` on the Web Animations API.

This document describes appearance and interaction only. The rules live in `README.md`, the state model in `docs/plans/typescript/2026-07-22-engine-architecture-design.md`, and the client-server protocol in `docs/plans/typescript/2026-07-22-transport-design.md`.

**Two constraints govern everything below.**

The interface holds no game state. It renders a `RedactedView` pushed by the server and sends back one message, `PLAY_CARD`. Anything it appears to "decide" — whose turn it is, which cards are playable, who may be targeted — it read from that view.

There is no design resolution. `src/client/layout/` computes every position as a fraction of the live viewport across three topology classes — see *UIX §2.2*. Phone-landscape is in scope, so **nothing may depend on hover**.

---

## 🎨 Art assets

### Space background

**File:** `public/assets/misc/playfield_background_space.png`

Deep space nebula in purple and red, with distant stars. The playfield backdrop behind every table.

### Devotion token badge

**File:** `public/assets/misc/devotion_token.png`

An all-seeing eye in a red and purple medallion — the Mule's power. One badge per token earned.

Note the counts this must display: **7 tokens to win at two players, 5 at three, 4 at four.** A two-player match therefore needs room for seven badges per seat, which is the layout's worst case.

### Cards

| Directory | Contents | Use |
| --- | --- | --- |
| `card-back/` | 3 designs | Face-down cards: opponents' hands, the deck |
| `<character>/` | `portrait_0..3` per card | One variant per character is curated for the game; the other three ship unused |

A card is its portrait. There is no frame drawn behind one — the value badge and
the name strip are drawn over the art, which is why `object-fit: contain` is what
keeps a 512×720 portrait honest inside a rect the layout sized.

### Effect textures

`shaders/` holds `rainbow_gradient.png`, which shimmers over a devotion token as
it is awarded, and `sparkle_pattern.png`, which bursts on match victory. Each is
one image and one animation, not a particle system.

---

## 🖥️ Screens

```
Menu → Lobby → Table
```

Menu and lobby are full-screen surfaces over an idling background. Everything from here down — the round-over overlay, the paused overlay, the match-over screen — is drawn over the table rather than instead of it, because the table stays visible underneath all of them.

### Lobby

```
╔═══════════════════════════════════════════╗
║          THE MULE'S COURT                 ║
║                                           ║
║   Share this link to invite players:      ║
║   ┌─────────────────────────────────┐     ║
║   │ mulescourt.app/m/K7QX2   [Copy] │     ║
║   └─────────────────────────────────┘     ║
║                                           ║
║   Seat 1  [Cornelius        ]  ← you, host║
║   Seat 2  Ana                             ║
║   Seat 3  (open)                          ║
║   Seat 4  (open)                          ║
║                                           ║
║          ┌──────────────────┐             ║
║          │   Start Match    │  ← host only║
║          └──────────────────┘   2-4 seated║
╚═══════════════════════════════════════════╝
```

A player types a nickname when taking a seat. Only the host sees an enabled Start Match, and only once two to four seats are filled. A seat whose player has dropped shows as `(disconnected)` while its token stays reserved.

---

## 🎮 Playfield layouts

The viewer always sits at the bottom. Opponents fill the remaining positions clockwise.

### 2 players

```
╔═══════════════════════════════════════════╗
║              ANA                          ║
║   [1 card]  👁👁👁  ← tokens (of 7)       ║
║   Discards: ▪1 ▪3 ▪5                      ║
╠═══════════════════════════════════════════╣
║                                           ║
║   ┌────────┐   ┌───────────────────┐      ║
║   │  DECK  │   │ Removed face-up   │      ║
║   │   10   │   │ [6| Mayor Indbur] │      ║
║   └────────┘   └───────────────────┘      ║
║                                           ║
║            Waiting for Ana                ║
╠═══════════════════════════════════════════╣
║   CORNELIUS (you)          👁👁           ║
║   Discards: ▪2 ▪4                         ║
║   Hand: [1| Informant] [4| Shielded Mind] ║
╚═══════════════════════════════════════════╝
```

**Two players is the only layout with a face-up removed card**, and it is public knowledge both players use. It gets its own panel beside the deck. Three-player games remove one card face-down and four-player games remove none, so neither shows this panel.

### 3 players

```
╔═══════════════════════════════════════════╗
║      ANA                    BAYTA         ║
║   [1 card] 👁👁         [1 card] 👁       ║
║   ▪1 ▪3                 ▪5                ║
║                                           ║
║          ┌────────┐                       ║
║          │  DECK  │      Your Turn        ║
║          │   11   │                       ║
║          └────────┘                       ║
║                                           ║
║   CORNELIUS (you)          👁👁           ║
║   Hand: [1| Informant] [5| Bayta Darell]  ║
╚═══════════════════════════════════════════╝
```

### 4 players

```
╔═══════════════════════════════════════════╗
║                 BAYTA                     ║
║              [1 card] 👁                  ║
║                                           ║
║  ANA                            TORAN     ║
║  [1] 👁👁      ┌────────┐      [1] 👁     ║
║                │  DECK  │                 ║
║                │   11   │                 ║
║                └────────┘                 ║
║                                           ║
║              CORNELIUS (you)              ║
║     Hand: [3| Magnifico] [8| The Mule]    ║
╚═══════════════════════════════════════════╝
```

Deck counts shown are the opening figures after the deal and the first player's draw: **10** at two players, **11** at three and four.

---

## 🎭 Seat states

Every seat shows its nickname, token badges, face-up discard pile, and card count. Only the viewer's own cards show their faces.

**Every card is labelled with its value**, written `value| Name` — `[1| Informant]`, `[8| The Mule]`. Value is what the game is played on: it decides Baron comparisons, the deck-out showdown, and what the Informant guesses. Discard piles show values alone (`▪1 ▪3 ▪5`) since the pile is scanned for totals rather than read card by card.

### Current turn

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ CORNELIUS (you)          ┃  ← Red border, 3px
┃ ⚡ Your Turn              ┃
┃                          ┃
┃ Hand: [2 cards]          ┃  ← Purple glow
┃ Tokens: 👁️ 👁️            ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛
   ↑ Pulsing 1.0 → 1.03 scale
```

### Protected — Shielded Mind

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ ANA                      ┃  ← Gray border, 2px
┃ ┌────────────────────┐   ┃
┃ │ 🛡️ Protected        │   ┃  ← Cyan panel
┃ │ Cannot be targeted │   ┃  ← Pulsing 0.3 → 0.7 alpha
┃ └────────────────────┘   ┃
┃ Hand: [1 card]           ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

Protection lasts until the start of that player's own next turn. It is stripped the instant their turn begins, so the badge clears on the same update that hands them the turn.

### Eliminated

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ BAYTA                    ┃  ← Gray border, 50% opacity
┃ ┌────────────────────┐   ┃
┃ │ 💀 Eliminated       │   ┃
┃ └────────────────────┘   ┃
┃ Discards: ▪1 ▪8 ← revealed┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛
   ↑ Desaturating wash over the seat
```

**An eliminated player's held card becomes public.** It moves face-up into their discard pile, where everyone can read it. The seat never shows an empty hand and hides nothing — that reveal is core deduction information.

### Disconnected

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ ANA                      ┃  ← Dashed gray border
┃ ⏳ Reconnecting…          ┃
┃ Hand: [1 card]           ┃  ← Cards stay; seat is held
┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

---

## 🃏 Playing a card

Tap a card; an action panel opens beside it. Every choice is a labelled button, never a spatial gesture — this works identically with a mouse or a finger, and reads correctly to a screen reader.

### Card states

```
Playable            Raised (panel open)    Not playable
┌─────────────┐     ┌─────────────┐        ┌─────────────┐
│ [portrait]  │     │ [portrait]  │ ↑8px   │ [portrait]  │
│1| Informant │     │1| Informant │        │6| Mayor Ind.│
│      1      │     │      1      │        │      6      │
└─────────────┘     └─────────────┘        └─────────────┘
 purple border       bright border          40% opacity
                     + glow                 no border
```

**Not playable is a real state, not a hypothetical.** Holding The First Speaker beside Mayor Indbur or either Darell forces you to play The First Speaker; the other card dims. `view.own.legalPlays` names exactly which cards are playable, so the interface never works this rule out for itself.

### Action panel — a targeted card

```
┌──────────────────────────────────┐
│  1 · Informant                   │
│  Guess a value from 2 to 8. If   │
│  they hold it, they are out.     │
├──────────────────────────────────┤
│  Choose a target                 │
│  ┌────────┐ ┌────────┐           │
│  │ 👤 Ana │ │👤 Bayta│           │
│  └────────┘ └────────┘           │
│  Toran — protected  (disabled)   │
├──────────────────────────────────┤
│  Guess a value                   │
│  ┌───┐┌───┐┌───┐┌───┐            │
│  │ 2 ││ 3 ││ 4 ││ 5 │            │
│  └───┘└───┘└───┘└───┘            │
│  ┌───┐┌───┐┌───┐                 │
│  │ 6 ││ 7 ││ 8 │                 │
│  └───┘└───┘└───┘                 │
│  Tap a value for its cards ↗     │
├──────────────────────────────────┤
│         [ Cancel ]  [ Play ]     │
└──────────────────────────────────┘
```

**The Informant guesses a value, not a name.** Several values cover two different characters — guessing 5 hits Bayta Darell *or* Toran Darell — so naming a character would halve the Informant's reach. Seven buttons, 2 through 8. Value 1 is absent because the Informant may never guess itself, which is a rule about what is legal rather than an option the player happens to lack.

Each value button shows which characters it covers on tap, or players can open the quick reference below.

Ineligible targets stay visible with their reason attached. Hiding them would leave a player wondering where someone went; showing "protected" teaches the rule.

### Action panel — no legal target

```
┌──────────────────────────────────┐
│  1 · Informant                   │
├──────────────────────────────────┤
│  No legal targets.               │
│  Every other player is protected │
│  or eliminated. This card will   │
│  be discarded with no effect.    │
├──────────────────────────────────┤
│         [ Cancel ]  [ Play ]     │
└──────────────────────────────────┘
```

This is a genuine, legal move, not an error. The card is still played and discarded; the effect simply does nothing. Saying so plainly stops it reading as a broken interface.

### Action panel — no target needed

Shielded Mind, The First Speaker, and The Mule take no target. Their panel shows the card's effect and a Play button alone.

---

## 📖 Quick reference

Always reachable from the table — a persistent tab that opens over the playfield and closes on tap. Available at every moment, including another player's turn, because deduction depends on knowing what is still out there.

**Ordered from 8 down to 1**, matching the direction the game is played in: high cards win showdowns, low cards do the work.

```
┌──────────────────────────────────────────────────────────┐
│  THE COURT — 16 cards                              [ ✕ ] │
├─────┬─────┬──────────────────┬───────────────────────────┤
│  8  │ ×1  │ The Mule         │ Discard this and you are  │
│     │     │                  │ eliminated.               │
├─────┼─────┼──────────────────┼───────────────────────────┤
│  7  │ ×1  │ The First Speaker│ Held with a 6 or a 5, you │
│     │     │                  │ must play this.           │
├─────┼─────┼──────────────────┼───────────────────────────┤
│  6  │ ×1  │ Mayor Indbur     │ Trade hands with another  │
│     │     │                  │ player.                   │
├─────┼─────┼──────────────────┼───────────────────────────┤
│  5  │ ×2  │ Bayta Darell     │ Choose any player, even   │
│     │     │ Toran Darell     │ yourself, to discard and  │
│     │     │                  │ draw a new card.          │
├─────┼─────┼──────────────────┼───────────────────────────┤
│  4  │ ×2  │ Shielded Mind    │ Until your next turn you  │
│     │     │                  │ cannot be targeted.       │
├─────┼─────┼──────────────────┼───────────────────────────┤
│  3  │ ×2  │ Ebling Mis       │ Compare hands with a      │
│     │     │ Magnifico        │ player. Lower value is    │
│     │     │   Giganticus     │ eliminated. A tie does    │
│     │     │                  │ nothing.                  │
├─────┼─────┼──────────────────┼───────────────────────────┤
│  2  │ ×2  │ Han Pritcher     │ Look at another player's  │
│     │     │ Bail Channis     │ hand.                     │
├─────┼─────┼──────────────────┼───────────────────────────┤
│  1  │ ×5  │ Informant        │ Guess a value from 2 to 8.│
│     │     │                  │ If your target holds it,  │
│     │     │                  │ they are eliminated.      │
└─────┴─────┴──────────────────┴───────────────────────────┘
```

**The quantity column is the whole point of this panel.** It counts cards *at that value*, not copies of a name — four values are shared by two different characters, and five Informants sit at value 1. A player deciding what to guess needs to know that value 5 covers both Darells and value 1 covers a third of the deck. Ordering by value and counting by value makes the panel answer the question the Informant actually asks.

Values shared by two characters list both names in the same row, since the game never distinguishes them: they have identical abilities, they are guessed together, and they compare identically in a showdown. The two names exist for flavour and art alone.

---

## 🎯 Deck

```
Full (>3)              Low (≤3)               Empty
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│  THE DECK    │       │  THE DECK    │       │  THE DECK    │
│ ┌──────────┐ │       │ ┌──────────┐ │       │ ┌──────────┐ │
│ │  [back]  │ │       │ │  [back]  │ │       │ │  [back]  │ │
│ └──────────┘ │       │ └──────────┘ │       │ └──────────┘ │
│   11 cards   │       │   2 cards    │       │    EMPTY     │
└──────────────┘       └──────────────┘       └──────────────┘
 purple border          orange, subtle pulse   dark red, strong pulse
 white text             yellow text            red text
```

The count comes from `view.deckCount`. An empty deck means the round ends after the current turn, so the strong pulse is a genuine warning that the showdown is one play away.

---

## ⏸️ Overlays

### Round over

```
╔═══════════════════════════════════════════╗
║           ROUND OVER                      ║
║                                           ║
║   Deck ran out — highest card wins        ║
║                                           ║
║   CORNELIUS   [6| Mayor Indbur]  ★ WINS   ║
║   ANA         [1| Informant]              ║
║                                           ║
║   Cornelius earns 1 Devotion Token        ║
║                                           ║
║          Next round in 3…                 ║
╚═══════════════════════════════════════════╝
```

The showdown reveals every surviving hand, then holds for a flat **ten seconds** before the next hand is dealt. The countdown reads from `revealDeadline`, a server timestamp — the interface counts toward it but decides nothing from it.

A round won by elimination shows the winner without a hand comparison, since the eliminations were already narrated as they happened.

**A round that also wins the match skips this overlay** and goes straight to the match-over screen.

### Paused

```
╔═══════════════════════════════════════════╗
║            ⏳ PAUSED                       ║
║                                           ║
║      Waiting for Ana to reconnect…        ║
║                                           ║
║   The match resumes automatically.        ║
║                                           ║
║        [ End match ]  ← after 2 min       ║
╚═══════════════════════════════════════════╝
```

The table stays visible and dimmed beneath. No card can be played while paused. If a player drops during a round-over countdown, the countdown restarts in full when they return rather than resuming — otherwise they come back to a showdown that vanishes instantly.

### Match over

```
╔═══════════════════════════════════════════╗
║           ★  MATCH OVER  ★                ║
║                                           ║
║        👑  CORNELIUS WINS  👑              ║
║                                           ║
║   Cornelius  👁️👁️👁️👁️👁️👁️👁️   7          ║
║   Ana        👁️👁️👁️👁️           4          ║
║                                           ║
║          [ Back to menu ]                 ║
╚═══════════════════════════════════════════╝
```

---

## 🎬 Animation

| Moment | Treatment |
| --- | --- |
| Token earned | Badges fade in, alpha 0→1 over 500 ms, staggered 100 ms each |
| Current turn | Seat pulses 1.0 → 1.03 scale, ~1.5 s loop |
| Protection | Cyan panel pulses 0.3 → 0.7 alpha, fast loop |
| Card played | Card travels from hand to the discard pile, ~300 ms |
| Showdown reveal | Hands flip face-up, staggered ~150 ms, inside the reveal window |
| Elimination | Banner fades in 200 ms, seat dims to 50 % over 500 ms under a desaturating wash |
| Victory | Text fades in 300 ms, then gold pulse 0.9 → 1.15, 800 ms loop |

The showdown flip must fit comfortably inside the reveal window. Staggering four reveals at 150 ms costs 600 ms and leaves the rest for reading.

---

## 🎨 Colour palette

### Base

```
Background     #000000   Black space
Nebula red     #ef4444   Highlights
Nebula purple  #a855f7   Accents
```

### Seat states

```
Current turn   #ef4444   Red border
Other seats    #6b7280   Gray
Protected      #22d3ee   Cyan
Eliminated     #9ca3af   Light gray
Disconnected   #6b7280   Gray, dashed
```

### Game states

```
Your turn      #c084fc   Purple
Waiting        #9ca3af   Gray
Round over     #4ade80   Green
Paused         #fbbf24   Amber
Match over     #fbbf24   Gold
```

### Deck

```
Full     #9333ea   Purple
Low      #b45309   Orange
Empty    #991b1b   Dark red
```

---

## 📐 Layout

**Geometry lives in `src/client/layout/`, not here.** The client computes every
position from the live viewport, so there are no fixed numbers to document.
`computeLayout(input) → LayoutSpec` is the whole surface, its constants are named
and commented in `tableLayout.ts`, and the design's spatial promises are
assertions in `tableLayout.test.ts` rather than prose in this file.

One figure is worth recording because it is easy to get wrong by counting: a
single seat can reach **eight** discards in a two-player round, not seven.
`discardCapacity.test.ts` derives it by simulation rather than by argument.

## ✅ Interface rules

1. **Render the view; decide nothing.** Turn order, legality, and timing all arrive from the server.
2. **Never depend on hover.** Touch is in scope.
3. **Show ineligible choices with their reason.** Hiding them hides the rules.
4. **Never show another player's hand** except in the round-over showdown, and only from `roundResult.revealedHands`.
5. **The server owns every clock.** Countdowns render `revealDeadline`; they never expire anything locally.
