# The Mule's Court — Visual Showcase

Design reference for the game's interface. Nothing here is implemented yet: `src/game/scenes/` is still the Phaser starter template.

This document describes appearance and interaction only. The rules live in `README.md`, the state model in `docs/plans/2026-07-22-engine-architecture-design.md`, and the client-server protocol in `docs/plans/2026-07-22-transport-design.md`.

**Two constraints govern everything below.**

The interface holds no game state. It renders a `RedactedView` pushed by the server and sends back one message, `PLAY_CARD`. Anything it appears to "decide" — whose turn it is, which cards are playable, who may be targeted — it read from that view.

The design space is a fixed 1024×768 landscape, scaled to any screen by Phaser's `Scale.FIT`. Phone-landscape is in scope, so **nothing may depend on hover**.

---

## 🎨 Art assets

### Space background

**File:** `public/assets/misc/playfield_background_space.png`

Deep space nebula in purple and red, with distant stars. The playfield backdrop behind every table.

### Devotion token badge

**File:** `public/assets/misc/devotion_token.png`

An all-seeing eye in a red and purple medallion — the Mule's power. One badge per token earned.

Note the counts this must display: **7 tokens to win at two players, 5 at three, 4 at four.** A two-player match therefore needs room for seven badges per seat, which is the layout's worst case.

### UI panel texture

**File:** `public/assets/misc/ui_panel_metal.png`

Metallic sci-fi surface with purple energy highlights. Used for the action panel, the lobby, and the round-over overlay.

### Cards

| Directory | Contents | Use |
| --- | --- | --- |
| `card-back/` | 3 designs | Face-down cards: opponents' hands, the deck |
| `card-front/` | `card_front_1`, `card_front_3` | Frame behind each portrait. **No `_2` exists** — pick one of the two |
| `<character>/` | `portrait_0..3` per card | One variant per character is curated for the game; the other three ship unused |

### Shader maps

`shaders/` holds `distortion_map.png`, `rainbow_gradient.png`, and `sparkle_pattern.png`, for use with Phaser 4 Filters.

---

## 🖥️ Screens

```
Boot → Preloader → MainMenu → Lobby → Game → GameOver
```

`MainMenu` and `Lobby` are their own scenes. Everything from here down — the table, the round-over overlay, the paused overlay — lives inside `Game`, because the table stays visible underneath all of them.

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
║   [1 card]  👁️👁️👁️  ← tokens (of 7)      ║
║   Discards: ▪1 ▪3 ▪5                      ║
╠═══════════════════════════════════════════╣
║                                           ║
║   ┌────────┐        ┌──────────────────┐  ║
║   │  DECK  │        │  Removed face-up │  ║
║   │   10   │        │   [Mayor Indbur] │  ║
║   └────────┘        └──────────────────┘  ║
║                                           ║
║            Waiting for Ana                ║
╠═══════════════════════════════════════════╣
║   CORNELIUS (you)          👁️👁️           ║
║   Discards: ▪2 ▪4                         ║
║   Hand: [Informant] [Shielded Mind]       ║
╚═══════════════════════════════════════════╝
```

**Two players is the only layout with a face-up removed card**, and it is public knowledge both players use. It gets its own panel beside the deck. Three-player games remove one card face-down and four-player games remove none, so neither shows this panel.

### 3 players

```
╔═══════════════════════════════════════════╗
║      ANA                    BAYTA         ║
║   [1 card] 👁️👁️         [1 card] 👁️       ║
║   ▪1 ▪3                  ▪5               ║
║                                           ║
║          ┌────────┐                       ║
║          │  DECK  │   Your Turn           ║
║          │   11   │                       ║
║          └────────┘                       ║
║                                           ║
║   CORNELIUS (you)          👁️👁️           ║
║   Hand: [Informant] [Bayta Darell]        ║
╚═══════════════════════════════════════════╝
```

### 4 players

```
╔═══════════════════════════════════════════╗
║                 BAYTA                     ║
║              [1 card] 👁️                  ║
║                                           ║
║  ANA                            TORAN     ║
║  [1] 👁️👁️      ┌────────┐      [1] 👁️    ║
║                │  DECK  │                 ║
║                │   11   │                 ║
║                └────────┘                 ║
║                                           ║
║              CORNELIUS (you)              ║
║         Hand: [Magnifico] [The Mule]      ║
╚═══════════════════════════════════════════╝
```

Deck counts shown are the opening figures after the deal and the first player's draw: **10** at two players, **11** at three and four.

---

## 🎭 Seat states

Every seat shows its nickname, token badges, face-up discard pile, and card count. Only the viewer's own cards show their faces.

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
   ↑ Grayscale (Phaser 4 Filter)
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
│ Informant   │     │ Informant   │        │ Mayor Indbur│
│      1      │     │      1      │        │      6      │
└─────────────┘     └─────────────┘        └─────────────┘
 purple border       bright border          40% opacity
                     + glow                 no border
```

