/**
 * Every chrome surface, mounted one at a time in a real browser.
 *
 * ## Why this exists
 *
 * `harness.ts` plays real matches, which is the right way to see the table — and
 * it can only photograph what a match happens to walk past. It deals, it
 * screenshots, and it stops. So the round-over overlay had never been captured,
 * and a toast had never been captured at all, because a toast lives for five
 * seconds somewhere in the middle of a turn nobody drove.
 *
 * That is how a value went missing from the showdown list and a whole channel of
 * commentary stayed invisible. Neither gate could see either surface: the jsdom
 * suite has no layout engine, and the match pass photographed a lobby and a
 * freshly dealt table, twice per viewport, and stopped. A capture harness that
 * cannot reach the thing you just changed is a screenshot of the parts that
 * already worked.
 *
 * ## What it is, and what it is not
 *
 * These are the **real** surfaces — the same factories `main.ts` constructs, the
 * same `ui.css`, in a real engine with a real cascade and real text metrics.
 * What is synthetic is only the state pushed into them. That is the trade: a
 * live match cannot be steered to a bystander guess on demand, but a real
 * browser can be asked what that toast measures once it is on screen.
 *
 * It is therefore **not** a substitute for the match capture. A specimen proves
 * a surface draws correctly given a state; only a live match proves the client
 * ever reaches that state. Both, or neither is worth much.
 *
 * ## Adding one
 *
 * Append to `SPECIMENS`. The harness enumerates it over `/visual/gallery.html`
 * and screenshots each at every viewport, so a new entry needs no change there —
 * and any assertion a machine can make about it belongs in `harness.ts`, next to
 * the others.
 *
 * Served by Vite in dev only. It is not an input to the production build, so it
 * never reaches `dist/` and never reaches the binary's embedded manifest.
 */

// Same order as `main.ts`: fonts and tokens first, since `ui.css` reads them.
import '../src/client/styles/fonts.css';
import '../src/client/styles/tokens.css';
import '../src/client/styles/ui.css';
import '../src/client/styles/table.css';

import type { RoundResult } from '../src/game/engine';
import { failureCopy } from '../src/client/content/failureCopy';
import { makeView } from '../src/client/store/__fixtures__/view';
import type { ClientState, TableSnapshot } from '../src/client/store/types';
import { createOverlays } from '../src/client/ui/overlays';
import { REAL_TIMERS } from '../src/client/ui/surface';
import { createToasts } from '../src/client/ui/toasts';

/**
 * Long enough that a screenshot is never a race.
 *
 * The surfaces take their timers injected, so this is the real `setTimeout` with
 * a deadline no run will reach, rather than a stubbed clock — the dismissal path
 * stays exactly the one that ships.
 */
const NEVER_MS = 60 * 60 * 1000;

const BASE_STATE: ClientState = {
    screen: 'menu',
    connection: 'open',
    matchId: 'K7QX2',
    seat: null,
    lobby: null,
    table: null,
    ended: null,
    pendingPlay: null,
    fatal: null,
    notices: []
};

function tableAt(overrides: Partial<TableSnapshot> = {}): TableSnapshot {
    return {
        view: makeView(),
        nicknames: { p1: 'Ana', p2: 'Bayta', p3: 'Toran' },
        phase: 'active',
        paused: false,
        missingSeats: [],
        serverTime: 1_000_000,
        receivedAt: 1_000_000,
        ...overrides
    };
}

interface Specimen {
    /** URL slug and screenshot suffix. */
    readonly name: string;
    /** One sentence, printed by the harness so a run explains itself. */
    readonly about: string;
    readonly mount: (root: HTMLElement) => void;
}

const SPECIMENS: readonly Specimen[] = [
    {
        name: 'toasts',
        about: 'all four announce kinds at once — narration must be clipped, the other three drawn and distinct',
        mount(root) {
            const toasts = createToasts({
                timers: REAL_TIMERS,
                copyFor: code => failureCopy(code).message,
                onDismiss: () => {},
                timeoutMs: NEVER_MS
            });
            toasts.mount(root);

            // Every kind together, deliberately: the failure this specimen
            // exists to expose is two kinds being indistinguishable, and that
            // is only visible when they are on screen at the same moment —
            // which, in a real match, they routinely are.
            toasts.show('Ana played Mayor Indbur.', { kind: 'narration' });
            toasts.show('Ana guessed 3 against Bayta — missed.', { kind: 'table' });
            toasts.show('Ana guessed you held a 3. They were wrong.', { kind: 'personal' });
            toasts.update({ ...BASE_STATE, notices: [{ id: 'n1', code: 'RATE_LIMITED' }] });
        }
    },
    {
        name: 'round-over',
        about: 'the showdown list, which must name each revealed card with its value',
        mount(root) {
            const overlays = createOverlays({
                timers: REAL_TIMERS,
                now: () => 1_000_000,
                isHost: () => true,
                canEndMatch: () => false,
                onEndMatch: () => {},
                onBackToMenu: () => {}
            });
            overlays.mount(root);

            // Deck-out rather than last-survivor: it is the only reason that
            // reveals hands at all, and the revealed list is the point.
            const roundResult: RoundResult = {
                reason: 'deck-out',
                winnerIds: ['p1'],
                revealedHands: { p1: 'mule', p2: 'informant', p3: 'toran-darell' }
            };

            overlays.update({
                ...BASE_STATE,
                screen: 'table',
                table: tableAt({
                    phase: 'round_over',
                    view: makeView({ roundResult, playerCount: 3 })
                })
            });
        }
    }
];

/** Names only, so the harness can enumerate specimens without importing this module. */
declare global {
    interface Window {
        MULES_SPECIMENS?: readonly { name: string; about: string }[];
    }
}

window.MULES_SPECIMENS = SPECIMENS.map(({ name, about }) => ({ name, about }));

const wanted = new URLSearchParams(location.search).get('specimen');
const specimen = SPECIMENS.find(entry => entry.name === wanted);

const root = document.getElementById('ui-root') as HTMLElement;

if (specimen === undefined) {
    // An index, and a real failure signal: a harness asking for a specimen that
    // no longer exists gets an empty page, and an empty page photographs the
    // same as a broken one. Naming the mismatch is what stops that being silent.
    const list = document.createElement('pre');
    list.dataset.role = 'specimen-index';
    list.style.color = '#f5f5f5';
    list.style.padding = '1rem';
    list.textContent =
        wanted === null
            ? `Specimens:\n${SPECIMENS.map(entry => `  ?specimen=${entry.name}  — ${entry.about}`).join('\n')}`
            : `No specimen named "${wanted}". Known: ${SPECIMENS.map(entry => entry.name).join(', ')}`;
    root.appendChild(list);
} else {
    // One per page load rather than a grid. These surfaces anchor themselves to
    // the viewport — the toast strip and the overlay both — so several at once
    // would stack on one another and each would be photographed in a position
    // the app never puts it in.
    document.body.dataset.specimen = specimen.name;
    specimen.mount(root);
}
