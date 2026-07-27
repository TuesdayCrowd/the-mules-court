// @vitest-environment jsdom
import axe from 'axe-core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PublicLogEntry, RedactedView } from '../../game/engine';
import { makeView } from '../store/__fixtures__/view';
import type { ViewOverrides } from '../store/__fixtures__/view';
import { loadRealStyles, makeState, makeTable, makeUiRootElement } from './__fixtures__/dom';
import { createSeatDossier } from './seatDossier';

beforeEach(() => {
    loadRealStyles();
});

/** p1 has played Informant then Ebling Mis; p2 has played Mayor Indbur. */
function viewWithDiscards(overrides: ViewOverrides = {}): RedactedView {
    const base = makeView(overrides);
    // `own` is already merged by makeView; re-spreading the partial here would
    // put its optional fields back and undo that.
    const { own: _merged, ...rest } = overrides;
    return {
        ...base,
        players: [
            {
                id: 'p1',
                seat: 0,
                tokens: 2,
                alive: true,
                protected: false,
                discardPile: [
                    { cardId: 'informant', value: 1 },
                    { cardId: 'ebling-mis', value: 3 }
                ],
                discardValueTotal: 4
            },
            {
                id: 'p2',
                seat: 1,
                tokens: 1,
                alive: false,
                protected: false,
                discardPile: [{ cardId: 'mayor-indbur', value: 6 }],
                discardValueTotal: 6
            }
        ],
        ...rest
    };
}

const LOG: PublicLogEntry[] = [
    { kind: 'PLAY', turn: 1, actorId: 'p1', cardId: 'informant' },
    { kind: 'GUESS', turn: 1, actorId: 'p1', targetId: 'p2', guessedValue: 5, hit: false },
    { kind: 'PLAY', turn: 2, actorId: 'p2', cardId: 'mayor-indbur' }
];

function mounted(view: RedactedView = viewWithDiscards()) {
    const root = makeUiRootElement();
    const dossier = createSeatDossier();
    dossier.mount(root);
    dossier.update(makeState({ screen: 'table', table: makeTable({ view }) }));

    const q = <T extends Element>(selector: string) => root.querySelector(selector) as T | null;

    return {
        root,
        dossier,
        panel: () => q<HTMLElement>('[data-role="seat-dossier"]'),
        text: () => q<HTMLElement>('[data-role="seat-dossier"]')?.textContent ?? '',
        tabs: () => [...root.querySelectorAll('[role="tab"]')] as HTMLButtonElement[],
        discards: () => [...root.querySelectorAll('[data-role="discard-entry"]')].map(n => n.textContent ?? ''),
        logLines: () => [...root.querySelectorAll('[data-role="log-line"]')].map(n => n.textContent ?? '')
    };
}

describe('opening a seat', () => {
    it('shows nothing until a seat is opened', () => {
        expect(mounted().panel()).toBeNull();
    });

    it('names the seat it is about', () => {
        const ui = mounted();
        ui.dossier.open('p1');
        expect(ui.text()).toContain('Ana');
    });

    it('lists that seat’s discards in play order, by name', () => {
        const ui = mounted();
        ui.dossier.open('p1');

        expect(ui.discards()).toHaveLength(2);
        expect(ui.discards()[0]).toContain('Informant');
        expect(ui.discards()[1]).toContain('Ebling Mis');
    });

    it('shows each discard’s value alongside its name', () => {
        const ui = mounted();
        ui.dossier.open('p1');
        expect(ui.discards()[1]).toContain('3');
    });

    it('shows the running total the engine keeps', () => {
        const ui = mounted();
        ui.dossier.open('p1');
        expect(ui.text()).toContain('4');
    });

    it('shows the token count', () => {
        const ui = mounted();
        ui.dossier.open('p1');
        expect(ui.text()).toContain('2');
    });

    it('shows a living seat as still in the round', () => {
        const ui = mounted();
        ui.dossier.open('p1');
        expect(ui.text()).toContain('In the round');
    });

    it('shows an eliminated seat as out', () => {
        const ui = mounted();
        ui.dossier.open('p2');
        expect(ui.text()).toContain('Out of the round');
    });

    it('shows a protected seat as protected', () => {
        const view = viewWithDiscards();
        const ui = mounted({
            ...view,
            players: [{ ...view.players[0], protected: true }, view.players[1]]
        });
        ui.dossier.open('p1');
        expect(ui.text()).toContain('Protected');
    });

    it('says so for a seat that has discarded nothing yet', () => {
        const view = viewWithDiscards();
        const ui = mounted({
            ...view,
            players: [{ ...view.players[0], discardPile: [], discardValueTotal: 0 }, view.players[1]]
        });
        ui.dossier.open('p1');
        expect(ui.discards()).toEqual([]);
        expect(ui.text()).toContain('Nothing discarded yet');
    });

    it('ignores a seat that is not in the view', () => {
        const ui = mounted();
        ui.dossier.open('p9');
        expect(ui.panel()).toBeNull();
    });
});