**Not playable is a real state, not a hypothetical.** Holding The First Speaker beside Mayor Indbur or either Darell forces you to play The First Speaker; the other card dims. `view.own.legalPlays` names exactly which cards are playable, so the interface never works this rule out for itself.

### Action panel — a targeted card

```
┌──────────────────────────────────┐
│  Informant  ·  value 1           │
│  Name a card. If that player     │
│  holds it, they are eliminated.  │
├──────────────────────────────────┤
│  Choose a target                 │
│  ┌────────┐ ┌────────┐           │
│  │ 👤 Ana │ │👤 Bayta│           │
│  └────────┘ └────────┘           │
│  Toran — protected  (disabled)   │
├──────────────────────────────────┤
│  Name a card                     │
│  [Han Pritcher] [Bail Channis]   │
│  [Ebling Mis]   [Magnifico]      │
│  [Shielded Mind][Bayta Darell]   │
│  [Toran Darell] [Mayor Indbur]   │
│  [First Speaker][The Mule]       │
├──────────────────────────────────┤
│         [ Cancel ]  [ Play ]     │
└──────────────────────────────────┘
```

The Informant offers ten names. It may never name itself, so Informant is absent from the list rather than shown disabled — the rule is that it is not a legal choice, not that it is a choice you happen to lack.

Ineligible targets stay visible with their reason attached. Hiding them would leave a player wondering where someone went; showing "protected" teaches the rule.

### Action panel — no legal target

```
┌──────────────────────────────────┐
│  Informant  ·  value 1           │
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
║   CORNELIUS   [Mayor Indbur] 6   ★ WINS   ║
║   ANA         [Informant]    1            ║
║                                           ║
║   Ana earns 1 Devotion Token              ║
║                                           ║
║          Next round in 3…                 ║
╚═══════════════════════════════════════════╝
```

The showdown reveals every surviving hand, then holds for a flat **five seconds** before the next hand is dealt. The countdown reads from `revealDeadline`, a server timestamp — the interface counts toward it but decides nothing from it.

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
║        [ End match ]  ← after 10 min      ║
╚═══════════════════════════════════════════╝
```

The table stays visible and dimmed beneath. No card can be played while paused. If a player drops during a round-over countdown, the countdown restarts at five seconds when they return rather than resuming — otherwise they come back to a showdown that vanishes instantly.

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
| Showdown reveal | Hands flip face-up, staggered ~150 ms, inside the five-second window |
| Elimination | Banner fades in 200 ms, seat dims to 50 % over 500 ms, grayscale Filter applied |
| Victory | Text fades in 300 ms, then gold pulse 0.9 → 1.15, 800 ms loop |

The showdown flip must fit comfortably inside five seconds. Staggering four reveals at 150 ms costs 600 ms and leaves the rest for reading.

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

### Seat area

```
300 × 180, 10px corner radius

Nickname       18px bold,  -60 from top
Status panel   280 × 40,   -10 from top
Token badges   40 × 40 each, horizontal, wrapping at 4
Hand / count   150 × 60,   +50 from top
```

Token badges wrap after four, since two-player matches run to seven.

### Centre panel

```
400 × 120, top centre, -200 from centre

Title          24px, -35 from centre
Game state     16px,  +5 from centre    (Your Turn / Waiting for X / …)
Countdown      18px, +35 from centre    (round-over only)
```

### Deck

```
150 × 220, centre

Card back      120 × 180
Count          20px, +80
Label          12px, +100
```

### Action panel

```
360 wide, height follows content, anchored beside the raised card
Kept inside the 1024 × 768 bounds; flips to the card's other side near an edge

Card name + value    18px bold
Effect text          14px
Target buttons       160 × 48, portrait thumbnail plus nickname
Guess buttons        160 × 40, two columns
Cancel / Play        140 × 48
```

Buttons are at least 48px tall so they remain comfortable targets on a phone in landscape.

---

## ✅ Interface rules

1. **Render the view; decide nothing.** Turn order, legality, and timing all arrive from the server.
2. **Never depend on hover.** Touch is in scope.
3. **Show ineligible choices with their reason.** Hiding them hides the rules.
4. **Never show another player's hand** except in the round-over showdown, and only from `roundResult.revealedHands`.
5. **The server owns every clock.** Countdowns render `revealDeadline`; they never expire anything locally.
