// @vitest-environment jsdom
import axe from 'axe-core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CompletedRound, PublicLogEntry } from '../../game/engine';
import type { KeyValueStore } from '../store/seatTokenStore';
import { QUICK_REFERENCE } from '../content/quickReference';
import { makeView } from '../store/__fixtures__/view';
import { loadRealStyles, makeState, makeTable, makeUiRootElement } from './__fixtures__/dom';
import { createReferenceDock } from './referenceDock';

beforeEach(() => {
    loadRealStyles();
});

function memoryStore(seed: Record<string, string> = {}): KeyValueStore {
    const map = new Map(Object.entries(seed));
    return {
        getItem: key => map.get(key) ?? null,
        setItem: (key, value) => void map.set(key, value),
        removeItem: key => void map.delete(key)
    };
}

const LIVE_LOG: PublicLogEntry[] = [
    { kind: 'PLAY', turn: 1, actorId: 'p1', cardId: 'informant' },
    { kind: 'TRADED', turn: 2, actorId: 'p2', targetId: 'p1' }
];

const FINISHED_ROUND: CompletedRound = {
    roundNumber: 1,
    reason: 'last-survivor',
    winnerIds: ['p2'],
    publicLog: [{ kind: 'PLAY', turn: 1, actorId: 'p2', cardId: 'mule' }]
};

function mounted(store: KeyValueStore = memoryStore(), safeTop?: () => number | null) {
    const root = makeUiRootElement();
    const dock = createReferenceDock({ storage: store, ...(safeTop === undefined ? {} : { safeTop }) });
    dock.mount(root);

    const q = <T extends Element>(selector: string) => root.querySelector(selector) as T | null;

    function tableState(overrides: Parameters<typeof makeView>[0] = {}, matchId = 'MATCH-1') {
        return makeState({ screen: 'table', matchId, table: makeTable({ view: makeView(overrides) }) });
    }

    return {
        root,
        dock,
        launcher: () => q<HTMLButtonElement>('[data-action="reference-dock"]'),
        panel: () => q<HTMLElement>('[data-role="reference-dock"]'),
        body: () => q<HTMLElement>('[data-role="dock-body"]'),
        tabFor: (key: string) => q<HTMLButtonElement>(`[data-dock-tab="${key}"]`),
        rows: () => [...root.querySelectorAll('[data-role="reference-row"]')],
        logSections: () => [...root.querySelectorAll('[data-role="log-section"]')],
        logLines: () => [...root.querySelectorAll('[data-role="log-line"]')],
        show: (overrides: Parameters<typeof makeView>[0] = {}, matchId = 'MATCH-1') =>
            dock.update(tableState(overrides, matchId)),
        tableState
    };
}

const click = (node: Element | null) => (node as HTMLButtonElement).click();

describe('the launcher', () => {
    it('is up whenever the table is, including another player’s turn', () => {
        const ui = mounted();
        ui.show();
        expect(ui.launcher()).not.toBeNull();
    });

    it('is absent away from the table', () => {
        const ui = mounted();
        ui.dock.update(makeState({ screen: 'lobby' }));
        expect(ui.launcher()).toBeNull();
    });

    it('opens the dock and marks itself expanded', () => {
        const ui = mounted();
        ui.show();
        click(ui.launcher());

        expect(ui.panel()).not.toBeNull();
        expect(ui.launcher()!.getAttribute('aria-expanded')).toBe('true');
    });
});

/**
 * The panel already survived a state update; what made it read as temporary was
 * that it declared itself a dialog, stole focus, and bound Escape at the
 * document. Staying visible while playing is those three removed.
 */
