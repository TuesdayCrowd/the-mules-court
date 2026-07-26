/**
 * Shared jsdom scaffolding for the DOM-layer tests.
 *
 * `loadRealStyles` is the important one: the pointer-events discipline lives in
 * `ui.css`, so a test asserting it against a stub stylesheet would prove only
 * that the stub is right. jsdom applies the cascade for the simple selectors
 * this file uses, so the assertions run against the shipped rules.
 */

import { readFileSync } from 'node:fs';
import { makeView } from '../../store/__fixtures__/view';
import type { ClientState, TableSnapshot } from '../../store/types';
import type { Timers } from '../surface';

let styles: string | null = null;

/** Injects the real `tokens.css` and `ui.css` into the document once per test file. */
export function loadRealStyles(): void {
    styles ??= `${readFileSync('src/client/styles/tokens.css', 'utf8')}\n${readFileSync('src/client/styles/ui.css', 'utf8')}`;

    const style = document.createElement('style');
    style.textContent = styles;
    document.head.appendChild(style);
}

/** A fresh `#ui-root`, matching the shell `index.html` ships. */
export function makeUiRootElement(): HTMLElement {
    document.body.innerHTML = '<main id="app"><div id="game-container"></div><div id="ui-root"></div></main>';
    return document.getElementById('ui-root') as HTMLElement;
}

/** Timers that fire only when a test says so. */
export function fakeTimers() {
    let next = 1;
    let pending = new Map<number, { fn: () => void; ms: number }>();

    const timers: Timers = {
        setTimeout(fn, ms) {
            const handle = next++;
            pending.set(handle, { fn, ms });
            return handle;
        },
        clearTimeout(handle) {
            pending.delete(handle as number);
        }
    };

    return {
        timers,
        pendingCount: () => pending.size,
        delays: () => [...pending.values()].map(entry => entry.ms),
        /** Fire everything scheduled so far. */
        run() {
            const due = [...pending.values()];
            pending = new Map();
            for (const entry of due) entry.fn();
        }
    };
}

const BASE_STATE: ClientState = {
    screen: 'menu',
    connection: 'connecting',
    matchId: null,
    seat: null,
    lobby: null,
    table: null,
    ended: null,
    pendingPlay: null,
    fatal: null,
    notices: []
};

export function makeState(overrides: Partial<ClientState> = {}): ClientState {
    return { ...BASE_STATE, ...overrides };
}

/** A `TableSnapshot` around `makeView()`, with the transport fields at rest. */
export function makeTable(overrides: Partial<TableSnapshot> = {}): TableSnapshot {
    return {
        view: makeView(),
        nicknames: { p1: 'Ana', p2: 'Bayta' },
        phase: 'active',
        paused: false,
        missingSeats: [],
        serverTime: 1_000_000,
        receivedAt: 1_000_000,
        ...overrides
    };
}
