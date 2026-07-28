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

function mounted(store: KeyValueStore = memoryStore()) {
    const root = makeUiRootElement();
    const dock = createReferenceDock({ storage: store });
    dock.mount(root);

    const q = <T extends Element>(selector: string) => root.querySelector(selector) as T | null;

    function tableState(overrides: Parameters<typeof makeView>[0] = {}) {
        return makeState({ screen: 'table', table: makeTable({ view: makeView(overrides) }) });
    }

    return {
        root,
        dock,
        launcher: () => q<HTMLButtonElement>('[data-action="reference-dock"]'),
        panel: () => q<HTMLElement>('[data-role="reference-dock"]'),
        tabFor: (key: string) => q<HTMLButtonElement>(`[data-dock-tab="${key}"]`),
        rows: () => [...root.querySelectorAll('[data-role="reference-row"]')],
        logSections: () => [...root.querySelectorAll('[data-role="log-section"]')],
        logLines: () => [...root.querySelectorAll('[data-role="log-line"]')],
        show: (overrides: Parameters<typeof makeView>[0] = {}) => dock.update(tableState(overrides)),
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

describe('remembering how it was left', () => {
    it('reopens on its own across a remount', () => {
        const store = memoryStore();
        const first = mounted(store);
        first.show();
        click(first.launcher());
        first.dock.destroy();

        const second = mounted(store);
        second.show();

        expect(second.panel()).not.toBeNull();
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
        const store = memoryStore();
        const first = mounted(store);
        first.show();
        click(first.launcher());
        click(first.tabFor('log'));
        first.dock.destroy();

        const second = mounted(store);
        second.show();

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