describe('staying open while playing', () => {
    it('is not a dialog, because it does not interrupt the game', () => {
        const ui = mounted();
        ui.show();
        click(ui.launcher());

        expect(ui.panel()!.getAttribute('role')).not.toBe('dialog');
        expect(ui.panel()!.getAttribute('role')).toBe('region');
    });

    it('leaves focus where the player left it', () => {
        const ui = mounted();
        ui.show();
        const launcher = ui.launcher()!;
        launcher.focus();
        click(launcher);

        expect(document.activeElement).toBe(launcher);
    });

    it('survives a state update mid-turn', () => {
        const ui = mounted();
        ui.show();
        click(ui.launcher());

        ui.show({ publicLog: LIVE_LOG });

        expect(ui.panel()).not.toBeNull();
    });

    it('does not swallow Escape meant for the action sheet', () => {
        // A document-level handler on a non-modal panel closes it from
        // anywhere, including while the player is cancelling something else.
        const ui = mounted();
        ui.show();
        click(ui.launcher());

        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        expect(ui.panel()).not.toBeNull();
    });

    it('still closes on Escape from inside itself', () => {
        const ui = mounted();
        ui.show();
        click(ui.launcher());

        ui.panel()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        expect(ui.panel()).toBeNull();
    });

    it('closes when the table goes away rather than floating over the lobby', () => {
        const ui = mounted();
        ui.show();
        click(ui.launcher());

        ui.dock.update(makeState({ screen: 'lobby' }));

        expect(ui.panel()).toBeNull();
    });
});

describe('sharing the screen with the action sheet', () => {
    /**
     * The panel used to be `inset: 0` — full bleed, correct for a modal and
     * wrong the instant it stopped being one. On a phone the action sheet
     * anchors to the bottom and the dock outranks it at z-index 5, so a dock
     * that reached the bottom edge would cover Cancel and Play.
     */
    it('does not reach the bottom edge, where the sheet and the hand live', () => {
        const ui = mounted();
        ui.show();
        click(ui.launcher());

        expect(getComputedStyle(ui.panel()!).bottom).toBe('auto');
        expect(getComputedStyle(ui.panel()!).top).toBe('0px');
    });

    it('leaves room for the table beneath it', () => {
        const ui = mounted();
        ui.show();
        click(ui.launcher());

        expect(getComputedStyle(ui.panel()!).maxHeight).not.toBe('none');
    });

    it('gets shorter still while a bottom sheet is open', () => {
        /**
         * Measured on an emulated 390×844 phone with a card raised: the dock ran
         * to 464px and the sheet began at 393px, so the dock's last 71px sat over
         * the sheet's title and its effect line — and the dock wins at z-index 5
         * against the sheet's 3.
         *
         * `data-sheet` is the attribute the sheet already sets for the tab's
         * corner swap, so this costs no measurement and no new coupling.
         */
        const ui = mounted();
        ui.show();
        click(ui.launcher());

        const alone = getComputedStyle(ui.panel()!).maxHeight;
        ui.root.setAttribute('data-sheet', 'bottom');
        const withSheet = getComputedStyle(ui.panel()!).maxHeight;

        expect(withSheet).not.toBe(alone);
        expect(Number.parseFloat(withSheet)).toBeLessThan(Number.parseFloat(alone));
    });

    it('layers above an open action sheet, so it stays readable while composing a play', () => {
        const ui = mounted();
        ui.show();
        click(ui.launcher());

        const sheet = document.createElement('div');
        sheet.className = 'action-sheet';
        ui.root.appendChild(sheet);

        expect(Number(getComputedStyle(ui.panel()!).zIndex)).toBeGreaterThan(
            Number(getComputedStyle(sheet).zIndex)
        );
    });
});

/**
 * A match log grows without limit — every round the match has played, oldest
 * first. With the whole panel scrolling and Close appended last, dismissing the
 * dock meant scrolling to the bottom of the match's entire history first.
 */
describe('Close stays reachable however long the log gets', () => {
    const LONG_HISTORY: CompletedRound[] = Array.from({ length: 12 }, (_, i) => ({
        roundNumber: i + 1,
        reason: 'last-survivor' as const,
        winnerIds: ['p2'],
        publicLog: LIVE_LOG
    }));

    function openedOnLog() {
        const ui = mounted();
        ui.show({ roundHistory: LONG_HISTORY, publicLog: LIVE_LOG });
        click(ui.launcher());
        click(ui.tabFor('log'));
        return ui;
    }

    it('renders a log long enough to need scrolling', () => {
        const ui = openedOnLog();
        expect(ui.logSections().length).toBeGreaterThanOrEqual(12);
    });

    it('keeps Close outside the part that scrolls', () => {
        const ui = openedOnLog();
        const close = ui.root.querySelector('[data-action="close-dock"]')!;
        const body = ui.root.querySelector('[data-role="dock-body"]')!;

        expect(body).not.toBeNull();
        expect(body.contains(close), 'Close scrolls away with the log').toBe(false);
    });

    it('scrolls the body rather than the whole panel', () => {
        const ui = openedOnLog();
        const body = ui.root.querySelector('[data-role="dock-body"]') as HTMLElement;

        expect(getComputedStyle(body).overflowY).toBe('auto');
        // The panel itself must not scroll, or the header goes with the content.
        expect(getComputedStyle(ui.panel()!).overflowY).not.toBe('auto');
    });

    it('keeps the tabs reachable too, so the reference is one press away', () => {
        const ui = openedOnLog();
        const body = ui.root.querySelector('[data-role="dock-body"]')!;
        expect(body.contains(ui.tabFor('reference')!)).toBe(false);
    });

    it('still closes when Close is pressed', () => {
        const ui = openedOnLog();
        (ui.root.querySelector('[data-action="close-dock"]') as HTMLButtonElement).click();
        expect(ui.panel()).toBeNull();
    });
});

