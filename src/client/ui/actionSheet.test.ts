// @vitest-environment jsdom
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import type { CardTypeId } from '../../game/engine';
import { cardCopyFor } from '../content/cardCopy';
import { loadRealStyles, makeState, makeUiRootElement } from './__fixtures__/dom';
import type { SheetRequest, SheetTarget } from './actionSheet';
import { createActionSheet } from './actionSheet';

const PHONE = { w: 390, h: 844 } as const;
const DESKTOP = { w: 1440, h: 900 } as const;

const THREE_TARGETS: SheetTarget[] = [
    { playerId: 'p2', nickname: 'Ana', eligible: true },
    { playerId: 'p3', nickname: 'Toran', eligible: false, reason: 'protected' },
    { playerId: 'p4', nickname: 'Bayta', eligible: false, reason: 'eliminated' }
];

/**
 * For tests about the player making a choice.
 *
 * `THREE_TARGETS` has exactly one eligible seat, which the sheet now pre-selects
 * — so a test that means to exercise choosing has to offer more than one.
 */
const TWO_ELIGIBLE: SheetTarget[] = [
    { playerId: 'p2', nickname: 'Ana', eligible: true },
    { playerId: 'p3', nickname: 'Toran', eligible: true },
    { playerId: 'p4', nickname: 'Bayta', eligible: false, reason: 'eliminated' }
];

function harness(options: { acceptPlay?: boolean } = {}) {
    const root = makeUiRootElement();
    const played: Array<{ cardInstanceId: string; target?: string; guess?: number }> = [];
    const cancelled: number[] = [];

    const sheet = createActionSheet({
        onPlay: choice => {
            played.push(choice);
            return options.acceptPlay ?? true;
        },
        onCancel: () => cancelled.push(1)
    });
    sheet.mount(root);
    // A live table: the socket is up, which is when a sheet is normally opened.
    sheet.update(makeState({ screen: 'table', connection: 'open' }));

    function openSheetFor(
        cardId: CardTypeId,
        options: { targets?: SheetTarget[]; available?: { w: number; h: number }; safeTop?: number } = {}
    ): HTMLElement {
        sheet.open({
            cardId,
            cardInstanceId: `${cardId}#1`,
            targets: options.targets ?? [],
            ...(options.safeTop === undefined ? {} : { safeTop: options.safeTop }),
            available: options.available ?? PHONE
        });
        return root.querySelector('[data-role="action-sheet"]') as HTMLElement;
    }

    return { root, sheet, played, cancelled, openSheetFor };
}

const click = (node: Element | null) => (node as HTMLButtonElement).click();

