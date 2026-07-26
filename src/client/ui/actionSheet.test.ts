// @vitest-environment jsdom
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import type { CardTypeId } from '../../game/engine';
import { cardCopyFor } from '../content/cardCopy';
import { loadRealStyles, makeState, makeUiRootElement } from './__fixtures__/dom';
import type { SheetTarget } from './actionSheet';
import { createActionSheet } from './actionSheet';

const PHONE = { w: 390, h: 844 } as const;
const DESKTOP = { w: 1440, h: 900 } as const;

const THREE_TARGETS: SheetTarget[] = [
    { playerId: 'p2', nickname: 'Ana', eligible: true },
    { playerId: 'p3', nickname: 'Toran', eligible: false, reason: 'protected' },
    { playerId: 'p4', nickname: 'Bayta', eligible: false, reason: 'eliminated' }
];

function harness() {
    const root = makeUiRootElement();
    const played: Array<{ cardInstanceId: string; target?: string; guess?: number }> = [];
    const cancelled: number[] = [];

    const sheet = createActionSheet({
        onPlay: choice => played.push(choice),
        onCancel: () => cancelled.push(1)
    });
    sheet.mount(root);
    sheet.update(makeState({ screen: 'table' }));

    function openSheetFor(
        cardId: CardTypeId,
        options: { targets?: SheetTarget[]; available?: { w: number; h: number } } = {}
    ): HTMLElement {
        sheet.open({
            cardId,
            cardInstanceId: `${cardId}#1`,
            targets: options.targets ?? [],
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
        const describedBy = toran.getAttribute('aria-describedby')!;
        expect(document.getElementById(describedBy)!.textContent).toContain('protected');
    });

    it('gives each ineligible target its own reason', () => {
        const h = harness();
        const sheet = h.openSheetFor('informant', { targets: THREE_TARGETS });

        const bayta = sheet.querySelector('[data-target="p4"]') as HTMLButtonElement;
        const describedBy = bayta.getAttribute('aria-describedby')!;
        expect(document.getElementById(describedBy)!.textContent).toContain('eliminated');
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
        const h = harness();
        const sheet = h.openSheetFor('mayor-indbur', { targets: THREE_TARGETS });
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
        const h = harness();
        let sheet = h.openSheetFor('informant', { targets: THREE_TARGETS });
        click(sheet.querySelector('[data-target="p2"]'));
        click(sheet.querySelector('[data-action="cancel"]'));

        sheet = h.openSheetFor('informant', { targets: THREE_TARGETS });
        expect((sheet.querySelector('[data-action="play"]') as HTMLButtonElement).disabled).toBe(true);
        expect(sheet.querySelector('[data-target="p2"]')!.getAttribute('aria-pressed')).toBe('false');
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
