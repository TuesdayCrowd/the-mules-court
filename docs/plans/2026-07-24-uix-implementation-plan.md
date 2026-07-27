# UIX Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> Every task follows red → green → commit. Never write implementation before its failing test.

**Goal:** Build the complete Phaser + DOM client described in `docs/plans/2026-07-23-uix-design.md`, replacing the untouched "template-bun" starter scenes with a real, responsive, accessible client that speaks the finished transport protocol.

**Architecture:** One Phaser canvas renders the living table; one sibling DOM overlay (`#ui-root`) renders everything made of words. Both are projections of a single plain-TypeScript client store that owns the WebSocket, the seat token, and the latest `STATE_UPDATE`. Table geometry is computed by pure `(playerCount, w, h) → LayoutSpec` functions that import nothing from Phaser, so Vitest tests the layout without a Scene — the same discipline that made the engine testable. One reconciler, `renderView(view)`, runs on every state update *and* every resize.

**Tech Stack:** Phaser 4.2.1, Vite 6, TypeScript 5.7 strict, Bun. New devDependencies: `jsdom` and `axe-core` (test-only). No new runtime dependencies — no framework, no router library, no CSS library.

**Design reference:** `docs/plans/2026-07-23-uix-design.md`, cited below as *UIX §N*. Read a section before implementing against it. Rules live in `README.md`; the wire protocol is `src/server/protocol.ts`; the engine surface is `src/game/engine/index.ts` — import **only** from that barrel.

---

## Conventions (read before Task 1)

| Rule | Detail |
| --- | --- |
| Imports | Extensionless relative paths; engine access via `../game/engine` barrel only; protocol types via `../../server/protocol` (types only — never import server *runtime* into the client bundle) |
| Indent | 4 spaces, matching existing source |
| Client tests | **Vitest**, alongside the engine. Files under `src/client/**/*.test.ts`. Node environment by default; DOM tests opt in per file with a `// @vitest-environment jsdom` docblock |
| Server tests | Still `bun test src/server`. Stage 2 touches the server and its tests run there |
| Typecheck | `bunx tsc --noEmit` before every commit — Vite never type-checks |
| Full gate | `bun run test && bunx tsc --noEmit && bun run build` before every commit |
| Commits | **GitButler only.** `but status -fv` for change IDs, then `but commit uix-client -m "…" --changes <ids>`. Never `git commit`. Create the branch once in Task 0 |
| Purity | Everything under `src/client/layout/`, `src/client/content/`, `src/client/store/`, and `src/client/tokens/` must import **zero** Phaser and **zero** DOM. That is what makes them testable, and Task 3 enforces it with a test |
| Dependencies | Clocks, randomness, `WebSocket`, `localStorage`, and `fetch` are injected as explicit constructor/factory arguments with real defaults. Tests override single fields; they never mock modules |
| No optimism | The client never mutates game state locally. `PLAY_CARD` goes out, the card shimmers pending, and only a `STATE_UPDATE` resolves it (*UIX §7.3*) |

### Three deliberate deviations from the design letter, recorded here

1. **The WebSocket upgrade stays path-agnostic.** *UIX* implies a `/ws` endpoint for dev proxying; `src/server/index.ts` currently upgrades *any* non-`/api` request, and thirteen server tests connect to `ws://host/`. Task 8 keys the upgrade on the `Upgrade: websocket` **header** rather than the path, so `/ws` works for the Vite proxy while every existing test stays green. Strictly a superset of both behaviours.
2. **Phaser scenes get no unit tests.** Vitest cannot boot a WebGL context under Node, and a headless-canvas harness would test the harness. The mitigation is structural, not aspirational: all decisions live in pure modules that *are* tested, and the `Court` scene is glue thin enough to review by reading. `bun run build` plus the Stage 7 device pass are its gate.
3. **axe-core cannot check colour contrast under jsdom** (no layout, no computed pixels). Contrast is therefore covered by a separate arithmetic test over the token palette (Task 4), and axe covers structure, labelling, and roles. Together they cover what *UIX §11* asks for; neither alone does.

### Division of ownership

| Concern | Owner | Never touches it |
| --- | --- | --- |
| Turn order, legality, timing, elimination | Server (engine) | The client, ever |
| Which card is playable | `view.own.legalPlays` | Any client-side rule evaluation |
| Countdown deadlines | `revealDeadline` + `serverTime` | `Date.now()` as a source of truth |
| Table geometry | `src/client/layout/` pure functions | Phaser, the DOM |
| Words on screen | `src/client/content/` + `src/client/ui/` | The canvas |
| Pixels on the table | `src/client/scenes/Court.ts` | Layout arithmetic (it *consumes* a `LayoutSpec`) |

---

## Stage 1: Foundations — harness, tokens, content

**Goal:** Client tests run in both Node and jsdom environments; the palette exists once and is proven consistent and legible; every string the game shows a player exists as tested data.
**Success criteria:** `bun run test` runs engine + client + server suites green; a token present in CSS but missing from TypeScript fails a test; every `CardTypeId` has copy.
**Status:** Complete

### Task 0: Branch

**Step 1: Create and mark the branch**

```bash
but branch new uix-client && but mark uix-client
but status
```

Expected: `uix-client` listed as an applied virtual branch. Every commit below targets it. (The plan document itself lives on `uix-design-plan`; the implementation does not.)

---

### Task 1: Client test harness

**Files:**
- Modify: `vitest.config.ts`
- Modify: `package.json`
- Create: `src/client/__tests__/harness.test.ts`

**Step 1: Install jsdom**

```bash
bun add -d jsdom
```

**Step 2: Widen the Vitest include.** In `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/game/**/*.test.ts', 'src/client/**/*.test.ts']
    }
});
```

Leave `environment: 'node'` as the default. DOM-touching files opt in individually with a docblock — Vitest 4 removed `environmentMatchGlobs`, and a per-file docblock keeps the choice next to the code that needs it.

**Step 3: Write the failing harness test** at `src/client/__tests__/harness.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

describe('client test harness', () => {
    it('runs pure modules under Node with no DOM', () => {
        expect(typeof globalThis.document).toBe('undefined');
        expect(1 + 1).toBe(3); // deliberately red; fix after observing the failure
    });
});
```

**Step 4: Run it and watch it fail**

```bash
bun run test:engine
```

Expected: FAIL — `expected 2 to be 3`. This proves the new include glob collects `src/client`.

**Step 5: Fix the assertion to `toBe(2)`, then add the jsdom counterpart** at `src/client/__tests__/dom-harness.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

describe('jsdom environment', () => {
    it('provides a document, localStorage, and custom properties', () => {
        document.body.innerHTML = '<div id="ui-root"></div>';
        expect(document.getElementById('ui-root')).not.toBeNull();
        localStorage.setItem('k', 'v');
        expect(localStorage.getItem('k')).toBe('v');
    });
});
```

**Step 6: Run the full gate**

```bash
bun run test && bunx tsc --noEmit
```

Expected: all suites PASS. `bun test src/server` must still report the same server test count as before — the two runners share no files.

**Step 7: Commit**

```bash
but status -fv
but commit uix-client -m "test: widen Vitest to src/client with a jsdom opt-in" --changes <ids>
```

---

### Task 2: Design tokens, single source

**Files:**
- Create: `src/client/styles/tokens.css`
- Create: `src/client/tokens/tokens.ts`
- Create: `src/client/tokens/tokens.test.ts`

*UIX §2.3.* One palette, two consumers. CSS custom properties are authoritative for the DOM; a hand-maintained TypeScript mirror feeds Phaser draw calls, which need numbers, not strings. A test — not a build step — keeps them honest. A generator was considered and rejected: it adds a build stage to keep 18 constants in sync, and the test catches drift just as reliably at a fraction of the machinery.

**Step 1: Write the failing test** at `src/client/tokens/tokens.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOKENS } from './tokens';

/** `--color-nebula-red: #ef4444;` → `['colorNebulaRed', 0xef4444]` */
function parseCssTokens(css: string): Map<string, number> {
    const found = new Map<string, number>();
    const re = /--([a-z0-9-]+)\s*:\s*#([0-9a-f]{6})\s*;/gi;
    for (const [, name, hex] of css.matchAll(re)) {
        const camel = name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
        found.set(camel, parseInt(hex, 16));
    }
    return found;
}

describe('design tokens', () => {
    const css = parseCssTokens(readFileSync('src/client/styles/tokens.css', 'utf8'));

    it('finds every colour token declared in CSS', () => {
        expect(css.size).toBeGreaterThanOrEqual(14);
    });

    it('mirrors every CSS colour token in TypeScript with the same value', () => {
        for (const [name, value] of css) {
            expect(TOKENS, `missing TS token ${name}`).toHaveProperty(name);
            expect(TOKENS[name as keyof typeof TOKENS], `value drift on ${name}`).toBe(value);
        }
    });

    it('declares no TypeScript colour token absent from CSS', () => {
        for (const name of Object.keys(TOKENS)) {
            expect(css.has(name), `TS token ${name} has no CSS counterpart`).toBe(true);
        }
    });
});
```

**Step 2: Run it**

```bash
bunx vitest run src/client/tokens
```

Expected: FAIL — cannot resolve `./tokens`.

**Step 3: Write `src/client/styles/tokens.css`.** Exactly *UIX §2.3*'s table, plus the spacing and radius scale the DOM needs:

```css
:root {
    /* Base */
    --color-bg: #000000;
    --color-nebula-red: #ef4444;
    --color-nebula-purple: #a855f7;

    /* Seat states */
    --color-seat-current: #ef4444;
    --color-seat-other: #6b7280;
    --color-seat-protected: #22d3ee;
    --color-seat-eliminated: #9ca3af;
    --color-seat-disconnected: #6b7280;

    /* Game states */
    --color-state-your-turn: #c084fc;
    --color-state-waiting: #9ca3af;
    --color-state-round-over: #4ade80;
    --color-state-paused: #fbbf24;
    --color-state-match-over: #fbbf24;

    /* Deck */
    --color-deck-full: #9333ea;
    --color-deck-low: #b45309;
    --color-deck-empty: #991b1b;

    /* Non-colour scale — not mirrored in TS; canvas computes its own spacing */
    --space-1: 0.25rem;
    --space-2: 0.5rem;
    --space-3: 0.75rem;
    --space-4: 1rem;
    --space-6: 1.5rem;
    --space-8: 2rem;
    --radius: 0.5rem;
    --tap-min: 48px;
}
```

**Step 4: Write `src/client/tokens/tokens.ts`** — the same names, camel-cased, as numbers:

```ts
/**
 * The canvas half of the single palette (UIX §2.3). `src/client/styles/tokens.css`
 * is authoritative; `tokens.test.ts` fails the build if these two ever disagree.
 * Numbers, not strings, because every Phaser tint and fill takes an integer.
 */
export const TOKENS = {
    colorBg: 0x000000,
    colorNebulaRed: 0xef4444,
    colorNebulaPurple: 0xa855f7,

    colorSeatCurrent: 0xef4444,
    colorSeatOther: 0x6b7280,
    colorSeatProtected: 0x22d3ee,
    colorSeatEliminated: 0x9ca3af,
    colorSeatDisconnected: 0x6b7280,

    colorStateYourTurn: 0xc084fc,
    colorStateWaiting: 0x9ca3af,
    colorStateRoundOver: 0x4ade80,
    colorStatePaused: 0xfbbf24,
    colorStateMatchOver: 0xfbbf24,

    colorDeckFull: 0x9333ea,
    colorDeckLow: 0xb45309,
    colorDeckEmpty: 0x991b1b
} as const;
```

**Step 5: Run the test — PASS. Step 6: Commit.**

```bash
but commit uix-client -m "feat(client): single-source design tokens with a drift test" --changes <ids>
```

---

### Task 3: The purity guard

**Files:**
- Create: `src/client/__tests__/purity.test.ts`

The engine has a purity guard; the client's pure layer needs the same protection, because "importable and testable without Phaser" (*UIX §2.1*) is an architectural claim that decays the first time someone reaches for `window`.

**Step 1: Write the test**

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PURE_DIRS = ['src/client/layout', 'src/client/content', 'src/client/store', 'src/client/tokens'];

/** Every .ts file under `dir`, recursively, tests included. */
function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
        else if (full.endsWith('.ts')) out.push(full);
    }
    return out;
}

describe('pure client layer', () => {
    it('never imports Phaser', () => {
        for (const dir of PURE_DIRS) {
            for (const file of sourceFiles(dir)) {
                expect(readFileSync(file, 'utf8'), `${file} imports phaser`).not.toMatch(/from ['"]phaser['"]/);
            }
        }
    });

    it('never touches document or window outside injected dependencies', () => {
        // `store/` legitimately owns localStorage and WebSocket, but only through
        // injected factories — the bare globals must not appear.
        for (const dir of PURE_DIRS) {
            for (const file of sourceFiles(dir)) {
                if (file.endsWith('.test.ts')) continue;
                const src = readFileSync(file, 'utf8');
                expect(src, `${file} uses document`).not.toMatch(/\bdocument\./);
                expect(src, `${file} uses window`).not.toMatch(/\bwindow\./);
                expect(src, `${file} uses bare localStorage`).not.toMatch(/(?<!\.)\blocalStorage\b/);
            }
        }
    });
});
```

**Step 2: Run it.** Expected: FAIL — `ENOENT` on `src/client/layout`. Create the four directories with a `.gitkeep` each and re-run: PASS (vacuously, for now; it gains teeth as files land).

**Step 3: Commit.**

---

### Task 4: Contrast arithmetic over the palette