describe('targets', () => {
    it('renders every opponent as a button, ineligible ones disabled with a reason', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: THREE_TARGETS });

        expect(sheet.querySelectorAll('[data-target]')).toHaveLength(3); // hiding them would hide the rules

        const toran = sheet.querySelector('[data-target="p3"]') as HTMLButtonElement;
        expect(toran.disabled).toBe(true);
        expect(toran.textContent).toContain('Protected');
    });

    it('gives each ineligible target its own reason', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: THREE_TARGETS });

        const bayta = sheet.querySelector('[data-target="p4"]') as HTMLButtonElement;
        expect(bayta.textContent).toContain('Out of the round');
    });

    /**
     * The status belongs to the nametag, not beside it.
     *
     * It used to be a `<span>` appended to the section as the button's SIBLING,
     * which laid out as a loose word adrift in the target grid — nothing tied
     * "eliminated" to the name it described, and with three targets a reader
     * could not tell which one it belonged to.
     */
    it('puts the status inside the button it describes', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: THREE_TARGETS });

        const toran = sheet.querySelector('[data-target="p3"]') as HTMLButtonElement;
        const state = toran.querySelector('[data-role="target-state"]');
        expect(state).not.toBeNull();
        expect(state!.textContent).toBe('Protected');

        // Nothing left loose in the section for a reader to misattribute.
        const targets = sheet.querySelector('[data-role="targets"]')!;
        for (const node of targets.querySelectorAll('[data-role="target-state"]')) {
            expect(node.closest('[data-target]')).not.toBeNull();
        }
    });

    it('names the state as data, so the two read differently at a glance', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: THREE_TARGETS });

        expect((sheet.querySelector('[data-target="p3"]') as HTMLElement).dataset.state).toBe('protected');
        expect((sheet.querySelector('[data-target="p4"]') as HTMLElement).dataset.state).toBe('eliminated');
    });

    it('says what the table says, so one state is not two words', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: THREE_TARGETS });

        // The raw enum used to reach the screen: a player read "eliminated"
        // here and "Out of the round" on the seat chip for the same fact.
        expect(sheet.querySelector('[data-target="p4"]')!.textContent).not.toContain('eliminated');
    });

    /**
     * The section was one `flex-wrap` row holding the heading AND the buttons,
     * so "Choose a target" sat inline with the first name and the rest wrapped
     * around it — a paragraph of controls rather than a list of choices.
     *
     * jsdom has no layout, so what is asserted here is the structure the CSS
     * needs: a heading that is not a sibling of the buttons, and one wrapper
     * that owns the buttons alone. The result was looked at in a browser.
     */
    it('keeps the heading out of the list, so it can hold its own line', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: THREE_TARGETS });

        const list = sheet.querySelector('[data-role="target-list"]')!;
        expect(list).not.toBeNull();
        expect(list.querySelector('h3')).toBeNull();
        expect(sheet.querySelector('[data-role="targets"] > h3')).not.toBeNull();
    });

    it('gathers every target into the one list, eligible or not', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: THREE_TARGETS });

        const list = sheet.querySelector('[data-role="target-list"]')!;
        expect(list.querySelectorAll('[data-target]')).toHaveLength(3);
        // Nothing left outside it for the flex row to reflow around.
        expect(sheet.querySelectorAll('[data-role="targets"] > [data-target]')).toHaveLength(0);
    });

    it('reaches a screen reader by name, since a disabled button is not focusable', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: THREE_TARGETS });

        const bayta = sheet.querySelector('[data-target="p4"]') as HTMLButtonElement;
        expect(bayta.textContent).toContain('Bayta');
        expect(bayta.textContent).toContain('Out of the round');
    });

    it('leaves an eligible target enabled and unexplained', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: THREE_TARGETS });

        const ana = sheet.querySelector('[data-target="p2"]') as HTMLButtonElement;
        expect(ana.disabled).toBe(false);
        expect(ana.getAttribute('aria-describedby')).toBeNull();
    });

    it('names the target rather than only picturing them', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: THREE_TARGETS });
        expect(sheet.querySelector('[data-target="p2"]')!.textContent).toContain('Ana');
    });

    it('renders a hostile nickname as text, never as markup', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', {
            targets: [{ playerId: 'p2', nickname: '<img src=x onerror=alert(1)>', eligible: true }]
        });
        expect(sheet.querySelector('img')).toBeNull();
    });

    it('marks the chosen target as pressed, so the choice is not colour alone', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: THREE_TARGETS });

        click(sheet.querySelector('[data-target="p2"]'));

        expect(sheet.querySelector('[data-target="p2"]')!.getAttribute('aria-pressed')).toBe('true');
    });

    it('keeps focus on the button that was pressed', () => {
        // The sheet updates in place rather than rebuilding. A rebuild would
        // detach the focused button, dropping a keyboard player back at the
        // document root with the sheet still open in front of them.
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: THREE_TARGETS });
        const ana = sheet.querySelector('[data-target="p2"]') as HTMLButtonElement;

        ana.focus();
        ana.click();

        expect(document.activeElement).toBe(ana);
        expect(ana.isConnected).toBe(true);
    });

    it('replaces the target section with a calm statement when no target is legal', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', {
            targets: [{ playerId: 'p2', nickname: 'Ana', eligible: false, reason: 'protected' }]
        });

        expect(sheet.textContent).toContain('This card will be discarded with no effect.');
        expect(sheet.querySelector('[data-role="no-target-error"]')).toBeNull(); // a legal move, not a failure
        expect(sheet.querySelector('[data-target]')).toBeNull();
    });

    it('lets a card with no legal target be played anyway', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', {
            targets: [{ playerId: 'p2', nickname: 'Ana', eligible: false, reason: 'protected' }]
        });

        expect((sheet.querySelector('[data-action="play"]') as HTMLButtonElement).disabled).toBe(false);
        click(sheet.querySelector('[data-action="play"]'));
        expect(h.played).toEqual([{ cardInstanceId: 'informant#1' }]);
    });

    // The reported bug, end to end at the sheet. A Darell with every opponent
    // shielded is NOT a fizzle: "choose any player" includes you. Handed a
    // self target, the sheet must require a choice rather than offering a
    // no-effect discard — and the play must carry the target, because a frame
    // without one is refused with TARGET_REQUIRED and the turn never moves.
    it('requires a choice when the viewer is the only legal target', () => {
        const h = harness();
        const sheet = h.openSheetFor('toran-darell', {
            targets: [
                { playerId: 'p1', nickname: 'Ana (you)', eligible: true },
                { playerId: 'p2', nickname: 'Bayta', eligible: false, reason: 'protected' }
            ]
        });

        expect(sheet.textContent).not.toContain('This card will be discarded with no effect.');

        // Self is the sole eligible seat, so it arrives chosen — but Play is
        // still a press, and the frame still carries the target. A frame without
        // one is refused with TARGET_REQUIRED and the turn never moves.
        expect(sheet.querySelector('[data-target="p1"]')!.getAttribute('aria-pressed')).toBe('true');
        expect(h.played).toEqual([]);

        click(sheet.querySelector('[data-action="play"]'));
        expect(h.played).toEqual([{ cardInstanceId: 'toran-darell#1', target: 'p1' }]);
    });
});