describe('never showing a living player’s hand', () => {
    it('shows no card from the viewer’s own hand that was never discarded', () => {
        // Interface rule 4. The dossier renders discardPile and nothing else, so
        // a held card has no path onto this panel — asserted rather than assumed.
        const ui = mounted(viewWithDiscards({ own: { playerId: 'p1', hand: ['mule#1'], legalPlays: ['mule#1'] } }));
        ui.dossier.open('p1');

        expect(ui.text()).not.toContain('The Mule');
    });

    it('shows no revealed peek, which belongs to the table and not to this panel', () => {
        const ui = mounted(viewWithDiscards({ revealed: [{ subjectId: 'p2', cardTypeId: 'bayta-darell' }] }));
        ui.dossier.open('p2');

        expect(ui.text()).not.toContain('Bayta Darell');
    });
});

describe('the match log tab', () => {
    it('offers two tabs', () => {
        const ui = mounted();
        ui.dossier.open('p1');
        expect(ui.tabs()).toHaveLength(2);
    });

    it('starts on the seat tab', () => {
        const ui = mounted();
        ui.dossier.open('p1');
        expect(ui.tabs()[0].getAttribute('aria-selected')).toBe('true');
        expect(ui.logLines()).toEqual([]);
    });

    it('shows the full match log, newest last', () => {
        const ui = mounted(viewWithDiscards({ publicLog: LOG }));
        ui.dossier.open('p1');
        ui.tabs()[1].click();

        const lines = ui.logLines();
        expect(lines).toHaveLength(3);
        expect(lines[0]).toContain('Ana played Informant');
        expect(lines[2]).toContain('Bayta played Mayor Indbur');
    });

    it('narrates a miss by value and never by character', () => {
        const ui = mounted(viewWithDiscards({ publicLog: LOG }));
        ui.dossier.open('p1');
        ui.tabs()[1].click();

        expect(ui.logLines()[1]).toBe('Ana guessed 5 against Bayta — missed.');
    });

    it('switches back to the seat tab', () => {
        const ui = mounted(viewWithDiscards({ publicLog: LOG }));
        ui.dossier.open('p1');
        ui.tabs()[1].click();
        ui.tabs()[0].click();

        expect(ui.logLines()).toEqual([]);
        expect(ui.discards()).toHaveLength(2);
    });

    it('says so when nothing has happened yet', () => {
        const ui = mounted();
        ui.dossier.open('p1');
        ui.tabs()[1].click();
        expect(ui.text()).toContain('Nothing has happened yet');
    });
});

describe('dismissal', () => {
    it('closes on Escape', () => {
        const ui = mounted();
        ui.dossier.open('p1');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(ui.panel()).toBeNull();
    });

    it('closes on its close button', () => {
        const ui = mounted();
        ui.dossier.open('p1');
        (ui.root.querySelector('[data-action="close-dossier"]') as HTMLButtonElement).click();
        expect(ui.panel()).toBeNull();
    });

    it('closes when the table goes away', () => {
        const ui = mounted();
        ui.dossier.open('p1');
        ui.dossier.update(makeState({ screen: 'lobby' }));
        expect(ui.panel()).toBeNull();
    });

    it('follows the seat as new snapshots arrive', () => {
        const ui = mounted();
        ui.dossier.open('p1');

        const grown = viewWithDiscards();
        ui.dossier.update(
            makeState({
                screen: 'table',
                table: makeTable({
                    view: {
                        ...grown,
                        players: [
                            {
                                ...grown.players[0],
                                discardPile: [...grown.players[0].discardPile, { cardId: 'mule', value: 8 }],
                                discardValueTotal: 12
                            },
                            grown.players[1]
                        ]
                    }
                })
            })
        );

        expect(ui.discards()).toHaveLength(3);
        expect(ui.text()).toContain('12');
    });
});

describe('accessibility', () => {
    it('is a dialog with an accessible name', () => {
        const ui = mounted();
        ui.dossier.open('p1');

        expect(ui.panel()!.getAttribute('role')).toBe('dialog');
        const labelledBy = ui.panel()!.getAttribute('aria-labelledby')!;
        expect(document.getElementById(labelledBy)!.textContent!.length).toBeGreaterThan(0);
    });

    it('has no axe violations', async () => {
        const ui = mounted(viewWithDiscards({ publicLog: LOG }));
        ui.dossier.open('p1');

        const results = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
        expect(results.violations.map(v => v.id)).toEqual([]);
    });
});