**Files:**
- Create: `src/client/tokens/contrast.ts`
- Create: `src/client/tokens/contrast.test.ts`

*UIX §11* asks for WCAG AA verification "during implementation". jsdom cannot measure it, so measure it arithmetically — the maths is 20 lines and fully deterministic.

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast';
import { TOKENS } from './tokens';

const AA_SMALL = 4.5;
const AA_LARGE = 3.0;

describe('contrastRatio', () => {
    it('is 21 for black on white', () => {
        expect(contrastRatio(0x000000, 0xffffff)).toBeCloseTo(21, 1);
    });

    it('is 1 for a colour against itself', () => {
        expect(contrastRatio(0x123456, 0x123456)).toBeCloseTo(1, 5);
    });
});

describe('palette legibility on the black background', () => {
    // Tokens that carry small text. These are the ones AA governs strictly.
    const SMALL_TEXT = [
        TOKENS.colorStateYourTurn,
        TOKENS.colorStateWaiting,
        TOKENS.colorStateRoundOver,
        TOKENS.colorStatePaused,
        TOKENS.colorSeatEliminated,
        TOKENS.colorSeatProtected
    ];

    // Tokens used only as borders, fills, and large numerals.
    const NON_TEXT = [TOKENS.colorSeatOther, TOKENS.colorDeckFull, TOKENS.colorDeckEmpty, TOKENS.colorNebulaRed];

    it.each(SMALL_TEXT)('%s clears AA for small text on black', colour => {
        expect(contrastRatio(colour, TOKENS.colorBg)).toBeGreaterThanOrEqual(AA_SMALL);
    });

    it.each(NON_TEXT)('%s clears AA for large text and UI on black', colour => {
        expect(contrastRatio(colour, TOKENS.colorBg)).toBeGreaterThanOrEqual(AA_LARGE);
    });
});
```

**Step 2: Run it.** Expected: FAIL — module not found.

**Step 3: Implement `src/client/tokens/contrast.ts`**

```ts
/**
 * WCAG 2.1 relative luminance and contrast ratio (UIX §11).
 *
 * Arithmetic rather than measured, because the accessibility gate runs under
 * jsdom, which has no layout and therefore no computed colours. axe-core's
 * colour-contrast rule is silently skipped there; this file is what covers it.
 */

function channelLuminance(srgb: number): number {
    const c = srgb / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: number): number {
    const r = channelLuminance((hex >> 16) & 0xff);
    const g = channelLuminance((hex >> 8) & 0xff);
    const b = channelLuminance(hex & 0xff);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: number, b: number): number {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
}
```

**Step 4: Run it.**

Expected: PASS — **but read the numbers.** `#6b7280` (the "other seat" / "disconnected" grey) measures roughly **4.3:1** on black, just under the 4.5 small-text threshold, which is exactly why it is classified `NON_TEXT` above. `#9ca3af` measures about **8.3:1** and is the token to reach for whenever grey carries small text. If any `SMALL_TEXT` entry fails, **do not lower the threshold** — move that token to `NON_TEXT` and pick a lighter one for the text, then note the substitution in a comment.

**Step 5: Commit.**

```bash
but commit uix-client -m "feat(client): WCAG contrast check over the palette" --changes <ids>
```

---

### Task 5: Card copy

**Files:**
- Create: `src/client/content/cardCopy.ts`
- Create: `src/client/content/cardCopy.test.ts`

Names and values are **derived** from `CARD_CATALOG`, never retyped — the catalog is already the single source (`src/game/engine/cardCatalog.ts`). Only the player-facing effect sentence and the portrait path are new here.

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { CARD_CATALOG } from '../../game/engine';
import type { CardTypeId } from '../../game/engine';
import { CARD_COPY, cardCopyFor } from './cardCopy';

const ALL_IDS = Object.keys(CARD_CATALOG) as CardTypeId[];

describe('card copy', () => {
    it('covers every card in the catalog', () => {
        for (const id of ALL_IDS) expect(CARD_COPY).toHaveProperty(id);
    });

    it('never drifts from the catalog on name or value', () => {
        for (const id of ALL_IDS) {
            const copy = cardCopyFor(id);
            expect(copy.displayName).toBe(CARD_CATALOG[id].displayName);
            expect(copy.value).toBe(CARD_CATALOG[id].value);
        }
    });

    it('points every card at an existing portrait directory', () => {
        for (const id of ALL_IDS) {
            expect(cardCopyFor(id).portraitKey).toBe(`portrait-${CARD_CATALOG[id].assetSlug}`);
        }
    });

    it('gives the Informant guess-range copy that excludes its own value', () => {
        expect(cardCopyFor('informant').effect).toContain('2 to 8');
        expect(cardCopyFor('informant').effect).not.toContain('1 to 8');
    });

    it('states the Mule consequence in the second person', () => {
        expect(cardCopyFor('mule').playWarning).toBe('Discard The Mule — you are eliminated.');
    });

    it('leaves playWarning undefined for every card but the Mule', () => {
        for (const id of ALL_IDS) {
            if (id !== 'mule') expect(cardCopyFor(id).playWarning).toBeUndefined();
        }
    });
});
```

**Step 2: Run — FAIL. Step 3: Implement `src/client/content/cardCopy.ts`**

```ts
import { CARD_CATALOG } from '../../game/engine';
import type { CardTypeId, CardValue } from '../../game/engine';

export interface CardCopy {
    readonly id: CardTypeId;
    readonly displayName: string;
    readonly value: CardValue;
    /** Player-facing ability text, from README.md's card table. */
    readonly effect: string;
    /** Texture key loaded by Preloader; one per character directory. */
    readonly portraitKey: string;
    /** Present for the Mule alone (UIX §7.2): the red Play button's exact words. */
    readonly playWarning?: string;
}

/** Effect sentences only. Names and values come from the catalog — never retyped. */
const EFFECT_TEXT: Readonly<Record<CardTypeId, string>> = {
    informant: 'Guess a value from 2 to 8. If they hold it, they are out.',
    'han-pritcher': "Look at another player's hand.",
    'bail-channis': "Look at another player's hand.",
    'ebling-mis': 'Compare hands with another player. Lower value is eliminated.',
    magnifico: 'Compare hands with another player. Lower value is eliminated.',
    'shielded-mind': 'Until your next turn, ignore effects from other players.',
    'bayta-darell': 'Choose any player to discard their hand and draw a new card.',
    'toran-darell': 'Choose any player to discard their hand and draw a new card.',
    'mayor-indbur': 'Trade hands with another player.',
    'first-speaker': 'If you hold this with Mayor Indbur or either Darell, you must discard it.',
    mule: 'If you discard this card, you are eliminated from the round.'
};

function build(id: CardTypeId): CardCopy {
    const def = CARD_CATALOG[id];
    return {
        id,
        displayName: def.displayName,
        value: def.value,
        effect: EFFECT_TEXT[id],
        portraitKey: `portrait-${def.assetSlug}`,
        ...(id === 'mule' ? { playWarning: 'Discard The Mule — you are eliminated.' } : {})
    };
}

export const CARD_COPY: Readonly<Record<CardTypeId, CardCopy>> = Object.fromEntries(
    (Object.keys(CARD_CATALOG) as CardTypeId[]).map(id => [id, build(id)])
) as Record<CardTypeId, CardCopy>;

export function cardCopyFor(id: CardTypeId): CardCopy {
    return CARD_COPY[id];
}
```

**Step 4: PASS. Step 5: Commit.**

---

### Task 6: Quick reference data

**Files:**
- Create: `src/client/content/quickReference.ts`
- Create: `src/client/content/quickReference.test.ts`

*UIX §10*: value-ordered 8 → 1, count-per-value front and centre, characters sharing a value on one row.

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { QUICK_REFERENCE, totalCards } from './quickReference';

describe('quick reference', () => {
    it('runs from 8 down to 1', () => {
        expect(QUICK_REFERENCE.map(r => r.value)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    });

    it('accounts for all sixteen physical cards', () => {
        expect(totalCards()).toBe(16);
    });

    it('puts five Informants at value 1', () => {
        const row = QUICK_REFERENCE.find(r => r.value === 1)!;
        expect(row.count).toBe(5);
        expect(row.cards).toHaveLength(1);
    });

    it('shares value 5 between both Darells', () => {
        const row = QUICK_REFERENCE.find(r => r.value === 5)!;
        expect(row.cards.map(c => c.displayName).sort()).toEqual(['Bayta Darell', 'Toran Darell']);
        expect(row.count).toBe(2);
    });

    it('shares value 2 and value 3 between two characters each', () => {
        for (const value of [2, 3]) {
            expect(QUICK_REFERENCE.find(r => r.value === value)!.cards).toHaveLength(2);
        }
    });

    it('marks value 1 as unguessable and every other value as guessable', () => {
        for (const row of QUICK_REFERENCE) {
            expect(row.guessable).toBe(row.value !== 1);
        }
    });
});
```

**Step 2: Run — FAIL. Step 3: Implement**, deriving every row from `CARD_CATALOG` (group by value, sum `count`, sort descending, `guessable: value !== INFORMANT_VALUE`). Export `totalCards()` as the sum of every row's `count`.

**Step 4: PASS. Step 5: Commit.**

---

### Task 7: Narration

**Files:**
- Create: `src/client/content/narration.ts`
- Create: `src/client/content/narration.test.ts`

*UIX §6.5.* One `PublicLogEntry` → one sentence. This is the `aria-live` channel's entire vocabulary, so it must cover all ten entry kinds exhaustively — a missing case is a silent screen reader.

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import type { PublicLogEntry } from '../../game/engine';
import { narrate } from './narration';

const nameOf = (id: string) => ({ p1: 'Ana', p2: 'Bayta', p3: 'Toran' })[id] ?? id;

describe('narrate', () => {
    it('narrates a plain play', () => {
        const e: PublicLogEntry = { kind: 'PLAY', turn: 1, actorId: 'p1', cardId: 'mayor-indbur' };
        expect(narrate(e, nameOf)).toBe('Ana played Mayor Indbur.');
    });

    it('narrates a missed guess by value, never by character', () => {
        const e: PublicLogEntry = { kind: 'GUESS', turn: 2, actorId: 'p1', targetId: 'p2', guessedValue: 5, hit: false };
        const line = narrate(e, nameOf);
        expect(line).toBe('Ana guessed 5 against Bayta — missed.');
        expect(line).not.toContain('Darell'); // a miss must never name a card
    });

    it('narrates a hit guess', () => {
        const e: PublicLogEntry = { kind: 'GUESS', turn: 2, actorId: 'p1', targetId: 'p2', guessedValue: 5, hit: true };
        expect(narrate(e, nameOf)).toBe('Ana guessed 5 against Bayta — hit.');
    });

    it.each([
        ['tie', 'Ana and Bayta compared hands — a tie.'],
        ['actor-eliminated', 'Ana and Bayta compared hands — Ana is out.'],
        ['target-eliminated', 'Ana and Bayta compared hands — Bayta is out.']
    ] as const)('narrates a %s comparison', (result, expected) => {
        expect(narrate({ kind: 'COMPARE', turn: 3, actorId: 'p1', targetId: 'p2', result }, nameOf)).toBe(expected);
    });

    it('narrates protection, trades, redraws, fizzles, eliminations, and round end', () => {
        expect(narrate({ kind: 'PROTECTED', turn: 4, actorId: 'p1' }, nameOf)).toBe('Ana is protected until their next turn.');
        expect(narrate({ kind: 'TRADED', turn: 5, actorId: 'p1', targetId: 'p2' }, nameOf)).toBe('Ana traded hands with Bayta.');
        expect(narrate({ kind: 'REDREW', turn: 6, actorId: 'p1', targetId: 'p2', drewFrom: 'deck' }, nameOf)).toBe(
            'Bayta discarded their hand and drew from the deck.'
        );
        expect(narrate({ kind: 'FIZZLE', turn: 7, actorId: 'p1', cardId: 'informant' }, nameOf)).toBe(
            'Ana played Informant with no legal target — no effect.'
        );
        expect(narrate({ kind: 'ELIMINATED', turn: 8, playerId: 'p2', cause: 'mule-forced' }, nameOf)).toBe(
            'Bayta was forced to discard The Mule — out of the round.'
        );
        expect(narrate({ kind: 'ROUND_END', turn: 9, reason: 'deck-out', winners: ['p1'] }, nameOf)).toBe(
            'Deck ran out — highest card wins. Ana takes the round.'
        );
    });

    it('names every co-winner on a shared round win', () => {
        expect(narrate({ kind: 'ROUND_END', turn: 9, reason: 'deck-out', winners: ['p1', 'p3'] }, nameOf)).toBe(
            'Deck ran out — highest card wins. Ana and Toran take the round.'
        );
    });
});
```

**Step 2: Run — FAIL. Step 3: Implement** `narrate(entry: PublicLogEntry, nameOf: (id: PlayerId) => string): string` as an exhaustive `switch` on `entry.kind`, using `cardCopyFor(...).displayName` for card names and a small `joinNames(ids)` helper for the co-win case. Give the function an explicit `string` return type: with `noFallthroughCasesInSwitch` and a `never` default, a future log kind becomes a compile error rather than a blank announcement.

```ts
default: {
    const exhaustive: never = entry;
    return exhaustive;
}
```

**Step 4: PASS. Step 5: Commit.**

```bash
but commit uix-client -m "feat(client): card copy, quick reference, and log narration" --changes <ids>
```

---

## Stage 2: Transport gaps and build wiring

**Goal:** Close the one protocol gap the design flagged as blocking, and make a real invite link work end to end in both dev and production.
**Success criteria:** A lobby shows the host's nickname; `http://localhost:3000/join/<matchId>` serves the app; `bun run dev` reaches the server without CORS or port juggling; path traversal is refused.
**Status:** Complete