describe('the guess grid', () => {
    it('offers exactly seven guess values, 2 through 8', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: THREE_TARGETS });

        const values = [...sheet.querySelectorAll('[data-guess]')].map(b => Number(b.getAttribute('data-guess')));
        expect(values).toEqual([2, 3, 4, 5, 6, 7, 8]); // 1 is a rule, not a missing option
    });

    it('expands a guess value to the characters it covers', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: THREE_TARGETS });

        click(sheet.querySelector('[data-guess="5"]'));

        expect(sheet.textContent).toContain('Bayta Darell');
        expect(sheet.textContent).toContain('Toran Darell');
    });

    it('shows no guess grid for a card that takes no guess', () => {
        const h = harness();
        expect(h.openSheetFor('mayor-indbur', { targets: THREE_TARGETS }).querySelector('[data-guess]')).toBeNull();
    });

    it('marks the chosen value as pressed', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: THREE_TARGETS });
        click(sheet.querySelector('[data-guess="5"]'));
        expect(sheet.querySelector('[data-guess="5"]')!.getAttribute('aria-pressed')).toBe('true');
    });

    /**
     * The values are a grid of their own, so the heading above and the hint
     * below each get a line and the numbers wrap among themselves. They used to
     * share one `flex-wrap` row with both, which is how "Guess a value" ended up
     * beside the 2 and "Tap a value to see its cards" beside the 8.
     */
    it('holds the values in a grid of their own, without the heading or the hint', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: THREE_TARGETS });

        const grid = sheet.querySelector('[data-role="guesses"]')!;
        expect(grid).not.toBeNull();
        expect(grid.querySelectorAll('[data-guess]')).toHaveLength(7);
        expect(grid.querySelector('h3')).toBeNull();
        expect(grid.querySelector('[data-role="guess-hint"]')).toBeNull();
        expect(grid.children).toHaveLength(7);
    });

    it('keeps the heading and the hint as siblings of the grid, not items in it', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: THREE_TARGETS });

        const section = sheet.querySelector('[data-role="guess"]')!;
        expect(section.querySelector(':scope > h3')).not.toBeNull();
        expect(section.querySelector(':scope > [data-role="guess-hint"]')).not.toBeNull();
    });
});

describe('cards that need nothing', () => {
    it.each(['shielded-mind', 'first-speaker', 'mule'] as const)('shows only effect text and Play for %s', id => {
        const h = harness();
        const sheet = h.openSheetFor(id, { targets: [] });

        expect(sheet.querySelector('[data-role="targets"]')).toBeNull();
        expect(sheet.querySelector('[data-guess]')).toBeNull();
        expect(sheet.querySelector('[data-action="play"]')).not.toBeNull();
        expect(sheet.textContent).toContain(cardCopyFor(id).effect);
    });

    it('names the card it is about', () => {
        const h = harness();
        expect(h.openSheetFor('shielded-mind').textContent).toContain('Shielded Mind');
    });
});

describe('the Mule', () => {
    it('states the consequence on its red Play button', () => {
        const h = harness();
        const play = h.openSheetFor('mule', { targets: [] }).querySelector('[data-action="play"]')!;

        expect(play.textContent).toBe('Discard The Mule — you are eliminated.');
        expect(play.getAttribute('data-variant')).toBe('danger');
    });

    it('gives every other card a plain Play button', () => {
        const h = harness();
        const play = h.openSheetFor('shielded-mind', { targets: [] }).querySelector('[data-action="play"]')!;

        expect(play.textContent).toBe('Play');
        expect(play.getAttribute('data-variant')).toBeNull();
    });
});

