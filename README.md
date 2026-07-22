# The Mule's Court

**The Mule's Court** is a 2-4 player card game of deduction, risk, and elimination set in Isaac Asimov's Foundation universe. Inspired by Love Letter, this game explores the tragic irony of the Mule's mind control: every player believes they act independently, but all have been emotionally converted.

## Game Rules

### Objective

Be the first player to earn the required number of **Devotion Tokens**:

- **2 players**: 7 tokens to win
- **3 players**: 5 tokens to win
- **4 players**: 4 tokens to win

### Setup

1. Each player starts with 0 Devotion Tokens
2. Shuffle the 16-card deck
3. Remove cards from play:
   - **2 players**: Remove 3 cards (1 face-up, 2 face-down)
   - **3 players**: Remove 1 card face-down
   - **4 players**: No cards removed
4. Deal 1 card to each player

### Turn Structure

On your turn:

1. **Draw** a card from the deck (you now have 2 cards)
2. **Play** one of your two cards face-up
3. **Resolve** the card's ability (targeting other players)
4. **End** your turn (the played card goes to your discard pile)

### Winning a Round

A round ends when:

- Only one player remains (others eliminated) → That player wins
- The deck runs out → Player with the highest card value wins (ties broken by discard pile total)

The round winner earns 1 Devotion Token. Reset the round and continue until a player reaches the winning token count.

### Elimination

You are eliminated from the round if:

- Another player's card effect eliminates you
- You discard **The Mule** card (value 8)
- You must discard **The First Speaker** when holding Mayor Indbur or either Darell

## The Cards

The deck contains 16 cards representing characters from the Foundation series:

| Card                     | Value | Count | Ability                                                                                 |
| ------------------------ | ----- | ----- | --------------------------------------------------------------------------------------- |
| **Informant**            | 1     | 5     | Name a character (not Informant). If another player has that card, they are eliminated. |
| **Han Pritcher**         | 2     | 1     | Look at another player's hand.                                                          |
| **Bail Channis**         | 2     | 1     | Look at another player's hand.                                                          |
| **Ebling Mis**           | 3     | 1     | Compare hands with another player. Lower value is eliminated.                           |
| **Magnifico Giganticus** | 3     | 1     | Compare hands with another player. Lower value is eliminated.                           |
| **Shielded Mind**        | 4     | 2     | Until your next turn, ignore effects from other players.                                |
| **Bayta Darell**         | 5     | 1     | Choose any player to discard their hand and draw a new card.                            |
| **Toran Darell**         | 5     | 1     | Choose any player to discard their hand and draw a new card.                            |
| **Mayor Indbur**         | 6     | 1     | Trade hands with another player.                                                        |
| **The First Speaker**    | 7     | 1     | If you have this with Mayor Indbur or either Darell, you must discard this card.        |
| **The Mule**             | 8     | 1     | If you discard this card, you are eliminated from the round.                            |

### Key Mechanics

- **Protection**: Playing Shielded Mind grants immunity until your next turn
- **Targeting**: You cannot target eliminated or protected players
- **The Mule**: Never willingly discard The Mule (value 8)—hold it to win if the deck runs out
- **The First Speaker**: Automatically discards if paired with specific high-value cards

## Development

### Tech Stack

[Phaser](https://github.com/phaserjs/phaser) 4.2.1 · [Vite](https://github.com/vitejs/vite) 6 · [TypeScript](https://github.com/microsoft/TypeScript) 5.7 · [Bun](https://bun.sh) 1 (package manager and script runner)

### Project Status

The game design is complete — the rules above are fully specified — and the art pipeline is finished, with portrait art for every character card (see [Assets](#assets)). None of that has reached code yet: `src/game/scenes/Game.ts` and `MainMenu.ts` are still the unmodified Phaser starter scenes (placeholder text, click-to-advance flow), and `src/` has no card data, deck logic, or game-state model. `PORTRAIT_PROMPTS.md` points to a planned `src/data/cards.ts` as the intended home for card definitions.

### Requirements

[Bun](https://bun.sh) is required to install dependencies and run scripts.

```bash
bun install
```

### Commands

| Command               | What it does                                                                 |
| --------------------- | ---------------------------------------------------------------------------- |
| `bun run dev`         | Start the Vite dev server (`vite/config.dev.mjs`) on `http://localhost:8080` |
| `bun run build`       | Produce a minified production build (`vite/config.prod.mjs`) into `dist/`    |
| `bun run dev-nolog`   | Same as `dev`, without the `log.js` analytics ping                           |
| `bun run build-nolog` | Same as `build`, without the `log.js` analytics ping                         |

`log.js` sends one anonymous GET request per run (dev/build event, package name, Phaser version — no response read) to the template maintainer's usage-tracking endpoint, and fails silently if unreachable. Use the `-nolog` variants, or delete `log.js` and its two references in `package.json`, to skip it entirely.

### Project Structure

| Path               | Description                                                                           |
| ------------------ | ------------------------------------------------------------------------------------- |
| `index.html`       | Root HTML entry point loaded by Vite / the built game                                 |
| `public/`          | Static assets copied as-is to the `dist` root at build time                           |
| `public/assets/`   | Game art and media (character portraits, cards, UI panels, shaders)                   |
| `public/style.css` | Global page/canvas CSS loaded by `index.html`                                         |
| `src/main.ts`      | Top-level entry point that boots the Phaser game                                      |
| `src/game/main.ts` | Phaser game config (renderer, scale, scene list)                                      |
| `src/game/scenes/` | Scene classes: `Boot.ts` → `Preloader.ts` → `MainMenu.ts` → `Game.ts` → `GameOver.ts` |

### Assets

Portrait art lives under `public/assets/<character-slug>/` — one directory per card (`bail-channis/`, `bayta-darell/`, `ebling-mis/`, `first-speaker/`, `han-pritcher/`, `informant/`, `magnifico/`, `mayor-indbur/`, `mule/`, `shielded-mind/`, `toran-darell/`), each with four portrait variants, `portrait_0.png` through `portrait_3.png`. Card backs, card fronts, shader maps, and other shared UI art live in their own top-level `public/assets/` folders.

- `public/assets/PORTRAIT_PROMPTS.md` documents the generation prompts and settings behind every portrait, and how each character's color scheme is meant to map onto its card definition.
- `VISUAL_SHOWCASE.md` (repo root) is a design mockup of the intended in-game UI (player panels, phase indicators, deck states). It describes the target look; none of it is wired up in the scene code yet.

`screenshot.png` at the repo root is the unmodified Phaser starter splash, not a useful preview of the game; ignore or remove it until real gameplay screens exist.

### Building for Production

```bash
bun run build
```

This produces a static bundle in `dist/` (Vite's default output directory) that you can host on any static file server.

### License

This project's code is released into the public domain under [The Unlicense](https://unlicense.org) — see [`UNLICENSE`](UNLICENSE).