### Task 8: `RESUME_SEAT` carries an optional nickname

**Files:**
- Modify: `src/server/protocol.ts:38`, `src/server/protocol.ts:173-177`
- Modify: `src/server/room.ts:341-389`
- Modify: `src/server/dispatch.ts:157-164`
- Modify: `src/server/__tests__/protocol.test.ts`
- Create: `src/server/__tests__/hostNickname.test.ts`

*UIX §13.1.* The host seat is minted over HTTP with no nickname; `claimSeat` is the only setter; so every lobby currently shows a blank host. This is the design's recommended fix, scoped exactly as it specifies: applied **only** when the seat has no nickname **and** the phase is `lobby`.

**Step 1: Write the failing server test** at `src/server/__tests__/hostNickname.test.ts` (Bun's runner — `import { describe, expect, it } from 'bun:test'`). Model it on `src/server/__tests__/reconnect.test.ts`'s setup:

```ts
it('adopts the nickname a host presents on RESUME_SEAT', async () => {
    const created = await createRoom();
    const host = await TestClient.connect(wsBase);
    host.send({ type: 'RESUME_SEAT', matchId: created.matchId, seatToken: created.hostSeatToken, nickname: 'Cornelius' });
    const lobby = await host.next('LOBBY_UPDATE');
    expect(lobby.seats[0].nickname).toBe('Cornelius');
});

it('ignores a nickname on a seat that already has one', async () => { /* claim as p2 with 'Ana', drop, resume with 'Mallory' → still 'Ana' */ });

it('ignores a nickname once the match is active', async () => { /* start, drop, resume with a new nickname → unchanged */ });

it('rejects a control-character nickname on RESUME_SEAT as MALFORMED', async () => { /* … */ });
```

**Step 2: Run — FAIL** (`bun test src/server/__tests__/hostNickname.test.ts`): the extra key trips `hasExactKeys`, so the frame is rejected as `MALFORMED`.

**Step 3: Widen the protocol.** In `src/server/protocol.ts`, add `nickname?: string` to the `RESUME_SEAT` variant, and in its parse case:

```ts
case 'RESUME_SEAT': {
    if (!hasExactKeys(obj, ['type', 'matchId', 'seatToken'], ['nickname'])) return { ok: false };
    if (typeof obj.matchId !== 'string' || typeof obj.seatToken !== 'string') return { ok: false };
    let nickname: string | undefined;
    if (obj.nickname !== undefined) {
        nickname = parseNickname(obj.nickname, maxNickname);
        if (nickname === undefined) return { ok: false }; // present but invalid is malformed, never silently dropped
    }
    return {
        ok: true,
        msg: { type: 'RESUME_SEAT', matchId: obj.matchId, seatToken: obj.seatToken, ...(nickname !== undefined ? { nickname } : {}) }
    };
}
```

**Step 4: Apply it in `Room.resumeSeat`**, immediately after the seat is found and before any send — persistence precedes sends (Design §9), and `nickname` is a `StoredSeat` field, so the write must be persisted:

```ts
resumeSeat(conn: SeatConnection, token: string, nickname?: string): { seat: number; playerId: PlayerId } | null {
    const seat = this.seats.find(s => s.tokenHash !== null && tokenMatches(token, s.tokenHash));
    if (!seat) {
        this.sendFatal(conn, 'BAD_TOKEN');
        return null;
    }

    // UIX §13.1: the host seat is minted over HTTP with no nickname, and claimSeat
    // never runs for it. Adopt one exactly once, in lobby only — never a rename.
    if (nickname !== undefined && seat.nickname === null && this.phase === 'lobby') {
        seat.nickname = nickname;
        this.persist();
    }
    // …rest unchanged
```

**Step 5: Thread it through dispatch** — `room.resumeSeat(state.conn, msg.seatToken, msg.nickname)`.

**Step 6: Extend `protocol.test.ts`** with valid-with-nickname, valid-without, oversized, control-character, and unknown-extra-key cases.

**Step 7: Run the full gate.**

```bash
bun run test && bunx tsc --noEmit
```

Expected: PASS, including every pre-existing server test — the field is optional, so no existing frame changes shape.

**Step 8: Commit.**

```bash
but commit uix-client -m "feat(server): let RESUME_SEAT adopt a nickname for the host seat" --changes <ids>
```

---

### Task 9: Serve the client, and route the upgrade by header

**Files:**
- Modify: `src/server/config.ts`
- Modify: `src/server/index.ts:52-79`
- Modify: `package.json` (the `serve` script)
- Create: `src/server/__tests__/static.test.ts`

`joinUrl` is `publicBaseUrl + '/join/' + matchId` (`src/server/roomRegistry.ts:63`) and `publicBaseUrl` defaults to the server's own origin — but `fetch` currently answers every non-upgrade request with `404`. Every invite link is therefore dead. This task makes the server host the built client with SPA fallback.

**Step 1: Write the failing test** at `src/server/__tests__/static.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { makeConfig } from '../config';
import { startServer } from '../index';

const ROOT = '/tmp/mules-static-test';

describe('static hosting', () => {
    let running: ReturnType<typeof startServer>;
    let base: string;

    beforeAll(() => {
        mkdirSync(`${ROOT}/assets`, { recursive: true });
        writeFileSync(`${ROOT}/index.html`, '<!doctype html><title>court</title>');
        writeFileSync(`${ROOT}/assets/card.png`, 'PNGDATA');
        running = startServer(makeConfig({ port: 0, dbPath: ':memory:', staticRoot: ROOT }));
        base = `http://localhost:${running.server.port}`;
    });

    afterAll(() => {
        running.stop();
        rmSync(ROOT, { recursive: true, force: true });
    });

    it('serves index.html at the root', async () => {
        expect(await (await fetch(`${base}/`)).text()).toContain('court');
    });

    it('falls back to index.html for a join route so the SPA can boot', async () => {
        const res = await fetch(`${base}/join/K7QX2`);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('court');
    });

    it('serves a real asset with its own bytes', async () => {
        expect(await (await fetch(`${base}/assets/card.png`)).text()).toBe('PNGDATA');
    });

    it('refuses to escape the static root', async () => {
        for (const attack of ['/../config.ts', '/..%2f..%2fetc%2fpasswd', '/assets/../../package.json']) {
            expect((await fetch(`${base}${attack}`)).status, attack).toBe(404);
        }
    });

    it('404s a missing file that looks like a file', async () => {
        expect((await fetch(`${base}/assets/missing.png`)).status).toBe(404);
    });

    it('404s an unknown API path rather than falling back to the app', async () => {
        expect((await fetch(`${base}/api/nope`)).status).toBe(404);
    });

    it('still upgrades a WebSocket on any path', async () => {
        const ws = new WebSocket(`ws://localhost:${running.server.port}/ws`);
        await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => reject(new Error('upgrade refused'));
        });
        ws.close();
    });
});
```

**Step 2: Run — FAIL** (`staticRoot` is not a config field; every route 404s).

**Step 3: Add the config field, defaulting to `null`.** In `src/server/config.ts`:

```ts
/** Directory of built client files to host, or null to serve none. */
readonly staticRoot: string | null;
```

**Default it to `null`, not `'dist'`.** `dist/` is gitignored Vite output; a transport default naming it would make the server's configuration depend on a build artifact that need not exist. A transport with no client to serve is a valid configuration — it is precisely what all 169 pre-existing server tests are — so `null` is the honest default and hosting is an explicit deployment opt-in.

The one mention of `dist` lives in `package.json`, one line from the `build` script that produces it:

```json
"serve": "MULES_STATIC_ROOT=dist bun src/server/index.ts",
```

and `index.ts`'s entrypoint reads it:

```ts
if (import.meta.main) {
    startServer(makeConfig({ staticRoot: Bun.env.MULES_STATIC_ROOT ?? null }));
}
```

*(Checked rather than assumed: exactly one pre-existing test requests a non-`/api` path — `abuse.test.ts:385` fetches `/` — and it sends `Upgrade: websocket` and asserts `101`, so under header-keyed routing it takes the upgrade branch and never reaches `serveStatic`. A `'dist'` default would not have broken any test. It would still have been the wrong default.)*

**Step 4: Rewrite `fetch` in `src/server/index.ts`** with an explicit route order:

```ts
fetch(req, srv) {
    const url = new URL(req.url);
    const ip = srv.requestIP(req)?.address ?? 'unknown';

    if (req.method === 'POST' && url.pathname === '/api/rooms') {
        if (!ipLimiter.take(ip)) return new Response('Too Many Requests', { status: 429 });
        return roomCreatedResponse(registry.createRoom());
    }

    // Keyed on the header, not the path: the Vite dev proxy wants a stable
    // `/ws` prefix, while thirteen existing tests connect to `/`. Both work.
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        if (!ipLimiter.take(ip)) return new Response('Too Many Requests', { status: 429 });
        const data: ConnectionState = { /* unchanged */ };
        if (srv.upgrade(req, { data })) return;
        return new Response('Upgrade Failed', { status: 400 });
    }

    if (url.pathname.startsWith('/api/')) return new Response('Not Found', { status: 404 });

    if (config.staticRoot !== null) return serveStatic(config.staticRoot, url.pathname);

    return new Response('Not Found', { status: 404 });
}
```

**Step 5: Implement `serveStatic`** as a module-level helper in the same file:

```ts
/**
 * Static hosting with an SPA fallback for `/join/:matchId` (UIX §2.6).
 *
 * The resolve-then-prefix-check is the whole security story: `path.resolve`
 * collapses every `..`, and a resolved path that no longer starts with the root
 * is refused before `Bun.file` ever sees it. Percent-encoded traversal is
 * covered because decoding happens first, resolution second.
 */
async function serveStatic(root: string, pathname: string): Promise<Response> {
    const base = resolve(root);
    let decoded: string;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        return new Response('Not Found', { status: 404 });
    }

    const target = resolve(base, '.' + decoded);
    if (target !== base && !target.startsWith(base + sep)) {
        return new Response('Not Found', { status: 404 });
    }

    const file = Bun.file(target);
    if (await file.exists()) return new Response(file);

    // A path with no extension is a client route: hand back the app shell.
    if (!basename(target).includes('.')) {
        const shell = Bun.file(join(base, 'index.html'));
        if (await shell.exists()) return new Response(shell);
    }

    return new Response('Not Found', { status: 404 });
}
```

Import `{ basename, join, resolve, sep }` from `node:path`. Note `fetch` now returns `Promise<Response>` on the static branch — Bun accepts that.

**Step 6: Run the full server suite.** Expected: PASS, all pre-existing tests included — they inherit `staticRoot: null`, so their behaviour is unchanged and they gain no filesystem dependency. `static.test.ts` is the only suite that passes a root, and it builds its own fixture directory under a temp path.

**Step 7: Commit.**

```bash
but commit uix-client -m "feat(server): host the built client with an SPA fallback and safe paths" --changes <ids>
```

---

### Task 10: Vite base path, dev proxy, and the page shell

**Files:**
- Modify: `vite/config.dev.mjs`, `vite/config.prod.mjs`
- Modify: `index.html`
- Create: `public/style.css` *(only if absent — check first)*

**Step 1: Fix the base path.** In **both** Vite configs change `base: './'` to `base: '/'`.

This is not cosmetic. With `base: './'`, a browser at `/join/K7QX2` resolves `./assets/index-abc.js` to `/join/assets/index-abc.js` and the app never boots. The relative base exists so `dist/` can be hosted from a subpath; *UIX §2.6*'s routes trade that away deliberately, and this comment belongs in the config so nobody "fixes" it back:

```js
// Absolute, not './': the client owns the /join/:matchId route (UIX §2.6), and a
// relative base resolves asset URLs against /join/ on a real invite link.
base: '/',
```

**Step 2: Add the dev proxy** to `vite/config.dev.mjs`, so the dev client is same-origin and needs no environment variable:

```js
server: {
    port: 8080,
    proxy: {
        '/api': { target: 'http://localhost:3000', changeOrigin: true },
        '/ws': { target: 'ws://localhost:3000', ws: true }
    }
}
```

**Step 3: Rewrite `index.html`** for the two-layer architecture (*UIX §2*):

```html
<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/png" href="/favicon.png" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="color-scheme" content="dark" />
    <title>The Mule's Court</title>
</head>
<body>
    <div id="app">
        <div id="game-container"></div>
        <!-- The DOM layer. Fixed above the canvas, pointer-events:none at the root;
             interactive children restore auto, so the layers never fight for a tap. -->
        <div id="ui-root"></div>
        <div id="a11y-twin" aria-live="polite"></div>
    </div>
    <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

The `<link rel="stylesheet" href="/style.css">` line goes away: `src/main.ts` will import `styles/tokens.css` and `styles/ui.css` so Vite fingerprints and bundles them.

**Step 4: Verify by hand.**

```bash
bun run build && bun run serve    # in one shell
curl -s localhost:3000/join/TESTID | head -5
```

Expected: the HTML shell, with `/assets/...` absolute script tags.

**Step 5: Commit.**

```bash
but commit uix-client -m "build: absolute base, dev proxy, and the two-layer page shell" --changes <ids>
```

---

## Stage 3: Client core — routes, tokens, socket, store