describe('Play stays disabled until every choice is made', () => {
    it('needs a target and a guess for the Informant', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: THREE_TARGETS });
        const play = () => sheet.querySelector('[data-action="play"]') as HTMLButtonElement;

        expect(play().disabled).toBe(true);

        click(sheet.querySelector('[data-target="p2"]'));
        expect(play().disabled).toBe(true); // target chosen, guess still missing

        click(sheet.querySelector('[data-guess="5"]'));
        expect(play().disabled).toBe(false);
    });

    it('needs only a target for a card that takes no guess', () => {
        // Two eligible seats, so the choice is genuinely the player's — with one
        // the sheet would pre-select it and Play would start enabled.
        const h = harness();
        const sheet = h.openSheetFor('mayor-indbur', { targets: TWO_ELIGIBLE });
        const play = () => sheet.querySelector('[data-action="play"]') as HTMLButtonElement;

        expect(play().disabled).toBe(true);
        click(sheet.querySelector('[data-target="p2"]'));
        expect(play().disabled).toBe(false);
    });

    it('emits the whole choice on Play', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: THREE_TARGETS });

        click(sheet.querySelector('[data-target="p2"]'));
        click(sheet.querySelector('[data-guess="5"]'));
        click(sheet.querySelector('[data-action="play"]'));

        expect(h.played).toEqual([{ cardInstanceId: 'informant#1', target: 'p2', guess: 5 }]);
    });

    it('emits nothing while a choice is missing', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: THREE_TARGETS });
        click(sheet.querySelector('[data-action="play"]'));
        expect(h.played).toEqual([]);
    });
});

describe('cancelling', () => {
    it('closes the sheet and says so', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: THREE_TARGETS });

        click(sheet.querySelector('[data-action="cancel"]'));

        expect(h.cancelled).toHaveLength(1);
        expect(h.root.querySelector('[data-role="action-sheet"]')).toBeNull();
    });

    it('forgets the choices made, so a reopened sheet starts clean', () => {
        // Two eligible seats, so a chosen target is the player's own and must
        // not survive a cancel. With one, reopening legitimately re-selects it.
        const h = harness();
        let sheet = h.openSheetFor('informant', { targets: TWO_ELIGIBLE });
        click(sheet.querySelector('[data-target="p2"]'));
        click(sheet.querySelector('[data-guess="5"]'));
        click(sheet.querySelector('[data-action="cancel"]'));

        sheet = h.openSheetFor('informant', { targets: TWO_ELIGIBLE });
        expect((sheet.querySelector('[data-action="play"]') as HTMLButtonElement).disabled).toBe(true);
        expect(sheet.querySelector('[data-target="p2"]')!.getAttribute('aria-pressed')).toBe('false');
        expect(sheet.querySelector('[data-guess="5"]')!.getAttribute('aria-pressed')).toBe('false');
    });

    it('closes after a play, so the table is not left under a sheet', () => {
        const h = harness();
        const sheet = h.openSheetFor('shielded-mind', { targets: [] });
        click(sheet.querySelector('[data-action="play"]'));
        expect(h.root.querySelector('[data-role="action-sheet"]')).toBeNull();
    });
});

describe('where it anchors', () => {
    it('anchors to the bottom on a narrow viewport and to the right edge on a wide one', () => {
        const h = harness();
        expect(h.openSheetFor('mule', { targets: [], available: PHONE }).getAttribute('data-anchor')).toBe('bottom');
        h.sheet.close();
        expect(h.openSheetFor('mule', { targets: [], available: DESKTOP }).getAttribute('data-anchor')).toBe('right');
    });

    it('re-evaluates its anchor on the next open rather than caching a device decision', () => {
        const h = harness();
        h.openSheetFor('mule', { targets: [], available: PHONE });
        h.sheet.close();

        // The same session, a rotated or unfolded device: a live geometry test,
        // never a device sniff.
        expect(h.openSheetFor('mule', { targets: [], available: DESKTOP }).getAttribute('data-anchor')).toBe('right');
    });

    it('anchors a rotated phone to the bottom, not the right', () => {
        const h = harness();
        expect(h.openSheetFor('mule', { targets: [], available: { w: 844, h: 390 } }).getAttribute('data-anchor')).toBe(
            'bottom'
        );
    });
});

describe('the sheet as a dialog', () => {
    it('is a dialog with an accessible name', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: THREE_TARGETS });

        expect(sheet.getAttribute('role')).toBe('dialog');
        const labelledBy = sheet.getAttribute('aria-labelledby')!;
        expect(document.getElementById(labelledBy)!.textContent).toContain('Informant');
    });

    it('leaves the table alone when the screen is not the table', () => {
        const h = harness();
        h.openSheetFor('informant', { targets: THREE_TARGETS });
        h.sheet.update(makeState({ screen: 'lobby' }));
        expect(h.root.querySelector('[data-role="action-sheet"]')).toBeNull();
    });

    it('has no axe violations', async () => {
        loadRealStyles();
        const h = harness();
        h.openSheetFor('informant', { targets: THREE_TARGETS });

        const results = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
        expect(results.violations.map(v => v.id)).toEqual([]);
    });
});