describe('remembering how it was left', () => {
    it('reopens on its own across a remount of the same match', () => {
        // The case the persistence is for: a reload mid-game.
        const store = memoryStore();
        const first = mounted(store);
        first.show();
        click(first.launcher());
        first.dock.destroy();

        const second = mounted(store);
        second.show();

        expect(second.panel()).not.toBeNull();
    });

    /**
     * Reported: "when host starts the round, the Reference dialog is open."
     * Keyed globally, a dock left open in any earlier match reopened over a
     * brand-new table — covering the top 55dvh of a hand not yet seen.
     */
    it('starts closed in a match it has never been opened in', () => {
        const store = memoryStore();
        const first = mounted(store);
        first.show({}, 'MATCH-1');
        click(first.launcher());
        expect(first.panel()).not.toBeNull();
        first.dock.destroy();

        const second = mounted(store);
        second.show({}, 'MATCH-2');

        expect(second.panel(), 'a new match inherited the last one’s open dock').toBeNull();
    });

    it('keeps each match’s answer apart', () => {
        const store = memoryStore();
        const a = mounted(store);
        a.show({}, 'MATCH-1');
        click(a.launcher());
        a.dock.destroy();

        const b = mounted(store);
        b.show({}, 'MATCH-2');
        expect(b.panel()).toBeNull();
        b.dock.destroy();

        const backToA = mounted(store);
        backToA.show({}, 'MATCH-1');
        expect(backToA.panel()).not.toBeNull();
    });

    it('stays shut across a remount when it was shut', () => {
        const store = memoryStore();
        const first = mounted(store);
        first.show();
        first.dock.destroy();

        const second = mounted(store);
        second.show();

        expect(second.panel()).toBeNull();
    });

    it('reopens on the tab that was showing', () => {
        // The tab is a taste and travels with the player, unlike being open,
        // which is a fact about one table.
        const store = memoryStore();
        const first = mounted(store);
        first.show();
        click(first.launcher());
        click(first.tabFor('log'));
        first.dock.destroy();

        // A different match, so it starts closed and the tab is the only thing
        // carried over — which is the distinction being asserted.
        const second = mounted(store);
        second.show({}, 'MATCH-2');
        expect(second.panel()).toBeNull();
        click(second.launcher());

        expect(second.tabFor('log')!.getAttribute('aria-selected')).toBe('true');
    });

    it('opens on the reference the first time, with nothing remembered', () => {
        const ui = mounted();
        ui.show();
        click(ui.launcher());

        expect(ui.tabFor('reference')!.getAttribute('aria-selected')).toBe('true');
    });

    it('survives storage that refuses to write, as Safari private mode does', () => {
        const refusing: KeyValueStore = {
            getItem: () => null,
            setItem: () => {
                throw new Error('QuotaExceededError');
            },
            removeItem: () => {}
        };

        const ui = mounted(refusing);
        ui.show();
        expect(() => click(ui.launcher())).not.toThrow();
        expect(ui.panel()).not.toBeNull();
    });
});