**Goal:** Everything between the WebSocket and the renderer, fully tested without a browser.
**Success criteria:** A scripted sequence of `ServerMessage`s drives the store through host → lobby → match → round over → match over; a dropped socket reconnects with backoff; `FATAL BAD_TOKEN` clears the stored token exactly once.
**Status:** Complete

### Task 11: Route parsing

**Files:**
- Create: `src/client/store/routes.ts`, `src/client/store/routes.test.ts`

**Step 1: Test first**

```ts
import { describe, expect, it } from 'vitest';
import { parseRoute } from './routes';

describe('parseRoute', () => {
    it('reads the menu at the root', () => {
        expect(parseRoute('/')).toEqual({ kind: 'menu' });
    });

    it('reads a join route', () => {
        expect(parseRoute('/join/K7QX2')).toEqual({ kind: 'join', matchId: 'K7QX2' });
    });

    it('tolerates a trailing slash', () => {
        expect(parseRoute('/join/K7QX2/')).toEqual({ kind: 'join', matchId: 'K7QX2' });
    });

    it('treats a join route with no id as unknown', () => {
        expect(parseRoute('/join/')).toEqual({ kind: 'unknown' });
    });

    it('treats anything else as unknown', () => {
        expect(parseRoute('/m/K7QX2')).toEqual({ kind: 'unknown' }); // the old VISUAL_SHOWCASE shape
        expect(parseRoute('/join/a/b')).toEqual({ kind: 'unknown' });
    });
});
```

**Step 2: Implement**, taking a pathname string — never reading `location` — so the module stays pure and the caller in `main.ts` supplies `location.pathname`.

**Step 3: Commit.**

---

### Task 12: Seat token storage

**Files:**
- Create: `src/client/store/seatTokenStore.ts`, `src/client/store/seatTokenStore.test.ts`

Key shape is fixed by *UIX §3*: `mules-court:${matchId}`.

**Step 1: Test first** with an injected storage object — an in-memory `Map`-backed implementation of the three methods used. Cases: round-trips `{seat, playerId, seatToken}`; returns `null` for an unknown match; `clear` removes exactly one match and leaves the others; a corrupt JSON value returns `null` instead of throwing (a half-written entry must never brick the app).

**Step 2: Implement**

```ts
export interface StoredSeat {
    readonly seat: number;
    readonly playerId: PlayerId;
    readonly seatToken: string;
}

export interface KeyValueStore {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export function createSeatTokenStore(storage: KeyValueStore) { /* … */ }
```

`main.ts` passes `window.localStorage`; every test passes a fake. Safari private mode throws on `setItem` — wrap writes in `try/catch` and degrade to "no stored seat" rather than crashing, and test that case explicitly.

**Step 3: Commit.**

---

### Task 13: The socket client

**Files:**
- Create: `src/client/store/socket.ts`, `src/client/store/socket.test.ts`

**Step 1: Test first**, against an injected `WebSocketLike` factory and injected timers:

```ts
interface WebSocketLike {
    send(data: string): void;
    close(): void;
    onopen: (() => void) | null;
    onclose: (() => void) | null;
    onmessage: ((e: { data: string }) => void) | null;
    onerror: (() => void) | null;
}
```

Cases:
- On open with a stored token → the **first** frame is `RESUME_SEAT` carrying `nickname` when one is known.
- On open with no stored token → nothing is sent; the join flow drives `CLAIM_SEAT`.
- A parsed `ServerMessage` reaches the `onMessage` sink exactly once.
- An unparseable frame is dropped without throwing (the client trusts the server's shape no more than the server trusts the client's).
- On close, reconnect delays follow 500, 1000, 2000, 4000, 8000, 8000 ms — assert against an injected `random: () => 0.5` so jitter is deterministic.
- A successful open resets the backoff to 500.
- `close()` by the caller cancels any pending reconnect timer and never reconnects.

**Step 2: Implement.** The URL is derived same-origin so dev and production share one code path:

```ts
/** `https://host/anything` → `wss://host/ws`. Same origin in dev (via the Vite proxy) and in production. */
export function socketUrl(origin: string): string {
    return origin.replace(/^http/, 'ws') + '/ws';
}
```

**Step 3: Commit.**

---

### Task 14: The client store

**Files:**
- Create: `src/client/store/types.ts`, `src/client/store/store.ts`, `src/client/store/store.test.ts`

*UIX §2.1.* One object holds the connection lifecycle plus the latest snapshot. It never derives a game rule.

**Step 1: Define the state**

```ts
export type Screen = 'menu' | 'joining' | 'lobby' | 'table' | 'fatal';
export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface TableSnapshot {
    readonly view: RedactedView;
    readonly nicknames: Record<PlayerId, string>;
    readonly phase: 'active' | 'round_over' | 'ended';
    readonly paused: boolean;
    readonly missingSeats: readonly PlayerId[];
    readonly revealDeadline?: number;
    readonly serverTime: number;
    /** Local receipt time, used only to age the server clock for countdowns. */
    readonly receivedAt: number;
}

export interface ClientState {
    readonly screen: Screen;
    readonly connection: ConnectionStatus;
    readonly matchId: string | null;
    readonly seat: { seat: number; playerId: PlayerId } | null;
    readonly lobby: LobbySnapshot | null;
    readonly table: TableSnapshot | null;
    readonly ended: { reason: 'won' | 'abandoned'; winnerSeat?: PlayerId } | null;
    /** In flight PLAY_CARD; cleared by the next STATE_UPDATE or a matching ERROR. */
    readonly pendingPlay: { clientMsgId: string; cardInstanceId: CardInstanceId } | null;
    readonly fatal: ErrorCode | null;
    readonly notices: readonly Notice[];
}
```

**Step 2: Test first.** These are the behaviours that matter:

- `SEAT_CLAIMED` stores `{seat, playerId, seatToken}` through the token store and moves the screen to `lobby`.
- `LOBBY_UPDATE` replaces the lobby snapshot wholesale; a seat that goes from occupied to open is reflected, never merged.
- `MATCH_STARTED` alone does **not** move to `table` — the first `STATE_UPDATE` does. (`MATCH_STARTED` is a broadcast; the per-seat view arrives separately.)
- `STATE_UPDATE` replaces `table`, stamps `receivedAt` from the injected clock, and clears `pendingPlay`.
- `ERROR` with a `refId` matching `pendingPlay.clientMsgId` clears the pending play and pushes a notice; a non-matching `refId` leaves it alone.
- `ERROR RATE_LIMITED` pushes a notice and is never fatal.
- `FATAL BAD_TOKEN` clears the stored token for that match **exactly once** and sets `screen: 'joining'` for a fresh claim — never `fatal`, because *UIX §5* says a bad token retries as a new join.
- `FATAL SEAT_TAKEN` sets `screen: 'fatal'` with the code, and does **not** clear the token — "Take over here" needs it.
- `MATCH_ENDED` records the reason and winner; a later `STATE_UPDATE` is still accepted (the server pushes state before `MATCH_ENDED`).
- `playCard(...)` mints a `clientMsgId`, sets `pendingPlay`, and emits exactly one `PLAY_CARD` frame; a second call while pending emits nothing.

Every test drives `store.apply(msg)` directly with literal `ServerMessage` objects — no socket, no DOM. Build views with a small `makeView()` helper in `src/client/store/__fixtures__/view.ts` rather than hand-writing a `RedactedView` per test.

**Step 3: Implement** `createStore(deps: { tokens, send, now, mintId })` exposing `getState()`, `subscribe(listener): () => void`, `apply(msg)`, and the small set of local intents (`playCard`, `cancelPending`, `dismissNotice`, `setConnection`). Notify subscribers once per `apply`, after the state object is swapped — one immutable replacement, never in-place mutation, so a subscriber can diff old against new.

**Step 4: Commit.**

```bash
but commit uix-client -m "feat(client): route parsing, seat token store, socket, and client store" --changes <ids>
```

---

### Task 15: Diffing and the presentation queue

**Files:**
- Create: `src/client/store/diff.ts`, `src/client/store/diff.test.ts`
- Create: `src/client/store/presentationQueue.ts`, `src/client/store/presentationQueue.test.ts`

*UIX §2.1* ("animation derives from diffing") and *UIX §8.4* (the sequencing rule).

**Step 1: Test `diffSnapshots(prev, next)` first**

- Appended `publicLog` entries come back in order, as `{ kind: 'log', entry }` events.
- A `publicLog` that is unchanged yields no events.
- A shorter `publicLog` (a new round resets it) yields the **whole** new log, not a negative slice — this is the round-boundary case and it is easy to get wrong.
- A new `revealed[]` member yields `{ kind: 'peek-gained', subjectId, cardTypeId }`.
- A departed `revealed[]` member yields `{ kind: 'peek-lost', subjectId }`.
- A `roundResult` appearing where there was none yields `{ kind: 'round-over', result }`.

**Step 2: Test `createPresentationQueue()` first.** The rule under test: an announcement never precedes its animation.

```ts
it('never announces before the matching animation resolves', async () => {
    const spoken: string[] = [];
    const queue = createPresentationQueue({ announce: line => spoken.push(line) });

    let releaseFirst!: () => void;
    queue.enqueue({ animate: () => new Promise<void>(r => (releaseFirst = r)), announce: 'first' });
    queue.enqueue({ animate: () => Promise.resolve(), announce: 'second' });

    await Promise.resolve();
    expect(spoken).toEqual([]);   // the first animation has not resolved

    releaseFirst();
    await queue.drained();
    expect(spoken).toEqual(['first', 'second']); // strict order, never interleaved
});

it('still announces when an animation throws', async () => { /* a failed tween must not silence the screen reader */ });

it('runs animations one at a time', async () => { /* overlapping enqueues do not start concurrently */ });
```

**Step 3: Implement** the queue as a serialized promise chain — the same shape as `Room.enqueue` in `src/server/room.ts:280`, which is a good precedent to follow deliberately.

**Step 4: Commit.**

---

## Stage 4: Layout — geometry as pure data

**Goal:** Every canvas position and size is computed by tested functions that have never heard of Phaser.
**Success criteria:** Three opponent chips fit 390 px; **eight** discard pips stay legible; no two rects overlap in any topology; every rect is inside the viewport. Each holds across the full cross product of viewport, seat count, and hand size, not at one reference phone.
**Status:** Complete

> **Eight, not seven.** Task 18 measures the worst case against the engine rather
> than taking UIX §6.2's figure on trust, and gets eight at every seat count. A
> two-player round deals a deck of ten, so turns alternate and one seat takes five
> of them: five own-turn discards, plus the two Prince-effect cards — Bayta and
> Toran — each forcing that seat to discard out of turn, plus the one held card
> revealed on elimination. The design's figure counted a single Prince.
> **UIX §6.2 still says seven and wants correcting when the design doc is next opened.**

### Task 16: Topology classification

**Files:**
- Create: `src/client/layout/topology.ts`, `src/client/layout/topology.test.ts`

**Step 1: Test first.** Boundaries are *UIX §2.2*'s exactly:

```ts
it.each([
    [390, 844, 'portrait'],       // iPhone 14 portrait, aspect 0.46
    [768, 1024, 'portrait'],      // iPad portrait, aspect 0.75
    [844, 390, 'landscape-narrow'], // rotated phone, aspect 2.16 → see below
    [1024, 768, 'landscape-narrow'],// aspect 1.33
    [1920, 1080, 'wide']          // aspect 1.78
] as const)('classifies %ix%i as %s', (w, h, expected) => {
    expect(classifyTopology(w, h)).toBe(expected);
});

it('places the class boundaries exactly at 0.9 and 1.45', () => {
    expect(classifyTopology(89, 100)).toBe('portrait');            // 0.89
    expect(classifyTopology(90, 100)).toBe('landscape-narrow');    // 0.90 — inclusive lower edge
    expect(classifyTopology(144, 100)).toBe('landscape-narrow');   // 1.44
    expect(classifyTopology(146, 100)).toBe('wide');               // 1.46
});
```

Note the rotated-phone case: 844×390 has aspect 2.16, which lands in `wide` by the raw rule. *UIX §6.1* calls a rotated phone `landscape-narrow`, so the classifier needs a second dimension — **short height forces `landscape-narrow` regardless of aspect**:

```ts
/** A viewport under this height cannot afford `wide`'s generous seat panels, whatever its aspect. */
const MIN_WIDE_HEIGHT = 560;

export function classifyTopology(w: number, h: number): Topology {
    const aspect = w / h;
    if (aspect < 0.9) return 'portrait';
    if (aspect > 1.45 && h >= MIN_WIDE_HEIGHT) return 'wide';
    return 'landscape-narrow';
}
```

Write the test for `844×390 → 'landscape-narrow'` and `1920×1080 → 'wide'` **first**, watch the naive aspect-only version fail on the rotated phone, then add the height guard. This is the plan's one place where the design's stated rule is incomplete; resolving it in the open, with a test, is the point.

**Step 2: Commit.**

---

### Task 17: The portrait `LayoutSpec`

**Files:**
- Create: `src/client/layout/types.ts`, `src/client/layout/tableLayout.ts`, `src/client/layout/tableLayout.test.ts`
- Create: `src/client/layout/rect.ts` (`intersects`, `contains` — used by tests and by hit-testing)

**Step 1: Define the spec** exactly as *UIX §6.1*'s portrait composition requires:

```ts
export interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

export interface LayoutInput {
    readonly w: number;
    readonly h: number;
    readonly opponentCount: 1 | 2 | 3;
    readonly handCount: 1 | 2;
    /** True in a two-player round: the face-up burn gets its own panel (UIX §6.1). */
    readonly showsRemovedCard: boolean;
    /** Worst-case discard count across all seats — drives pip sizing. */
    readonly maxDiscards: number;
}