describe('sharing the bottom corner with the quick-reference tab', () => {
    // Both want bottom-right, and the tab wins on z-index — so it lands on
    // Cancel and Play and the sheet cannot be used at all.
    function withTab() {
        const h = harness();
        loadRealStyles();
        const tab = document.createElement('button');
        tab.className = 'reference-tab';
        (h.root as HTMLElement).appendChild(tab);
        return { ...h, tab, root: h.root as HTMLElement };
    }

    it('leaves the tab in its own corner when no sheet is open', () => {
        const ui = withTab();
        expect(ui.root.hasAttribute('data-sheet')).toBe(false);
        expect(getComputedStyle(ui.tab).right).not.toBe('auto');
    });

    it('announces the open sheet and its anchor', () => {
        const ui = withTab();
        ui.openSheetFor('mule', { targets: [] });
        expect(ui.root.getAttribute('data-sheet')).toBe('bottom');
    });

    it('announces the right-edge anchor on a wide viewport', () => {
        const ui = withTab();
        ui.openSheetFor('mule', { targets: [], available: DESKTOP });
        expect(ui.root.getAttribute('data-sheet')).toBe('right');
    });

    it('moves the tab out of the corner the footer needs', () => {
        const ui = withTab();
        ui.openSheetFor('mule', { targets: [] });

        expect(getComputedStyle(ui.tab).right).toBe('auto');
        expect(getComputedStyle(ui.tab).left).not.toBe('auto');
    });

    it('gives the corner back when the sheet closes', () => {
        const ui = withTab();
        ui.openSheetFor('mule', { targets: [] });
        ui.sheet.close();

        expect(ui.root.hasAttribute('data-sheet')).toBe(false);
        expect(getComputedStyle(ui.tab).right).not.toBe('auto');
    });

    it('gives it back after a play, not only after a cancel', () => {
        const ui = withTab();
        const sheet = ui.openSheetFor('shielded-mind', { targets: [] });
        click(sheet.querySelector('[data-action="play"]'));

        expect(ui.root.hasAttribute('data-sheet')).toBe(false);
    });

    it('gives it back after a cancel', () => {
        const ui = withTab();
        const sheet = ui.openSheetFor('mule', { targets: [] });
        click(sheet.querySelector('[data-action="cancel"]'));

        expect(ui.root.hasAttribute('data-sheet')).toBe(false);
    });
});

describe('a play the store refuses', () => {
    // Closing regardless is what made every refusal — a socket mid-reconnect, a
    // play already in flight — look exactly like the button doing nothing.
    it('keeps the sheet open so the press is visibly not lost', () => {
        const h = harness({ acceptPlay: false });
        const sheet = h.openSheetFor('shielded-mind', { targets: [] });

        click(sheet.querySelector('[data-action="play"]'));

        expect(h.played).toHaveLength(1);
        expect(h.root.querySelector('[data-role="action-sheet"]')).not.toBeNull();
    });

    it('keeps the choices already made, so nothing has to be re-picked', () => {
        const h = harness({ acceptPlay: false });
        const sheet = h.openSheetFor('informant', { targets: THREE_TARGETS });
        click(sheet.querySelector('[data-target="p2"]'));
        click(sheet.querySelector('[data-guess="5"]'));

        click(sheet.querySelector('[data-action="play"]'));

        expect(sheet.querySelector('[data-target="p2"]')!.getAttribute('aria-pressed')).toBe('true');
        expect(sheet.querySelector('[data-guess="5"]')!.getAttribute('aria-pressed')).toBe('true');
    });

    it('lets the player press again', () => {
        const h = harness({ acceptPlay: false });
        const sheet = h.openSheetFor('shielded-mind', { targets: [] });
        click(sheet.querySelector('[data-action="play"]'));
        click(sheet.querySelector('[data-action="play"]'));
        expect(h.played).toHaveLength(2);
    });
});

