/**
 * Every surface `main.ts` builds is also put on the screen.
 *
 * ## The bug this exists to catch, because it shipped
 *
 * `createToasts` was constructed with everything it needed — `failureCopy` for
 * the wording, `store.dismissNotice` for the dismissal — and `main.ts` called
 * `toasts.show(...)` from five places, including the entire `aria-live`
 * narration channel. It was never passed to `uiRoot.add`, and `uiRoot.add` is
 * the only thing that calls `mount`. So the region lived its whole life as a
 * detached `<div>`: every narration line, every server refusal, every rate-limit
 * message rendered correctly into nothing.
 *
 * Nothing caught it. `toasts.test.ts` mounts the surface itself and passes;
 * `axe.test.ts` audits surfaces it is handed; no test reads the composition
 * root. The failure is invisible from inside any single unit — it is a wiring
 * fact, and this file is where wiring facts get checked.
 *
 * It surfaced as a player asking why they could not tell what had happened to
 * them without opening the match log. The sentence existed. It had nowhere to go.
 *
 * ## Why source text
 *
 * `main.ts` is the composition root: it reaches for `window`, `WebSocket`,
 * `location` and a real `AudioContext`, so importing it in a test means booting
 * the app. Reading it as text is the same trade `tableContract.test.ts` makes —
 * cheap, and unfoolable for the one question being asked.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(join(import.meta.dirname, '..', '..', 'main.ts'), 'utf8');

/**
 * Surfaces held in a variable, which are the ones that can be forgotten.
 *
 * A surface constructed inline inside `uiRoot.add(...)` cannot be built without
 * being mounted, so it needs no entry here. Add a name when a new surface is
 * assigned to a `const` — that is exactly the shape the toast bug had.
 */
const HELD_IN_A_VARIABLE = ['toasts', 'actionSheet', 'seatDossier', 'referenceDock', 'cardHint', 'eliminationNotice'];

describe('the composition root mounts what it builds', () => {
    it.each(HELD_IN_A_VARIABLE)('mounts %s', name => {
        // Constructed at all — otherwise the assertion below passes vacuously
        // against a name nobody uses any more.
        expect(mainSource).toMatch(new RegExp(`const ${name}\\s*=`));
        expect(mainSource).toMatch(new RegExp(`uiRoot\\.add\\(${name}\\)`));
    });

    it('mounts the table, which has its own container rather than the ui root', () => {
        expect(mainSource).toMatch(/const table\s*=/);
        expect(mainSource).toMatch(/table\.mount\(/);
    });

    /**
     * The narration channel end to end: a line is produced, queued, and handed
     * to a surface that is on the screen. Each half was true on its own while
     * the whole was broken.
     */
    it('routes queued announcements into a mounted region', () => {
        expect(mainSource).toMatch(/createPresentationQueue\(\{[\s\S]*?toasts\.show\(/);
        expect(mainSource).toMatch(/uiRoot\.add\(toasts\)/);
    });
});