export interface LayoutSpec {
    readonly topology: Topology;
    readonly viewport: Rect;
    readonly statusStrip: Rect;
    readonly opponents: readonly Rect[];
    readonly deck: Rect;
    readonly removedCard: Rect | null;
    readonly banner: Rect;
    readonly toastZone: Rect;
    readonly ownStatus: Rect;
    readonly hand: readonly Rect[];
    readonly cardScale: number;
    readonly pip: { readonly size: number; readonly perRow: number };
}
```

**Step 2: Test first.** These assertions are the design's promises, written down:

```ts
const PHONE = { w: 390, h: 844 } as const;

describe('portrait layout', () => {
    it('fits three opponent chips across a 390px phone', () => {
        const spec = computeLayout({ ...PHONE, opponentCount: 3, handCount: 1, showsRemovedCard: false, maxDiscards: 3 });
        expect(spec.opponents).toHaveLength(3);
        for (const chip of spec.opponents) expect(chip.w).toBeGreaterThanOrEqual(110);
        const rightmost = last(spec.opponents); // see the note below — not `.at(-1)`
        const spanned = rightmost.x + rightmost.w - spec.opponents[0].x;
        expect(spanned).toBeLessThanOrEqual(PHONE.w);
    });

    it('keeps every element inside the viewport', () => {
        for (const opponentCount of [1, 2, 3] as const) {
            const spec = computeLayout({ ...PHONE, opponentCount, handCount: 2, showsRemovedCard: opponentCount === 1, maxDiscards: 7 });
            for (const rect of allRects(spec)) expect(contains(spec.viewport, rect)).toBe(true);
        }
    });

    it('never overlaps two elements', () => {
        const spec = computeLayout({ ...PHONE, opponentCount: 3, handCount: 2, showsRemovedCard: false, maxDiscards: 4 });
        const rects = allRects(spec);
        for (let i = 0; i < rects.length; i++) {
            for (let j = i + 1; j < rects.length; j++) {
                expect(intersects(rects[i], rects[j]), `${i} overlaps ${j}`).toBe(false);
            }
        }
    });

    it('stacks the removed-card panel below the deck in a two-player round', () => {
        const spec = computeLayout({ ...PHONE, opponentCount: 1, handCount: 1, showsRemovedCard: true, maxDiscards: 2 });
        expect(spec.removedCard).not.toBeNull();
        expect(spec.removedCard!.y).toBeGreaterThanOrEqual(spec.deck.y + spec.deck.h);
    });

    it('omits the removed-card panel at three and four players', () => {
        const spec = computeLayout({ ...PHONE, opponentCount: 3, handCount: 1, showsRemovedCard: false, maxDiscards: 2 });
        expect(spec.removedCard).toBeNull();
    });

    it('is fully fluid within the class — every rect scales with the viewport', () => {
        const small = computeLayout({ w: 360, h: 780, opponentCount: 3, handCount: 2, showsRemovedCard: false, maxDiscards: 3 });
        const large = computeLayout({ w: 430, h: 932, opponentCount: 3, handCount: 2, showsRemovedCard: false, maxDiscards: 3 });
        expect(large.deck.w).toBeGreaterThan(small.deck.w);
        expect(large.hand[0].h).toBeGreaterThan(small.hand[0].h);
    });
});
```

`allRects(spec)` is a test helper that flattens the spec, skipping `null`s and `viewport`.

**`last()`, not `.at(-1)`.** `Array.prototype.at` is ES2022 and `tsconfig.json` sets
`lib: ["ES2020", ...]`, so `.at(-1)` fails `bunx tsc --noEmit` with TS2550. No file
in `src/` uses an ES2021+ array method, and this snippet was the plan's only one.
Put the helper beside `allRects` in the layout test file — Task 19 reuses the same
invariant helpers, and it drops two non-null assertions and a duplicated lookup:

```ts
/** Last element, or a clear failure. `.at(-1)` is ES2022; tsconfig's lib is ES2020. */
function last<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('expected a non-empty array');
    return items[items.length - 1];
}
```

**Do not "fix" this by widening `lib` alone.** `lib` governs type declarations while
`target` governs syntax downleveling, and `.at` is neither — it is a runtime method
that no tool in this pipeline polyfills (tsc runs with `noEmit`; Vite/esbuild
transpile syntax only). Raising `lib` to ES2022 while `target` stays ES2020 makes
`tsc` accept code that would throw on any browser matching the declared target. If
the project later wants modern methods generally, raise **both** so the config
stops claiming support it does not have.

**Step 3: Implement `computeLayout`** as fractions of the live viewport, with the topology chosen by `classifyTopology`. Every constant gets a named `const` with a comment; no bare numbers in the body.

**Step 4: Commit.**

---

### Task 18: Discard pips never truncate

**Files:**
- Modify: `src/client/layout/tableLayout.ts`, `src/client/layout/tableLayout.test.ts`

*UIX §6.2* and interface rule 7. This is the single hardest layout constraint, and the design justifies it as deduction data — so it gets its own task and its own worst case.

**Step 1: Establish the worst case empirically** with an engine-driven test at `src/client/layout/discardCapacity.test.ts`. Do **not** trust the design's "7" on faith — derive it:

```ts
import { describe, expect, it } from 'vitest';
import { createMatch, reduce } from '../../game/engine';

it('never exceeds the pip capacity the layout reserves', () => {
    // Play many seeded two-player rounds to completion with a legal-move-picking
    // driver, tracking the largest single-seat discard pile ever reached.
    let worst = 0;
    for (let seed = 0; seed < 200; seed++) { /* drive a match; record max discardPile.length */ }
    expect(worst).toBeLessThanOrEqual(MAX_DISCARDS);
});
```

Reuse the driver style already in `src/game/engine/__tests__/integration.test.ts` rather than inventing one. If the measured worst case exceeds 7, **raise `MAX_DISCARDS` to the measured number** and say so in a comment — the layout must fit reality, not the estimate.

**Step 2: Test the pip sizing**

```ts
it('keeps pips legible at the worst-case pile', () => {
    const spec = computeLayout({ w: 390, h: 844, opponentCount: 3, handCount: 1, showsRemovedCard: false, maxDiscards: MAX_DISCARDS });
    expect(spec.pip.size).toBeGreaterThanOrEqual(MIN_PIP_PX); // the legible floor
    expect(spec.pip.perRow * PIP_ROWS_MAX).toBeGreaterThanOrEqual(MAX_DISCARDS); // every value has a slot
});

it('shrinks pips before it shrinks anything else in the chip', () => {
    const roomy = computeLayout({ /* maxDiscards: 2 */ });
    const crowded = computeLayout({ /* maxDiscards: MAX_DISCARDS */ });
    expect(crowded.pip.size).toBeLessThan(roomy.pip.size);
    expect(crowded.opponents[0].w).toBe(roomy.opponents[0].w); // the chip itself does not give way
});
```

**Step 3: Implement** pip sizing: wrap to more rows as the pile grows, shrink toward `MIN_PIP_PX`, and never drop a value. If the floor is reached and values still do not fit, the chip grows — the values do not disappear.

**Step 4: Commit.**

---

### Task 19: Landscape-narrow and wide compositions

**Files:**
- Modify: `src/client/layout/tableLayout.ts`, `src/client/layout/tableLayout.test.ts`

**Step 1: Test first**, reusing the same invariant helpers (inside viewport, no overlaps, fluid within class) across `844×390`, `1024×768`, and `1920×1080`, at 1, 2, and 3 opponents, with 1 and 2 hand cards — a `describe.each` over the cross product. Add the composition assertions that distinguish the classes:

- Landscape-narrow: opponents form a shallow arc — chip `y` values are not all equal, and the outer chips sit lower than the centre.
- Landscape-narrow: the hand keeps full width (`hand[0].x` near the left margin at two cards).
- Wide: the removed-card panel sits **beside** the deck (`removedCard.x > deck.x + deck.w`), not below it — the one composition difference from portrait.
- Wide: `cardScale` exceeds portrait's at the same opponent count.

**Step 2: Implement. Step 3: Commit.**

```bash
but commit uix-client -m "feat(client): pure table layout for all three topology classes" --changes <ids>
```

---

## Stage 5: The DOM layer

**Goal:** Every surface made of words, as real DOM with real buttons, real focus order, and real disabled reasons.
**Success criteria:** Menu → host → lobby → table chrome all drive from the store; every failure code in *UIX §5* has designed copy; axe-core is clean.
**Status:** Complete

**Shared conventions for this stage.** Every UI module exports one factory:

```ts
export function createLobbyScreen(deps: LobbyDeps): { mount(parent: HTMLElement): void; update(state: ClientState): void; destroy(): void }
```

No module reads the store directly — `update(state)` is pushed by one subscriber in `main.ts`. No module reads `location` or `localStorage`; those arrive through `deps`. Every test file starts with `// @vitest-environment jsdom` and asserts against roles and accessible names (`getByRole`-style queries hand-written over `querySelector`, or plain `querySelector` with `aria-label` assertions) — never against class names, which are styling, not behaviour.

### Task 20: UI root, connection dot, toasts

**Files:**
- Create: `src/client/ui/uiRoot.ts`, `src/client/ui/connectionDot.ts`, `src/client/ui/toasts.ts` and their tests
- Create: `src/client/styles/ui.css`

**Step 1: Test first**

- The root sets `pointer-events: none`; a mounted interactive child sets `auto` (*UIX §2*).
- The connection dot's accessible name changes across `open` → `reconnecting` → `closed`, and it renders on every screen.
- `toasts` renders into a container with `aria-live="polite"` and `role="status"`.
- A toast auto-dismisses after its timeout using an **injected** timer, and dismissing one leaves the others.
- Toast text is set via `textContent`, never `innerHTML` — assert that a nickname of `<img src=x onerror=alert(1)>` produces no `img` element. Nicknames are the only free text in the protocol and they arrive from other players; this is the injection boundary.

**Step 2: Implement. Step 3: Commit.**

---

### Task 21: Menu and hosting

**Files:**
- Create: `src/client/ui/menuScreen.ts`, `src/client/ui/menuScreen.test.ts`
- Create: `src/client/store/roomApi.ts`, `src/client/store/roomApi.test.ts`

**Step 1: Test `roomApi` first** with an injected `fetch`:

- `createRoom()` POSTs to `/api/rooms` and returns `{matchId, joinUrl, hostSeat, hostSeatToken}`.
- A `429` retries with backoff (injected timers, injected random) and succeeds on a later attempt.
- Retries are capped, and the final failure is a typed result — `{ ok: false, reason: 'rate-limited' }` — never a thrown string.
- A `500` fails immediately without retrying: retrying a server error is not the design's promise (*UIX §5* names 429 alone).

**Step 2: Test the menu screen.** *UIX §3*'s critical invariant deserves an explicit test, because losing this token loses the host's seat permanently:

```ts
it('persists the host seat token before it navigates anywhere', async () => {
    const order: string[] = [];
    const screen = createMenuScreen({
        roomApi: { createRoom: async () => ({ ok: true, room: FAKE_ROOM }) },
        tokens: { save: () => order.push('save') },
        navigate: () => order.push('navigate')
    });
    screen.mount(document.body);
    (document.querySelector('[data-action="host"]') as HTMLButtonElement).click();
    await flush();
    expect(order).toEqual(['save', 'navigate']); // the token never arrives over the socket; there is no second copy
});
```

Plus: two buttons with accessible names "Host a game" and "Join a game"; the paste-a-link field extracts a `matchId` from a full URL *and* from a bare id; the host button is disabled while a request is in flight.

**Step 3: Implement. Step 4: Commit.**

---

### Task 22: Join flow

**Files:**
- Create: `src/client/ui/joinScreen.ts`, `src/client/ui/joinScreen.test.ts`
- Create: `src/client/content/nickname.ts`, `src/client/content/nickname.test.ts`

*UIX §3*: validate client-side so `MALFORMED` never round-trips.

**Step 1: Test `validateNickname` first**, mirroring `src/server/protocol.ts:104-110` exactly — trim, reject empty, reject > 24, reject C0 controls and DEL. Include the boundary cases at 24 and 25 characters, a whitespace-only string, an emoji nickname (accepted — the server accepts any non-control character), and a non-Latin nickname such as `Ана` (accepted).

```ts
// The limit is the server's, imported rather than retyped, so the two can never
// drift into a state where the client sends what the server refuses.
import { DEFAULT_CONFIG } from '../../server/config';
```

*(Type-only imports from the server are already conventional here; `DEFAULT_CONFIG` is a plain literal with no Bun dependency, so this is safe to bundle. Verify with `bun run build` — if the import ever drags server code into the client chunk, inline the constant with a comment pointing at `config.ts` instead.)*

**Step 2: Test the join screen** — a labelled text input, a **Take a seat** button disabled until the nickname validates, an inline error message tied to the input via `aria-describedby`, and Enter submitting the form.

**Step 3: Implement. Step 4: Commit.**

---

### Task 23: Lobby

**Files:**
- Create: `src/client/ui/lobbyScreen.ts`, `src/client/ui/lobbyScreen.test.ts`

**Step 1: Test first** against *UIX §4*:

- Four seat rows render from `LOBBY_UPDATE.seats`, showing nickname, `(open)`, or `Reconnecting…`.
- The host row carries a host marker and `(you)` when it is this viewer's seat.
- A seat with no nickname renders **"Host"** as the fallback — the *UIX §13.1* path, still reachable when a host's client predates Task 8.
- The invite box shows the join URL and copies it through an **injected** clipboard; the button reports success in an `aria-live` region.
- **Start Match** renders for the host only.
- Disabled Start Match carries the caption "Waiting for 2–4 players, all connected" and an `aria-describedby` pointing at it; enabled exactly when `canStart` is true.
- When the host is gone past the grace, every remaining seat gains a **Dissolve lobby** button that emits `END_MATCH`.