describe('a card that cannot be played right now', () => {
    const OFF_TURN = { kind: 'not-your-turn' } as const;

    it('still opens, because reading what a card does is an ordinary thing to want', () => {
        const h = harness();
        h.sheet.open({ cardId: 'mule', cardInstanceId: 'mule#1', targets: [], available: PHONE, unplayable: OFF_TURN });

        const sheet = h.root.querySelector('[data-role="action-sheet"]') as HTMLElement;
        expect(sheet).not.toBeNull();
        expect(sheet.textContent).toContain(cardCopyFor('mule').effect);
    });

    it('disables Play and says why', () => {
        const h = harness();
        h.sheet.open({ cardId: 'mule', cardInstanceId: 'mule#1', targets: [], available: PHONE, unplayable: OFF_TURN });

        const sheet = h.root.querySelector('[data-role="action-sheet"]') as HTMLElement;
        expect((sheet.querySelector('[data-action="play"]') as HTMLButtonElement).disabled).toBe(true);
        expect(sheet.querySelector('[data-role="not-playable"]')!.textContent).toContain('Not your turn');
    });

    it('emits nothing when Play is pressed anyway', () => {
        const h = harness();
        h.sheet.open({ cardId: 'mule', cardInstanceId: 'mule#1', targets: [], available: PHONE, unplayable: OFF_TURN });
        click(h.root.querySelector('[data-action="play"]'));
        expect(h.played).toEqual([]);
    });

    it('stays fully playable when the flag is absent', () => {
        const h = harness();
        const sheet = h.openSheetFor('shielded-mind', { targets: [] });
        expect((sheet.querySelector('[data-action="play"]') as HTMLButtonElement).disabled).toBe(false);
        expect(sheet.querySelector('[data-role="not-playable"]')).toBeNull();
    });
});

/**
 * The reported bug. Three situations shared one boolean, so the sheet described
 * all three as the first — and printed a rule of the game that was not true.
 */
describe('which of the three reasons it gives', () => {
    const PROTECTED_LINE = 'protected or eliminated';

    it('names the card the First Speaker rule forces, instead of blaming the turn', () => {
        const h = harness();
        h.sheet.open({
            cardId: 'toran-darell',
            cardInstanceId: 'toran-darell#1',
            targets: THREE_TARGETS,
            available: PHONE,
            unplayable: { kind: 'forced', mustPlay: 'first-speaker' }
        });

        const sheet = h.root.querySelector('[data-role="action-sheet"]') as HTMLElement;
        const why = sheet.querySelector('[data-role="not-playable"]')!.textContent!;
        expect(why).toContain('The First Speaker');
        expect(why).not.toContain('Not your turn');
    });

    it('does not claim everyone is protected when the real reason is a forced play', () => {
        const h = harness();
        h.sheet.open({
            cardId: 'toran-darell',
            cardInstanceId: 'toran-darell#1',
            targets: THREE_TARGETS,
            available: PHONE,
            unplayable: { kind: 'forced', mustPlay: 'first-speaker' }
        });

        expect(h.root.querySelector('[data-role="action-sheet"]')!.textContent).not.toContain(PROTECTED_LINE);
    });

    it('does not claim everyone is protected when it is simply not your turn', () => {
        const h = harness();
        h.sheet.open({
            cardId: 'informant',
            cardInstanceId: 'informant#1',
            // Off-turn the engine sends no legal targets, so every seat reads
            // ineligible. That is not a statement about protection.
            targets: THREE_TARGETS.map(target => ({ ...target, eligible: false })),
            available: PHONE,
            unplayable: { kind: 'not-your-turn' }
        });

        expect(h.root.querySelector('[data-role="action-sheet"]')!.textContent).not.toContain(PROTECTED_LINE);
    });

    it('keeps the protected-or-eliminated line for a card that really can be played', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', {
            targets: THREE_TARGETS.map(target => ({ ...target, eligible: false }))
        });

        expect(sheet.textContent).toContain(PROTECTED_LINE);
    });
});