describe('the two tabs', () => {
    it('shows the card reference by default, abilities and all', () => {
        const ui = mounted();
        ui.show();
        click(ui.launcher());

        expect(ui.rows()).toHaveLength(QUICK_REFERENCE.length);
        for (const reference of QUICK_REFERENCE) {
            const row = ui.rows().find(node => Number(node.getAttribute('data-value')) === reference.value)!;
            expect(row.textContent, `value ${reference.value}`).toContain(reference.effect);
        }
    });

    it('switches to the match log without closing anything', () => {
        const ui = mounted();
        ui.show({ publicLog: LIVE_LOG });
        click(ui.launcher());
        click(ui.tabFor('log'));

        expect(ui.panel()).not.toBeNull();
        expect(ui.rows()).toHaveLength(0);
        expect(ui.logLines().map(node => node.textContent)).toEqual([
            'Ana played Informant.',
            'Bayta traded hands with Ana.'
        ]);
    });

    it('marks exactly one tab selected', () => {
        const ui = mounted();
        ui.show();
        click(ui.launcher());
        click(ui.tabFor('log'));

        expect(ui.tabFor('log')!.getAttribute('aria-selected')).toBe('true');
        expect(ui.tabFor('reference')!.getAttribute('aria-selected')).toBe('false');
    });
});

/**
 * jsdom has no layout, so these test the WIRING — that a position is carried
 * across the rebuild at all, and that it is not carried where it does not
 * belong. The arithmetic of following lives in `scrollFollow.test.ts`, and the
 * behaviour itself was checked in a real browser.
 */
describe('the match log’s scroll position', () => {
    /** jsdom reports every box as zero-sized; a scroll container needs stating. */
    function scrollable(element: HTMLElement, clientHeight: number, scrollHeight: number): void {
        Object.defineProperty(element, 'clientHeight', { value: clientHeight, configurable: true });
        Object.defineProperty(element, 'scrollHeight', { value: scrollHeight, configurable: true });
    }

    function readingHistory() {
        const ui = mounted();
        ui.show({ roundHistory: [FINISHED_ROUND], publicLog: LIVE_LOG });
        click(ui.launcher());
        click(ui.tabFor('log'));

        const body = ui.body()!;
        scrollable(body, 100, 500);
        body.scrollTop = 120;
        return ui;
    }

    it('holds a reader in place when a new line arrives', () => {
        const ui = readingHistory();

        ui.show({
            roundHistory: [FINISHED_ROUND],
            publicLog: [...LIVE_LOG, { kind: 'PROTECTED', turn: 3, actorId: 'p1' }]
        });

        expect(ui.body()!.scrollTop).toBe(120);
    });

    it('does not carry that position into another tab', () => {
        const ui = readingHistory();

        click(ui.tabFor('reference'));

        // The card reference is not the log, and starting it 120px down would
        // hide its first rows for no reason the player could account for.
        expect(ui.body()!.scrollTop).toBe(0);
    });

    it('forgets the position once the dock is closed and reopened', () => {
        const ui = readingHistory();

        click(ui.panel()!.querySelector('[data-action="close-dock"]'));
        click(ui.launcher());

        // Reopening is a fresh look at the match, which a terminal answers with
        // its newest line — `FOLLOWING`, not the abandoned position.
        expect(ui.body()!.scrollTop).toBe(0);
    });
});

describe('the match log tab', () => {
    it('keeps a finished round, which the engine no longer holds', () => {
        const ui = mounted();
        ui.show({ roundHistory: [FINISHED_ROUND], publicLog: LIVE_LOG });
        click(ui.launcher());
        click(ui.tabFor('log'));

        expect(ui.logSections()).toHaveLength(2);
        expect(ui.logSections()[0].textContent).toContain('Bayta took it');
    });

    it('puts the round in progress last', () => {
        const ui = mounted();
        ui.show({ roundHistory: [FINISHED_ROUND], publicLog: LIVE_LOG });
        click(ui.launcher());
        click(ui.tabFor('log'));

        expect(ui.logSections()[1].textContent).toContain('in progress');
    });

    it('says so plainly when nothing has happened at all', () => {
        const ui = mounted();
        ui.show();
        click(ui.launcher());
        click(ui.tabFor('log'));

        expect(ui.panel()!.textContent).toContain('Nothing has happened yet');
        expect(ui.logSections()).toHaveLength(0);
    });

    it('takes new lines live while it is open', () => {
        const ui = mounted();
        ui.show();
        click(ui.launcher());
        click(ui.tabFor('log'));
        expect(ui.logLines()).toHaveLength(0);

        ui.show({ publicLog: LIVE_LOG });

        expect(ui.logLines()).toHaveLength(2);
    });

    it('renders a hostile nickname as text, never as markup', () => {
        const root = makeUiRootElement();
        const dock = createReferenceDock({ storage: memoryStore() });
        dock.mount(root);
        dock.update(
            makeState({
                screen: 'table',
                table: makeTable({
                    view: makeView({ publicLog: [...LIVE_LOG] }),
                    nicknames: { p1: '<img src=x onerror=alert(1)>', p2: 'Bayta' }
                })
            })
        );
        (root.querySelector('[data-action="reference-dock"]') as HTMLButtonElement).click();
        (root.querySelector('[data-dock-tab="log"]') as HTMLButtonElement).click();

        expect(root.querySelector('img')).toBeNull();
    });
});