**Step 2: Implement. Step 3: Commit.**

---

### Task 24: Failure surfaces

**Files:**
- Create: `src/client/content/failureCopy.ts`, `src/client/content/failureCopy.test.ts`
- Create: `src/client/ui/fatalScreen.ts`, `src/client/ui/fatalScreen.test.ts`

**Step 1: Test the copy map first.** Every code in `ErrorCode` must resolve to designed copy — the design's promise is that *none* fall through to a generic message:

```ts
import type { ErrorCode } from '../../server/protocol';

const ALL_CODES: ErrorCode[] = [
    'MALFORMED', 'ROOM_NOT_FOUND', 'SEAT_TAKEN', 'ROOM_FULL', 'ALREADY_SEATED', 'BAD_TOKEN',
    'NOT_YOUR_SEAT', 'NOT_HOST', 'CANNOT_START', 'PAUSED', 'MATCH_OVER', 'RATE_LIMITED', 'INTERNAL',
    'ROUND_NOT_IN_PROGRESS', 'NOT_YOUR_TURN', 'CARD_NOT_IN_HAND', 'FORCED_PLAY_VIOLATION',
    'TARGET_REQUIRED', 'TARGET_NOT_ALLOWED', 'TARGET_NOT_LEGAL', 'GUESS_REQUIRED',
    'GUESS_NOT_ALLOWED', 'GUESS_CANNOT_BE_INFORMANT'
];

it('has designed copy for every protocol error code', () => {
    for (const code of ALL_CODES) {
        const copy = failureCopy(code);
        expect(copy.message.length, code).toBeGreaterThan(0);
        expect(copy.message, code).not.toMatch(/error|failed/i); // designed copy, not a status dump
    }
});

it('never claims to know which of a wrong link or an expired room occurred', () => {
    expect(failureCopy('ROOM_NOT_FOUND').message).toBe('That court has dissolved — the link may be old or mistyped.');
});

it('offers a takeover action for SEAT_TAKEN and a menu return for the rest', () => {
    expect(failureCopy('SEAT_TAKEN').action).toEqual({ kind: 'takeover', label: 'Take over here' });
    expect(failureCopy('ROOM_FULL').action).toEqual({ kind: 'menu', label: 'Back to menu' });
});
```

The exhaustiveness test above lists codes by hand, which drifts. Guard it: add a second test asserting that the copy map's key count equals `ALL_CODES.length`, and a `satisfies Record<ErrorCode, FailureCopy>` annotation on the map so a **new** protocol code becomes a compile error.

**Step 2: Test `fatalScreen`** — full-screen, `role="alertdialog"`, focus moves to it on mount, and the action button emits the right intent.

**Step 3: Implement. Step 4: Commit.**

```bash
but commit uix-client -m "feat(client): menu, join, lobby, and every designed failure surface" --changes <ids>
```

---

### Task 25: The action sheet

**Files:**
- Create: `src/client/ui/actionSheet.ts`, `src/client/ui/actionSheet.test.ts`

*UIX §7.2* — the densest single surface in the design, and the one where the "show ineligible with reason" rule earns its keep.

**Step 1: Test first**

```ts
it('renders every opponent as a button, ineligible ones disabled with a reason', () => {
    const sheet = openSheetFor('informant', {
        targets: [
            { playerId: 'p2', nickname: 'Ana', eligible: true },
            { playerId: 'p3', nickname: 'Toran', eligible: false, reason: 'protected' },
            { playerId: 'p4', nickname: 'Bayta', eligible: false, reason: 'eliminated' }
        ]
    });
    const buttons = sheet.querySelectorAll('[data-target]');
    expect(buttons).toHaveLength(3); // hiding them would hide the rules
    const toran = sheet.querySelector('[data-target="p3"]') as HTMLButtonElement;
    expect(toran.disabled).toBe(true);
    const describedBy = toran.getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)!.textContent).toContain('protected');
});

it('offers exactly seven guess values, 2 through 8', () => {
    const sheet = openSheetFor('informant', { /* … */ });
    const values = [...sheet.querySelectorAll('[data-guess]')].map(b => Number(b.getAttribute('data-guess')));
    expect(values).toEqual([2, 3, 4, 5, 6, 7, 8]); // 1 is a rule, not a missing option
});

it('expands a guess value to the characters it covers', () => {
    const sheet = openSheetFor('informant', { /* … */ });
    (sheet.querySelector('[data-guess="5"]') as HTMLButtonElement).click();
    expect(sheet.textContent).toContain('Bayta Darell');
    expect(sheet.textContent).toContain('Toran Darell');
});

it('shows no guess grid for a card that takes no guess', () => {
    expect(openSheetFor('mayor-indbur', { /* … */ }).querySelector('[data-guess]')).toBeNull();
});

it('replaces the target section with a calm statement when no target is legal', () => {
    const sheet = openSheetFor('informant', { targets: [{ playerId: 'p2', nickname: 'Ana', eligible: false, reason: 'protected' }] });
    expect(sheet.textContent).toContain('This card will be discarded with no effect.');
    expect(sheet.querySelector('[data-role="no-target-error"]')).toBeNull(); // a legal move, not an error
});

it('shows only effect text and Play for a card needing no target', () => {
    for (const id of ['shielded-mind', 'first-speaker', 'mule'] as const) {
        const sheet = openSheetFor(id, { targets: [] });
        expect(sheet.querySelector('[data-role="targets"]')).toBeNull();
        expect(sheet.querySelector('[data-action="play"]')).not.toBeNull();
    }
});

it('states the Mule consequence on its red Play button', () => {
    const play = openSheetFor('mule', { targets: [] }).querySelector('[data-action="play"]')!;
    expect(play.textContent).toBe('Discard The Mule — you are eliminated.');
    expect(play.getAttribute('data-variant')).toBe('danger');
});

it('keeps Play disabled until every required choice is made', () => { /* target then guess, for the Informant */ });

it('anchors to the bottom on a narrow viewport and to the right edge on a wide one', () => {
    expect(openSheetFor('mule', { targets: [], available: { w: 390, h: 844 } }).getAttribute('data-anchor')).toBe('bottom');
    expect(openSheetFor('mule', { targets: [], available: { w: 1440, h: 900 } }).getAttribute('data-anchor')).toBe('right');
});

it('re-evaluates its anchor on the next open rather than caching a device decision', () => { /* open narrow, close, open wide */ });
```

**Step 2: Implement.** The eligibility list is **assembled by the caller** from `view.players` and `view.own.legalPlays` — the sheet renders what it is handed and evaluates no rule. Cancel and Play are pinned to the sheet's bottom edge; every button carries `min-height: var(--tap-min)`.

**Step 3: Commit.**

---

### Task 26: Quick reference and seat dossier

**Files:**
- Create: `src/client/ui/quickReference.ts`, `src/client/ui/seatDossier.ts` and their tests

**Step 1: Test first**

- The quick-reference tab is present on **every** screen that shows the table, including another player's turn (*UIX §10*).
- The modal renders eight rows, 8 → 1, each with its count.
- It layers above an open action sheet (assert the `z-index` custom property ordering, or that the modal is the last child of the root — whichever the implementation uses, assert the one that is true).
- Escape closes it and returns focus to the tab.
- The dossier lists a seat's discards in play order with names and the running total, plus token count and status.
- The dossier's second tab shows the full match log, newest last.
- The dossier never shows a held card for a living player — feed it a seat with a card in hand and assert no card name from `view.own.hand` appears.

**Step 2: Implement. Step 3: Commit.**

---

### Task 27: Overlays — round over, match over, paused

**Files:**
- Create: `src/client/ui/overlays.ts`, `src/client/ui/overlays.test.ts`
- Create: `src/client/content/countdown.ts`, `src/client/content/countdown.test.ts`

**Step 1: Test the countdown first.** *UIX §9.1* and interface rule 5 — the server owns every clock:

```ts
it('renders seconds remaining from revealDeadline against the server clock', () => {
    const snapshot = { revealDeadline: 10_000, serverTime: 5_000, receivedAt: 1_000 } as const;
    expect(secondsRemaining(snapshot, 1_000)).toBe(5);   // no local drift yet
    expect(secondsRemaining(snapshot, 3_000)).toBe(3);   // 2s of local elapsed time
});

it('never returns a negative countdown', () => {
    expect(secondsRemaining({ revealDeadline: 10_000, serverTime: 5_000, receivedAt: 1_000 }, 99_000)).toBe(0);
});

it('returns null when no deadline is present', () => {
    expect(secondsRemaining({ serverTime: 5_000, receivedAt: 1_000 }, 1_000)).toBeNull();
});

it('shows a full five seconds again after a reconnect restarts the window', () => {
    // The transport never resumes a partial window (UIX §9.1), so a fresh
    // snapshot with a later deadline simply reads as five.
    expect(secondsRemaining({ revealDeadline: 20_000, serverTime: 15_000, receivedAt: 2_000 }, 2_000)).toBe(5);
});
```

**Step 2: Test the overlays**

- Round over: the reason line reads "Deck ran out — highest card wins." for `deck-out` and names the survivor for `last-survivor`.
- Round over renders revealed hands from `roundResult.revealedHands` only, and renders nothing for a `null` entry (the empty-hand edge case).
- A round that also wins the match renders **no** round-over overlay (*UIX §9.1*).
- Match over states `tokensToWin` and the final tallies; the `abandoned` variant renders one line and no celebration chrome.
- Paused names the missing seat and states that the match resumes automatically.
- Paused shows **End match** for the host always, and for other seats only once a seat has been missing past `activeGraceMs` — **2 minutes**, not the 10-minute figure in `VISUAL_SHOWCASE.md` (*UIX §9.3*; the value lives in `src/server/config.ts:16`). Test both sides of the boundary.
- Every overlay has `role="dialog"`, an accessible name, and returns focus on close.

**Step 3: Implement. Step 4: Commit.**

```bash
but commit uix-client -m "feat(client): action sheet, quick reference, dossier, and overlays" --changes <ids>
```

---

## Stage 6: The Court scene

**Goal:** Replace the starter scenes with one gameplay scene that renders `LayoutSpec` output and spends the cinematic budget exactly where the design puts it.
**Success criteria:** `bun run build` succeeds; a real match is playable start to finish in a browser; reduced motion collapses every beat.
**Status:** Tasks 28 and 29 Complete. Task 30 half done — the policy is written and tested, the beats are not implemented.

> **What is left, and why it stopped here.** `motionPlan` (Step 1) is done: the
> reduced-motion decision, the staging order, and the cinematic budget are all
> pure and tested. What remains is Steps 2–4 — `beats.ts` itself, the shader-map
> assignments, and the peek reveal.
>
> That work is deliberately not attempted, for two reasons that compound:
>
> 1. **It is the one part of this project most likely to be wrong from memory.**
>    Phaser 4 replaced FX with Filters and pipelines with render nodes; the
>    project's own guidance says a recalled v3 idiom "will not compile", and the
>    displacement ripple and the victory particles are exactly where that bites.
>    Doing it properly means loading `/tweens`, `/filters-and-postfx` and
>    `/particles` first, as Task 30 instructs.
> 2. **None of it can be verified here.** No browser automation is available in
>    this environment, so animation code could be compiled but never *seen*.
>    `bun run build` would catch a non-existent API; it would not catch a ripple
>    that plays over the wrong element or a beat that never resolves its promise
>    — and a beat that never resolves deadlocks the presentation queue, which is
>    a silent failure of interface rule 8.
>
> **The seam is clean.** `beats.ts` has one job: turn a `MotionPlan` into a
> `Promise<void>` per step, which the presentation queue already awaits. Nothing
> else needs to change to accept it.
>
> Also unverified for the same reason: the success criterion "a real match is
> playable start to finish in a browser". What *was* verified is narrower and
> stated as such in commit `kst` — the server serves the shell at both routes,
> `POST /api/rooms` returns a usable `joinUrl`, and the bundle, fonts and
> portraits all return 200.

### Task 28: Scene chain replacement

**Files:**
- Delete: `src/game/scenes/MainMenu.ts`, `src/game/scenes/Game.ts`, `src/game/scenes/GameOver.ts`
- Modify: `src/game/main.ts`, `src/game/scenes/Boot.ts`, `src/game/scenes/Preloader.ts`
- Create: `src/game/scenes/Court.ts`
- Modify: `src/main.ts`

**REQUIRED SUB-SKILLS:** invoke `/scenes` and `/game-setup-and-config` before writing this task's code, and `/scale-and-responsive` before touching the scale config. This project is Phaser **4**; recalled Phaser 3 idioms will be wrong. If adapting anything found online, invoke `/v3-to-v4-migration` first.

**Step 1: Rewrite the game config** (*UIX §2.2*, §2.5):

```ts
const config: Phaser.Types.Core.GameConfig = {
    type: AUTO,
    parent: 'game-container',
    backgroundColor: '#000000',
    scale: {
        mode: Phaser.Scale.RESIZE,   // the canvas fills the viewport 1:1 — no design resolution
        autoCenter: Phaser.Scale.NO_CENTER
    },
    scene: [Boot, Preloader, Court]
};
```

**Step 2: Delete the three starter scenes** and their imports. `bunx tsc --noEmit` is the check: `noUnusedLocals` catches a stranded import immediately.