describe('when exactly one target is eligible', () => {
    const ONE_ELIGIBLE: SheetTarget[] = [
        { playerId: 'p2', nickname: 'Ana', eligible: false, reason: 'protected' },
        { playerId: 'p3', nickname: 'Toran', eligible: true },
        { playerId: 'p4', nickname: 'Bayta', eligible: false, reason: 'eliminated' }
    ];

    it('chooses it, so the player is not asked a question with one answer', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: ONE_ELIGIBLE });

        expect(sheet.querySelector('[data-target="p3"]')!.getAttribute('aria-pressed')).toBe('true');
    });

    it('picks the eligible seat, not merely the first one listed', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: ONE_ELIGIBLE });

        expect(sheet.querySelector('[data-target="p2"]')!.getAttribute('aria-pressed')).toBe('false');
    });

    it('still requires Play to be pressed — nothing plays itself', () => {
        // A card that plays itself on one tap is how a player discards The Mule
        // by accident.
        const h = harness();
        h.openSheetFor('ebling-mis', { targets: ONE_ELIGIBLE });
        expect(h.played).toEqual([]);
    });

    it('enables Play for a card that needs only a target', () => {
        const h = harness();
        const sheet = h.openSheetFor('ebling-mis', { targets: ONE_ELIGIBLE });
        expect((sheet.querySelector('[data-action="play"]') as HTMLButtonElement).disabled).toBe(false);
    });

    it('leaves the Informant waiting on its guess even so', () => {
        // Pre-selecting the target must not imply the rest of the decision.
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: ONE_ELIGIBLE });
        expect((sheet.querySelector('[data-action="play"]') as HTMLButtonElement).disabled).toBe(true);

        click(sheet.querySelector('[data-guess="5"]'));
        expect((sheet.querySelector('[data-action="play"]') as HTMLButtonElement).disabled).toBe(false);
    });

    it('sends the pre-selected target when Play is finally pressed', () => {
        const h = harness();
        const sheet = h.openSheetFor('ebling-mis', { targets: ONE_ELIGIBLE });
        click(sheet.querySelector('[data-action="play"]'));

        expect(h.played).toEqual([{ cardInstanceId: 'ebling-mis#1', target: 'p3' }]);
    });

    it('chooses nothing when two seats are eligible', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: THREE_TARGETS.map(t => ({ ...t, eligible: true })) });

        for (const id of ['p2', 'p3', 'p4']) {
            expect(sheet.querySelector(`[data-target="${id}"]`)!.getAttribute('aria-pressed'), id).toBe('false');
        }
    });
});

describe('an open sheet when the turn arrives', () => {
    /**
     * The sheet used to snapshot everything at `open()` and then react only to
     * the socket. A player who opened a card while waiting watched their turn
     * begin with the sheet still saying "Not your turn" and Play still dead.
     */
    function openedOffTurn() {
        const h = harness();
        h.sheet.open({
            cardId: 'informant',
            cardInstanceId: 'informant#1',
            targets: THREE_TARGETS.map(target => ({ ...target, eligible: false })),
            available: PHONE,
            unplayable: { kind: 'not-your-turn' }
        });
        return h;
    }

    const playable = (targets: SheetTarget[]): SheetRequest => ({
        cardId: 'informant',
        cardInstanceId: 'informant#1',
        targets,
        available: PHONE
    });

    it('reports which card it is showing, so the caller can reassemble it', () => {
        const h = openedOffTurn();
        expect(h.sheet.showing()).toBe('informant#1');

        h.sheet.close();
        expect(h.sheet.showing()).toBeNull();
    });

    it('drops the not-your-turn line and enables the decision', () => {
        const h = openedOffTurn();

        h.sheet.refresh(playable(THREE_TARGETS));

        const sheet = h.root.querySelector('[data-role="action-sheet"]') as HTMLElement;
        expect(sheet.querySelector('[data-role="not-playable"]')).toBeNull();
        expect(sheet.querySelector('[data-target="p2"]')).not.toBeNull();
    });

    it('offers the guess section that was withheld off-turn', () => {
        const h = openedOffTurn();
        expect(h.root.querySelector('[data-guess="5"]')).toBeNull();

        h.sheet.refresh(playable(THREE_TARGETS));

        expect(h.root.querySelector('[data-guess="5"]')).not.toBeNull();
    });

    it('auto-selects a sole target that only becomes eligible on the new state', () => {
        const h = openedOffTurn();
        h.sheet.refresh(playable([THREE_TARGETS[0], THREE_TARGETS[1], THREE_TARGETS[2]]));

        expect(h.root.querySelector('[data-target="p2"]')!.getAttribute('aria-pressed')).toBe('true');
    });

    it('ignores a refresh aimed at a different card', () => {
        const h = openedOffTurn();
        h.sheet.refresh({ ...playable(THREE_TARGETS), cardId: 'mule', cardInstanceId: 'mule#1' });

        expect(h.root.querySelector('[data-role="action-sheet"]')!.textContent).toContain('Informant');
    });

    it('does nothing when no sheet is open', () => {
        const h = harness();
        expect(() => h.sheet.refresh(playable(THREE_TARGETS))).not.toThrow();
        expect(h.root.querySelector('[data-role="action-sheet"]')).toBeNull();
    });

    it('keeps a choice already made when nothing material changed', () => {
        // A STATE_UPDATE arrives for reasons that have nothing to do with this
        // decision — a seat reconnecting, a pause. Discarding the player's
        // half-made choice for one of those would be its own bug.
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: THREE_TARGETS });
        click(sheet.querySelector('[data-target="p2"]'));
        click(sheet.querySelector('[data-guess="5"]'));

        h.sheet.refresh(playable(THREE_TARGETS));

        expect(h.root.querySelector('[data-target="p2"]')!.getAttribute('aria-pressed')).toBe('true');
        expect(h.root.querySelector('[data-guess="5"]')!.getAttribute('aria-pressed')).toBe('true');
    });

    it('forgets a chosen target that the new state made ineligible', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: THREE_TARGETS });
        click(sheet.querySelector('[data-target="p2"]'));

        // Ana just gained protection. Playing at her is no longer a choice, and
        // carrying the selection forward would send the engine a play it refuses.
        h.sheet.refresh(
            playable([
                { playerId: 'p2', nickname: 'Ana', eligible: false, reason: 'protected' },
                { playerId: 'p3', nickname: 'Toran', eligible: true },
                { playerId: 'p4', nickname: 'Bayta', eligible: true }
            ])
        );

        expect(h.root.querySelector('[data-target="p2"]')!.getAttribute('aria-pressed')).toBe('false');
    });

    it('closes nothing and keeps the sheet up throughout', () => {
        const h = openedOffTurn();
        h.sheet.refresh(playable(THREE_TARGETS));
        expect(h.sheet.showing()).toBe('informant#1');
    });
});