describe('opening at one round, the devotion-token route', () => {
    const TWO_ROUNDS: CompletedRound[] = [
        FINISHED_ROUND,
        { roundNumber: 2, reason: 'deck-out', winnerIds: ['p1'], publicLog: [LIVE_LOG[0]] }
    ];

    it('opens the log tab even when the reference was showing', () => {
        const ui = mounted();
        ui.show({ roundHistory: TWO_ROUNDS });
        ui.dock.open('log', { round: 2 });

        expect(ui.tabFor('log')!.getAttribute('aria-selected')).toBe('true');
    });

    it('marks the round asked for, and only that one', () => {
        const ui = mounted();
        ui.show({ roundHistory: TWO_ROUNDS });
        ui.dock.open('log', { round: 2 });

        const focused = ui.logSections().filter(node => node.getAttribute('data-focus') === 'true');
        expect(focused).toHaveLength(1);
        expect(focused[0].getAttribute('data-round')).toBe('2');
    });

    it('lets go of the round on the next state push', () => {
        // Left set, every later push would drag the panel back to an old round
        // while the player was reading a newer one.
        const ui = mounted();
        ui.show({ roundHistory: TWO_ROUNDS });
        ui.dock.open('log', { round: 2 });

        ui.show({ roundHistory: TWO_ROUNDS, publicLog: LIVE_LOG });

        expect(ui.logSections().filter(node => node.getAttribute('data-focus') === 'true')).toHaveLength(0);
    });

    it('opens plainly when no round is named', () => {
        const ui = mounted();
        ui.show({ roundHistory: TWO_ROUNDS });
        ui.dock.open('log');

        expect(ui.panel()).not.toBeNull();
        expect(ui.logSections().filter(node => node.getAttribute('data-focus') === 'true')).toHaveLength(0);
    });

    it('survives a round number that is not in the log', () => {
        const ui = mounted();
        ui.show({ roundHistory: TWO_ROUNDS });
        expect(() => ui.dock.open('log', { round: 99 })).not.toThrow();
        expect(ui.panel()).not.toBeNull();
    });
});

describe('accessibility', () => {
    it('names the region and links each tab to its panel', () => {
        const ui = mounted();
        ui.show();
        click(ui.launcher());

        const labelledBy = ui.panel()!.getAttribute('aria-labelledby')!;
        expect(document.getElementById(labelledBy)!.textContent!.length).toBeGreaterThan(0);
        expect(ui.root.querySelector('[role="tablist"]')).not.toBeNull();
    });

    it('has no axe violations on either tab', async () => {
        const ui = mounted();
        ui.show({ roundHistory: [FINISHED_ROUND], publicLog: LIVE_LOG });
        click(ui.launcher());

        for (const tab of ['reference', 'log']) {
            click(ui.tabFor(tab));
            const results = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
            expect(results.violations.map(v => v.id), `on the ${tab} tab`).toEqual([]);
        }
    });
});