**Step 3: Load the real assets in `Preloader`** — for each of the eleven `CARD_CATALOG` entries, `this.load.image(portraitKeyFor(id), \`${assetSlug}/portrait_0.png\`)`; plus the chosen card front and back, the playfield background, the devotion token, and the three shader maps. Derive the loop from `CARD_CATALOG` so a card can never be forgotten. Invoke `/loading-assets` first.

**Step 4: Gate on fonts** (*UIX §2.4*) — no Phaser text may be created before `document.fonts.ready` resolves, or canvas text renders in a fallback and never re-renders:

```ts
async create() {
    await document.fonts.ready;
    this.scene.start('Court');
}
```

**Step 5: Wire `src/main.ts`** to build the store, socket, DOM root, and Phaser game in that order, and to register the single `renderView` subscriber.

**Step 6: Verify by hand**

```bash
bun run build && bun run serve
```

Open `http://localhost:3000/`, click Host, and confirm the lobby renders over a black canvas with no console errors.

**Step 7: Commit.**

---

### Task 29: The single reconciler

**Files:**
- Modify: `src/game/scenes/Court.ts`
- Create: `src/client/layout/renderPlan.ts`, `src/client/layout/renderPlan.test.ts`

Interface rule 6: `STATE_UPDATE` and resize share one path. The scene stays thin because the *decisions* live in a pure `buildRenderPlan(snapshot, spec)` that Vitest tests without Phaser.

**Step 1: Test `buildRenderPlan` first**

```ts
it('marks the current player and no one else', () => { /* exactly one seat has state 'current' */ });
it('marks a protected seat with its caption', () => { /* 'Protected — cannot be targeted' */ });
it('reveals an eliminated seat\'s held card atop their discard pile', () => { /* UIX §6.3 */ });
it('marks a missing seat disconnected without removing their cards', () => { /* seat is held */ });
it('colours the deck purple, orange at 3 or fewer, dark red at empty', () => {
    expect(buildRenderPlan(withDeck(11), spec).deck.colour).toBe(TOKENS.colorDeckFull);
    expect(buildRenderPlan(withDeck(3), spec).deck.colour).toBe(TOKENS.colorDeckLow);
    expect(buildRenderPlan(withDeck(0), spec).deck.colour).toBe(TOKENS.colorDeckEmpty);
});
it('dims a hand card that is not in legalPlays and captions the forced play', () => {
    const plan = buildRenderPlan(holding(['first-speaker#0', 'mayor-indbur#0'], { legalPlays: ['first-speaker#0'] }), spec);
    expect(plan.hand[1].dimmed).toBe(true);
    expect(plan.hand[1].caption).toBe('must play The First Speaker');
    // the client computed no rule — legalPlays said so
});
it('never marks a card playable off-turn', () => { /* legalPlays is empty when it is not your turn */ });
it('banners your turn, waiting, round over, and paused with the right token colour', () => { /* … */ });
```

**Step 2: Implement `buildRenderPlan`, then have `Court.renderView` walk it** — create or update one game object per plan entry, destroying orphans. Invoke `/sprites-and-images`, `/groups-and-containers`, and `/text-and-bitmaptext` before writing that code.

**Step 3: Debounce resize** (*UIX §2.1*) — ~100 ms, and skipped entirely while a DOM text input has focus, which is what survives iOS Safari's keyboard resize storms:

```ts
// A focused input means the viewport is mid-keyboard-animation. Re-laying out the
// table there costs a frame and gains nothing the next real resize will not.
if (document.activeElement?.matches('input, textarea')) return;
```

**Step 4: Commit.**

---

### Task 30: Cinematic beats

**Files:**
- Modify: `src/game/scenes/Court.ts`
- Create: `src/game/scenes/beats.ts`
- Create: `src/client/store/motion.ts`, `src/client/store/motion.test.ts`

**REQUIRED SUB-SKILLS:** `/tweens` before any animation, `/filters-and-postfx` before the grayscale and displacement effects (Phaser 4 replaced FX with Filters — a v3 idiom will not compile), `/particles` before the victory burst.

**Step 1: Test the motion policy first** — the reduced-motion decision is pure and belongs outside the scene:

```ts
it('collapses every beat to a fade under prefers-reduced-motion', () => {
    const plan = motionPlan({ beat: 'mule', reducedMotion: true });
    expect(plan.steps.map(s => s.kind)).toEqual(['fade']);
});

it('leaves countdowns and pips untouched by reduced motion', () => {
    expect(motionPlan({ beat: 'countdown-tick', reducedMotion: true }).steps).toEqual(
        motionPlan({ beat: 'countdown-tick', reducedMotion: false }).steps
    );
});

it('stages an elimination banner, then desaturation, then the card flip', () => {
    expect(motionPlan({ beat: 'elimination', reducedMotion: false }).steps.map(s => s.kind))
        .toEqual(['banner', 'desaturate', 'flip']); // the flip is the information, so it lands last and biggest
});

it('gives the Mule the ripple and the loom before the elimination sequence', () => {
    expect(motionPlan({ beat: 'mule', reducedMotion: false }).steps.map(s => s.kind))
        .toEqual(['ripple', 'loom', 'banner', 'desaturate', 'flip']);
});

it('treats a voluntary and a forced Mule discard identically', () => {
    expect(motionPlan({ beat: 'mule', cause: 'mule-voluntary', reducedMotion: false }))
        .toEqual(motionPlan({ beat: 'mule', cause: 'mule-forced', reducedMotion: false }));
});
```

**Step 2: Implement the beats** in `beats.ts`, each returning a `Promise<void>` that the presentation queue awaits — that is how *UIX §8.4*'s sequencing rule becomes real rather than aspirational. Durations from *UIX §8*: elimination ≈ 1 s (200 ms banner, 500 ms desaturate, then the flip); Mule ripple + 1.2 s loom; everything else ≤ 300 ms.

**Step 3: Assign the shader maps** per *UIX §8.5* — `distortion_map.png` to the Mule displacement, `sparkle_pattern.png` to the match-victory particles, `rainbow_gradient.png` to the devotion-token shimmer.

**Step 4: Wire private peeks** (*UIX §8.1*) — a `peek-gained` diff event shows the card large with "Only you see this", then leaves a small known-card marker on that seat chip; a `peek-lost` event fades it. The engine owns validity (`src/game/engine/view.ts:62-69` re-checks every peek on every call); the UI only mirrors `revealed[]`.

**Step 5: Commit.**

```bash
but commit uix-client -m "feat(client): the Court scene, its reconciler, and the cinematic beats" --changes <ids>
```

---

## Stage 7: Accessibility gate, assets, docs

**Goal:** Make accessibility a regression test rather than a hope; produce the assets the design lists; leave the repo's guidance true.
**Success criteria:** axe-core runs inside `bun run test` and is clean; fonts and icons ship; `AGENTS.md` describes the scene chain that actually exists.
**Status:** Tasks 31, 32 and 33 Complete. Task 34 written; **the device run is the only thing left in the whole plan.**

> **Task 33 is done now.** It was split deliberately: the truth-ups that were
> true before Stage 6 landed first, and the scene-chain rewrite waited until the
> chain had actually changed, because describing scenes that did not exist would
> have been worse than describing the starter ones that did. Both halves are in.
>
> **Task 34 needs hardware and a person.** The checklist at
> `docs/plans/2026-07-24-uix-qa-checklist.md` is written in full and every box is
> unchecked. It cannot be run from here: devtools emulation does not reproduce
> Safari's viewport behaviour, and nothing emulates VoiceOver or TalkBack
> gestures. *UIX §13.2* and §13.3 name both as sign-off conditions precisely
> because a test suite cannot assert them.
>
> Two lines on it now carry more weight than when it was written, because the
> bugs they describe have since actually happened in this build:
>
> - *"a tap on the action sheet never reaches the canvas beneath"* — this failed,
>   twice, for two unrelated reasons (a z-index collision and Phaser's
>   `windowEvents`). Both are fixed and neither produced a console error.
> - *"the toast region announces each play once, and never before its animation"*
>   — half of this is unverifiable until `beats.ts` exists, since there is no
>   animation to be early to yet.

### Task 31: The offscreen twin and the axe-core gate

**Files:**
- Create: `src/client/ui/a11yTwin.ts`, `src/client/ui/a11yTwin.test.ts`
- Create: `src/client/__tests__/axe.test.ts`

**Step 1: Install axe-core**

```bash
bun add -d axe-core
```

**Step 2: Test the twin first** (*UIX §11*)

- One list item per seat, re-rendered on each snapshot, naming nickname, token count, status, and discard total.
- Focusable proxies for the viewer's 1–2 hand cards, positioned from the same `LayoutSpec` that placed the canvas cards.
- These are the **only** shadow elements — assert the twin's element count equals `seats + handCards` exactly, so nobody quietly grows a parallel DOM table.
- The twin is visually hidden but not `aria-hidden`, and not `display: none` (which would remove it from the accessibility tree entirely).

**Step 3: Write the axe gate**

```ts
// @vitest-environment jsdom
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';

/** Every DOM surface, mounted in a representative state. */
const SURFACES = [
    ['menu', mountMenu], ['join', mountJoin], ['lobby', mountLobby],
    ['action sheet', mountActionSheet], ['quick reference', mountQuickReference],
    ['seat dossier', mountDossier], ['round over', mountRoundOver],
    ['match over', mountMatchOver], ['paused', mountPaused], ['fatal', mountFatal]
] as const;

describe.each(SURFACES)('%s is accessible', (_name, mount) => {
    it('reports no axe violations', async () => {
        document.body.innerHTML = '';
        mount(document.body);
        const results = await axe.run(document.body, {
            // jsdom has no layout, so these rules cannot evaluate. Contrast is
            // covered arithmetically instead — src/client/tokens/contrast.test.ts.
            rules: { 'color-contrast': { enabled: false } }
        });
        expect(results.violations.map(v => `${v.id}: ${v.nodes.length} node(s)`)).toEqual([]);
    });
});
```

Mapping the violation array to strings before asserting is deliberate: a raw axe violation object prints as an unreadable wall, and this way a failure names the rule immediately.

**Step 4: Fix whatever axe finds** — do not disable a rule to get green. The only pre-disabled rule is `color-contrast`, and only because jsdom cannot evaluate it.

**Step 5: Commit.**

---

### Task 32: Fonts, portraits, icons, and card faces

**Files:**
- Create: `public/fonts/exo2-600.woff2`, `public/fonts/inter-400.woff2`, `public/fonts/inter-600.woff2`
- Create: `src/client/styles/fonts.css`
- Create: `src/client/content/portraits.ts`, `src/client/content/portraits.test.ts`
- Create: `src/client/ui/icons.ts`

**Step 1: Vendor the fonts.** Download the OFL woff2 files for **Exo 2** (600) and **Inter** (400, 600) into `public/fonts/`, and declare them with `font-display: swap` and explicit `@font-face` `src` entries. Self-hosted, never a CDN link — an offline dev server must render correctly, and a third-party font request is a third-party dependency in a game that has none.

**Step 2: Write the portrait manifest with a test first**

```ts
it('names one portrait variant for every character', () => {
    for (const id of Object.keys(CARD_CATALOG) as CardTypeId[]) {
        expect(PORTRAIT_CHOICE[id]).toMatch(/^portrait_[0-3]$/);
    }
});

it('resolves to a path under the character\'s own asset directory', () => {
    expect(portraitPath('magnifico')).toBe('magnifico/portrait_0.png');
});
```

Default every entry to `portrait_0` with this comment, so implementation is never blocked on a taste decision:

```ts
/**
 * The curation pass (UIX §12) is the project owner's aesthetic call. Until it
 * runs, every character uses portrait_0 (the base variant). Changing a choice is
 * a one-line edit here; nothing else in the client names a variant.
 */
```

**Step 3: Pick the card faces** — `card_front_3.png` (512×720; portraits drop in at exactly 1:1, no crop window needed) and one of `card_back_2`/`card_back_3` (both already 768×1024 card aspect; `card_back_1` is square and would need a crop). Record the choice in `portraits.ts` beside the portrait manifest.

**Step 4: Write `icons.ts`** — inline SVG strings for shield, skull, hourglass, crown, and eye/token, retiring the emoji placeholders. Each carries `aria-hidden="true"` and `focusable="false"`; the meaning lives in adjacent text, never in the glyph.

**Step 5: Check the background** — `playfield_background_space.png` is 512×720. Cover-scale it to 1920×1080 in a browser and look at it. If it visibly softens, note in `docs/plans/` that a larger seamless version is needed and proceed with the existing file; do not block on art.

**Step 6: Commit.**

---

### Task 33: Documentation truth-up

**Files:**
- Modify: `AGENTS.md`
- Modify: `VISUAL_SHOWCASE.md`
- Modify: `docs/plans/2026-07-23-uix-design.md`

**Step 1: Update `AGENTS.md`.** Two statements are now false:
- The status paragraph ("everything under `src/game/scenes/` is still the unmodified Phaser starter") — rewrite it to describe the built client.
- The scene-flow section's five-scene chain — replace with `Boot → Preloader → Court`, and record *why* the three starter scenes went away (menu and game-over are DOM surfaces; *UIX §2.5*). This closes the design's own follow-up 5.

Add `src/client/` to the architecture section, with its four pure directories and the DOM layer named.

**Step 2: Prune `VISUAL_SHOWCASE.md`.** Its interaction design now lives in the UIX design doc and its layout metrics are superseded. Cut the fixed-1024×768 layout section and the stale 10-minute paused figure; keep the art-asset catalogue, which is still the only index of what is in `public/assets/misc/`.