describe('while the socket is down', () => {
    // store.playCard refuses silently when the socket is not open, so without
    // this the player presses Play, the sheet sits there, and nothing explains
    // why. It is the exact shape of the last three bugs.
    const offline = (state = {}) => makeState({ screen: 'table', connection: 'reconnecting' as const, ...state });

    it('disables Play rather than letting it be pressed into nothing', () => {
        const h = harness();
        h.sheet.update(offline());
        const sheet = h.openSheetFor('shielded-mind', { targets: [] });

        expect((sheet.querySelector('[data-action="play"]') as HTMLButtonElement).disabled).toBe(true);
    });

    it('says why', () => {
        const h = harness();
        h.sheet.update(offline());
        const sheet = h.openSheetFor('shielded-mind', { targets: [] });

        expect(sheet.querySelector('[data-role="offline-note"]')!.textContent).toContain('Reconnecting');
    });

    it('re-enables the moment the socket comes back, with the sheet still open', () => {
        const h = harness();
        h.sheet.update(offline());
        const sheet = h.openSheetFor('shielded-mind', { targets: [] });

        h.sheet.update(makeState({ screen: 'table', connection: 'open' }));

        expect((sheet.querySelector('[data-action="play"]') as HTMLButtonElement).disabled).toBe(false);
        expect(sheet.querySelector('[data-role="offline-note"]')).toBeNull();
    });

    it('disables an already-open sheet when the socket drops mid-decision', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: THREE_TARGETS });
        click(sheet.querySelector('[data-target="p2"]'));
        click(sheet.querySelector('[data-guess="5"]'));
        expect((sheet.querySelector('[data-action="play"]') as HTMLButtonElement).disabled).toBe(false);

        h.sheet.update(offline());

        expect((sheet.querySelector('[data-action="play"]') as HTMLButtonElement).disabled).toBe(true);
        // The choices survive: the drop is not the player's fault.
        expect(sheet.querySelector('[data-target="p2"]')!.getAttribute('aria-pressed')).toBe('true');
    });

    it('emits nothing when Play is pressed anyway', () => {
        const h = harness();
        h.sheet.update(offline());
        const sheet = h.openSheetFor('shielded-mind', { targets: [] });
        click(sheet.querySelector('[data-action="play"]'));
        expect(h.played).toEqual([]);
    });
});

/**
 * The failure these cover: a right-edge panel pinned to the full height of the
 * viewport sits on top of the rightmost seat chip, so a player choosing between
 * opponents cannot see the discards of one of them without closing the sheet.
 */
describe('keeping the seats visible while it is open', () => {
    it('starts the right-edge panel below the seat band', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { available: DESKTOP, safeTop: 180 });
        expect(sheet.style.top).toBe('180px');
    });

    it('leaves a bottom sheet alone, which never covered the seats anyway', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { available: PHONE, safeTop: 180 });
        expect(sheet.style.top).toBe('');
    });

    it('stays full height when there is no table to read a line off', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { available: DESKTOP });
        expect(sheet.style.top).toBe('');
    });

    it('never insets past half the viewport, however deep the seat band claims to be', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { available: DESKTOP, safeTop: DESKTOP.h * 5 });
        expect(Number.parseFloat(sheet.style.top)).toBe(DESKTOP.h / 2);
    });

    it('refuses a negative inset rather than floating the panel off the top', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { available: DESKTOP, safeTop: -50 });
        expect(sheet.style.top).toBe('0px');
    });
});