describe('the how-to-play tab', () => {
    const openRules = (ui: ReturnType<typeof mounted>) => {
        click(ui.launcher());
        click(ui.tabFor('rules'));
        return ui.panel()!.textContent ?? '';
    };

    it('offers a third tab beside the card reference and the log', () => {
        const ui = mounted();
        ui.show();
        click(ui.launcher());

        const tabs = [...ui.root.querySelectorAll('[role="tab"]')].map(tab => tab.textContent);
        expect(tabs).toEqual(['Card reference', 'How to play', 'Match log']);
    });

    it('states the devotion-token target for the table being played', () => {
        // The whole point. `tokensToWin` reached the client on every frame and
        // was read only by the match-over overlay, which is after the fact. The
        // fixture is a seven-token table, so a hard-coded four would fail here.
        const ui = mounted();
        ui.show();

        expect(openRules(ui)).toContain('first player to 7 tokens');
    });

    it('follows the table rather than assuming one', () => {
        const ui = mounted();
        ui.show({ tokensToWin: 4, playerCount: 4 });

        const text = openRules(ui);
        expect(text).toContain('first player to 4 tokens');
        expect(text).toContain('nothing is set aside');
    });

    it('explains how a round ends, which no other surface does', () => {
        const ui = mounted();
        ui.show();

        const text = openRules(ui);
        expect(text).toContain('deck runs out');
        expect(text).toContain('discarded values');
    });

    it('remembers the tab across a reopen, like the others', () => {
        const store = memoryStore();
        const first = mounted(store);
        first.show();
        openRules(first);

        // No click here: the dock remembers it was open for this match and
        // reopens itself on the first update. Clicking would close it.
        const second = mounted(store);
        second.show();

        expect(second.tabFor('rules')!.getAttribute('aria-selected')).toBe('true');
    });
});

/**
 * A two-digit turn number is not clipped.
 *
 * The markers are `list-style-position: outside`, which right-aligns them
 * against the text and lines every entry up on the decimal — the behaviour
 * worth keeping. But `outside` paints the marker INSIDE the list's left
 * padding, so that padding is the marker's entire width budget. At a flat
 * `--space-6` (1.5rem) a one-digit "9." fits and "10." does not, and the tens
 * digit was clipped: the log rendered "L0." from turn ten onward.
 *
 * jsdom resolves no lengths, so this cannot measure the clip. What it can do is
 * prove the budget is expressed in `ch` — a unit that tracks the font rather
 * than a pixel guess — and that the rule reaches a real `.reference-modal ol`
 * through the cascade rather than merely existing in the file.
 */
describe('the match log markers', () => {
    function listIn(className: string): HTMLOListElement {
        loadRealStyles();
        const host = document.createElement('div');
        host.className = className;
        const list = document.createElement('ol');
        host.appendChild(list);
        document.body.appendChild(host);
        return list;
    }

    it('budgets the marker in font-relative units, not a fixed pixel gutter', () => {
        const padding = getComputedStyle(listIn('reference-modal')).paddingLeft;

        expect(padding, 'the marker budget must scale with the font, or two digits clip').toContain('ch');
        expect(padding, 'the old rhythm should still win wherever it is larger').toContain('max(');
    });

    it('gives the seat dossier the same budget, since it renders the same log', () => {
        expect(getComputedStyle(listIn('seat-dossier')).paddingLeft).toContain('ch');
    });

    it('uses tabular figures, so the decimal alignment is exact across digit widths', () => {
        expect(getComputedStyle(listIn('reference-modal')).fontVariantNumeric).toBe('tabular-nums');
    });
});

/**
 * Pinned to the full height of a wide viewport, the dock sits on the rightmost
 * seat — so a player has to close it to see who discarded what, which is the
 * flow break these cover.
 *
 * The assertions are on the custom property rather than on `top`, because
 * WHETHER to inset is a media query's decision (only the >=60rem right panel
 * covers anything) and jsdom has no layout engine to resolve one.
 */
describe('clearing the seats', () => {
    it('publishes the clearance the table computed', () => {
        const h = mounted(memoryStore(), () => 240);
        h.dock.update(h.tableState());
        h.dock.open('log');

        expect(h.panel()?.style.getPropertyValue('--dock-safe-top')).toBe('240px');
    });

    it('publishes nothing when there is no table behind it', () => {
        const h = mounted(memoryStore(), () => null);
        h.dock.update(h.tableState());
        h.dock.open('log');

        expect(h.panel()?.style.getPropertyValue('--dock-safe-top')).toBe('');
    });

    it('leaves the panel full height when no clearance is supplied at all', () => {
        const h = mounted();
        h.dock.update(h.tableState());
        h.dock.open('log');

        expect(h.panel()?.style.getPropertyValue('--dock-safe-top')).toBe('');
    });

    it('re-reads on every render, so a resize moves the panel with the seats', () => {
        let clearance = 240;
        const h = mounted(memoryStore(), () => clearance);
        h.dock.update(h.tableState());
        h.dock.open('log');

        clearance = 300;
        h.dock.update(h.tableState());

        expect(h.panel()?.style.getPropertyValue('--dock-safe-top')).toBe('300px');
    });
});