**Step 3: Close the design's open questions.** In *UIX §13*, mark items 1 (host nickname — done, Task 8) and 5 (AGENTS.md — done, this task) as resolved with the task numbers, leaving 2, 3, and 4 open for Task 34.

**Step 4: Commit.**

---

### Task 34: Real-device and screen-reader pass

**Files:**
- Create: `docs/plans/2026-07-24-uix-qa-checklist.md`

The design names these as sign-off conditions (*UIX §13.2*, §13.3), and neither is something a test suite can assert. Write the checklist, then run it.

**Step 1: Write the checklist**, one line per check, each with a pass/fail box:

*iOS Safari* — keyboard opens on the nickname field without breaking layout; the resize debounce survives the toolbar collapse; `viewport-fit=cover` plus safe-area insets keep the action dock above the home indicator; portrait ↔ landscape rotation rebuilds the table through `renderView` with no orphaned objects; `devicePixelRatio` text is crisp, not blurry.

*Android Chrome* — the same, plus back-button behaviour on `/join/:matchId`.

*Both* — the DOM/canvas touch seam: a tap on the action sheet never reaches the canvas beneath, and a tap on a seat chip never falls through to a DOM element.

*VoiceOver and TalkBack* — swipe order through the lobby is sensible; a disabled target button announces its reason; the toast region announces each play once, and never before its animation; the quick reference is reachable and readable during another player's turn; overlays trap focus and return it on close.

**Step 2: Run it on real hardware.** Devtools emulation does not reproduce Safari's viewport behaviour — this step needs a physical device.

**Step 3: Record results in the checklist, fix what fails, and commit.**

```bash
but commit uix-client -m "docs: QA checklist, AGENTS.md scene chain, and design follow-up closure" --changes <ids>
```

---

## Final verification

Before declaring the client done, run the whole gate and read the output — do not infer success from an absent error:

```bash
bun run test        # engine (Vitest) + client (Vitest) + server (bun test)
bunx tsc --noEmit   # the only type check; neither Vite nor the dev server type-checks
bun run build       # the production bundle
```

Then play a real match: two browsers, one hosting and one joining through the copied link, through a round win and a match win, with one browser force-closed mid-round to exercise pause and reconnection.

**Definition of done**

- [ ] All three commands above pass, with output read rather than assumed
- [ ] axe-core reports zero violations across all ten DOM surfaces
- [ ] The QA checklist is filled in on real hardware
- [ ] Every interface rule in *UIX §14* holds; rules 4 and 7 in particular — no other player's hand outside `revealed[]` and `roundResult.revealedHands`, and no truncated discard value at any viewport size
- [ ] `AGENTS.md` describes the client that exists
- [ ] No TODO without an issue number

---

## Deferred: work agreed but deliberately not done here

These are scoped and decided, but sequenced **after** the client ships. They are
recorded with their evidence so the next session does not have to rediscover it.

### D1: A closed `SeatId` union in the protocol layer

**Status:** Deferred by decision, 2026-07-26. Do after Stage 7.
**Scope:** `src/server/protocol.ts`, `src/server/room.ts` (seat construction), and
whichever client boundaries consume seat ids.

The four-seat rule is real and already enforced at runtime, but it is thrown away
at the type level:

```ts
const TARGET_RE = /^p[1-4]$/;
function isTarget(value: unknown): value is PlayerId { … }   // PlayerId = string
```

That guard narrows `unknown` to `string`. It validates the rule and then discards
what it learned. Likewise `room.ts:85` builds `playerId: \`p${index + 1}\``, which
infers as `` `p${number}` `` — nothing in the type system stops a `p5`.

**The change:** add `export type SeatId = 'p1' | 'p2' | 'p3' | 'p4'` to
`protocol.ts`, return `value is SeatId` from `isTarget`, and pin the seat
construction site so it cannot produce an out-of-range id.

**Not a TypeScript `enum`,** which was the shape originally proposed. Three
reasons specific to this repo: `enum` emits a runtime object, while
`engine/types.ts` states "Types only — no runtime code lives here" and requires
everything reachable from `MatchState` to be plain JSON; `isolatedModules: true`
bans the only zero-cost variant, `const enum`; and every other domain type here
is a string-literal union (`CardTypeId`, `EffectType`, `MatchMode`,
`RoundEndReason`, `SeatStatus`), so an enum would be the sole exception. A union
serialises as `"p1"` with no indirection.

**Not applied to the engine's `PlayerId`.** Measured, not assumed: changing
`PlayerId = string` to the union produces **369 tsc errors**. Two findings explain
why that is the wrong layer rather than merely expensive work:

1. `Record<PlayerId, X>` silently changes meaning. As `Record<string, X>` it is an
   index signature; as a 4-member union it demands all four keys, so a
   two-player match fails to typecheck (`Type '{ p0: …; p1: … }' is missing …:
   p2, p3, p4`). Every such record — `RoundState.players`,
   `STATE_UPDATE.nicknames`, `RoundResult.revealedHands` — would become
   `Partial<Record<…>>`, forcing `| undefined` handling across 53 lookup sites.
2. The engine is deliberately seat-agnostic. Its own tests seat players as `p0`,
   `p1`, … (`engine/__tests__/reduce.test.ts:17`) while the transport mints
   `p1`–`p4`; the two coexist precisely because the engine treats `PlayerId` as
   opaque. Narrowing it would couple a reusable headless reducer to the
   transport's four-chair convention.

**Definition of done:** `isTarget` narrows to `SeatId`; seat construction cannot
produce an out-of-range id; `bun run test && bunx tsc --noEmit && bun run build`
all pass; the engine's `PlayerId` is untouched.

### D2: Where the host types a nickname

**Status:** **Decided 2026-07-26 — option (a).** The host names themselves on the
menu, before `POST /api/rooms`. The Stage 3 groundwork has landed; the UI is Task 21.

Task 8 gave `RESUME_SEAT` an optional nickname, but the client flow never asks
the host for one: *UIX §3* routes Host → `POST /api/rooms` → store token →
`/join/:matchId`, and §3's nickname field appears only on the **no stored token**
branch. The host always has a token, so they skip it and `RESUME_SEAT` carries
`nickname: undefined` every time. The transport work is necessary but not
sufficient.

Two candidate fixes, either supported by the server as built:

- **(a)** The menu's *Host a game* reveals a name field before `POST /api/rooms`.
  Host is named from the first frame. Changes Task 21.
- **(b)** `/join/:matchId` shows the nickname step whenever the seat has no
  nickname, token or not. One nickname UI for everyone; the host renders blank
  until they type. Changes Task 22.

**Decision: (a).** Every player types their name into the same field, with the
same validation, before they are seated — the host's field simply lives on the
menu because their seat is minted over HTTP rather than claimed over the socket.
That is name parity, which is what was asked for; screen parity is not available,
because the two seats come into existence by different routes.

(b) was rejected on the round-trip. The client cannot know whether a seat already
has a nickname until it has connected and received `LOBBY_UPDATE`, so a nickname
step gated on "the seat has none" must connect first, send a nameless
`RESUME_SEAT`, render a blank host, and then send a second `RESUME_SEAT` once the
player types. (a) has the name on the first frame and never renders a blank host
at all.

**What this cost, and where it landed (Stage 3):** the host's name is
chosen *before* the room exists and must survive a full page navigation to
`/join/:matchId`, so something has to carry it. `StoredSeat` gained an optional
`nickname`, and it is the only thing that crosses that boundary.

- `seatTokenStore` round-trips `nickname` and validates it on read. Absent is fine
  (seats predate the field); present-but-not-a-string returns `null`, because such
  a value would reach `RESUME_SEAT` and fail the whole frame as `MALFORMED`.
- The store gained a `claimSeat(nickname)` intent, mirroring `playCard`: it sends
  `CLAIM_SEAT` and holds the name so `SEAT_CLAIMED` can persist it. `SEAT_CLAIMED`
  does not echo the nickname and only this browser knows what it asked for, so
  without that the joiner's reconnect would resume a seat it could no longer name.
  The name is remembered only once the frame is away, so a refused claim leaves
  nothing to persist against someone else's `SEAT_CLAIMED`.
- `socket.ts`'s `sendableNickname` already holds to `parseNickname`'s rules exactly,
  so an over-length or control-bearing name is dropped rather than costing the seat.

**Task 21 changes.** *Host a game* reveals a labelled nickname field and a submit
button disabled until it validates, reusing Task 22's `validateNickname` — write
that module first, or the two validators drift. The order the existing test pins
becomes `['save', 'navigate']` with the nickname already inside the saved record:

```ts
tokens.save(matchId, { seat: 0, playerId: hostSeat, seatToken: hostSeatToken, nickname });
```

**Task 22 changes.** The join screen shows its nickname field only when there is no
stored seat. A host arriving at `/join/:matchId` has one, already named, and goes
straight to the lobby — which is exactly the `screen: 'joining'` with a non-null
`state.seat` that Stage 3's store already produces at construction.

### D3: `publicBaseUrl` in dev

**Status:** Noted, low priority.

`publicBaseUrl` defaults to `http://localhost:3000`, so a host running
`bun run dev` on :8080 copies an invite link pointing at :3000 — which serves the
app only if `dist/` is current. It is one config value and does not affect
production, but it will be confusing during Stage 5 lobby testing.

### D4: The client is never told when the host's lobby grace expires

**Status:** Open, found building Task 23. Small, well-scoped transport fix.
**Scope:** `src/server/protocol.ts` (`LOBBY_UPDATE`), `src/server/room.ts`
(`broadcastLobbyUpdate`, the reaper), `src/client/store/types.ts`,
`src/client/ui/lobbyScreen.ts`.

*UIX §4*: "If the host stays gone past the lobby grace, every remaining player's
screen offers **Dissolve lobby**." The server enforces exactly that — a non-host
`END_MATCH` is accepted only once `now - hostSeat.disconnectedAt >
lobbyDisconnectGraceMs` (`room.ts:556-560`). **Nothing tells the client when that
moment arrives.**

Two facts combine to close every channel it might have arrived through:

1. **The host seat never reopens** (`room.ts:643`). Seat reopening is what sets
   `seatsReopened` and triggers a `LOBBY_UPDATE` from the reaper (`room.ts:669`),
   so the host's grace expiring produces no broadcast at all.
2. **`LOBBY_UPDATE` carries no timing.** `seats[]` has `status` but no
   `disconnectedAt`, and there is no `canDissolve` field. A client holding a
   `disconnected` host seat cannot tell a two-second drop from a two-minute one.

Deriving it locally is not available either: interface rule 5 gives every clock
to the server, and the client has no timestamp to measure from regardless — it
learns only that the status *is* `disconnected`, never when it became so.

**What Task 23 does meanwhile.** The button appears as soon as the host seat
reads `disconnected`, captioned with the condition rather than a promise: *"The
host has left. Once they have been gone a minute, the court can be dissolved."*
Pressing too early is refused by the server and surfaces as a toast. That is
honest and it works, but it asks the player to guess.

**The change:** add `canDissolve: boolean` to `LOBBY_UPDATE`, computed by the
predicate `endMatch` already applies, and have the reaper broadcast when it flips
— the same shape as Task 8's `RESUME_SEAT` nickname: one optional field, one
existing predicate reused, no new state. The lobby then renders the button
exactly when pressing it will work, and the caption becomes unnecessary.

**The same gap exists in the active phase.** Found again in Task 27. UIX §9.3
gives a paused match an **End match** button to any seat once one has been
missing past `activeGraceMs` (2 minutes), and the server enforces it with the
same predicate. `STATE_UPDATE` carries `missingSeats` but no timestamp for them,
so once more the client can see *that* a seat is gone and never *since when*.
`overlays.ts` therefore takes `canEndMatch()` as an injected predicate and Task
27 tests both sides of it; the wiring is deferred to the same fix.

One field answers both: whatever it is called, it is computed by the predicate
`endMatch` already applies and sent on the message the client already receives —
`LOBBY_UPDATE` for the lobby case, `STATE_UPDATE` for the active one.

**Definition of done:** a non-host client sees no Dissolve button before the
lobby grace and sees one within a sweep interval after it; the same for **End
match** past `activeGraceMs`; `bun run test && bunx tsc --noEmit && bun run
build` all pass; no existing server test changes shape.

### D5: The playfield background needs a larger source

**Status:** Noted in Task 32 Step 5, proceeding with the existing file as instructed.
**Scope:** `public/assets/misc/playfield_background_space.png`.

`playfield_background_space.png` is **512×720** — a portrait image, where the
table it backs is usually landscape. Cover-scaling it to a 1920×1080 desktop
viewport needs `max(1920/512, 1080/720)` = **3.75×**, and a 3.75× upscale of a
512-pixel-wide source will visibly soften. That is arithmetic rather than an
impression, so it did not need the browser check the task describes.

Every other asset in `misc/` and `shaders/` is the same 512×720, which suggests
the whole set came out of one generation pass at a portrait resolution rather
than being sized for their roles.

**Not blocking.** The task says to proceed with the existing file, and the design
calls the background ambient — it sits behind a dimmed table and under DOM
panels, which is the most forgiving possible use of a soft image. Two options
when art time is available, in order of cost:

1. Regenerate at 1920×1080 or larger, seamless, so it also tiles for viewports
   wider than the source.
2. Failing that, lean into it: a deliberate blur plus the nebula gradient the
   palette already defines would read as intent rather than as a stretched PNG.

**Definition of done:** a background that does not soften at 1920×1080, or a
recorded decision that the soft look is intentional.
