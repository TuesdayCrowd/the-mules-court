// @vitest-environment jsdom
import axe from 'axe-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { QUICK_REFERENCE, totalCards } from '../content/quickReference';
import { loadRealStyles, makeState, makeUiRootElement } from './__fixtures__/dom';
import { createQuickReference } from './quickReference';

beforeEach(() => {
    loadRealStyles();
});

function mounted() {
    const root = makeUiRootElement();
    const panel = createQuickReference();
    panel.mount(root);

    const q = <T extends Element>(selector: string) => root.querySelector(selector) as T | null;

    return {
        root,
        panel,
        tab: () => q<HTMLButtonElement>('[data-action="quick-reference"]'),
        modal: () => q<HTMLElement>('[data-role="quick-reference-modal"]'),
        rows: () => [...root.querySelectorAll('[data-role="reference-row"]')],
        show: (overrides = {}) => panel.update(makeState({ screen: 'table', ...overrides }))
    };
}

describe('the tab', () => {
    it('is reachable at every moment the table is up, including another player’s turn', () => {
        // Deduction depends on knowing what is still out there, so the panel is
        // never gated on holding the turn.
        const ui = mounted();
        ui.show();
        expect(ui.tab()).not.toBeNull();
    });

    it('is absent away from the table', () => {
        const ui = mounted();
        ui.panel.update(makeState({ screen: 'lobby' }));
        expect(ui.tab()).toBeNull();
    });

    it('says what it opens', () => {
        const ui = mounted();
        ui.show();
        expect(ui.tab()!.textContent!.length).toBeGreaterThan(0);
        expect(ui.tab()!.getAttribute('aria-expanded')).toBe('false');
    });

    it('opens the modal and marks itself expanded', () => {
        const ui = mounted();
        ui.show();
        ui.tab()!.click();

        expect(ui.modal()).not.toBeNull();
        expect(ui.tab()!.getAttribute('aria-expanded')).toBe('true');
    });
});

describe('the table of values', () => {
    it('renders eight rows, 8 down to 1', () => {
        const ui = mounted();
        ui.show();
        ui.tab()!.click();

        expect(ui.rows().map(row => Number(row.getAttribute('data-value')))).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    });

    it('puts the count for each value on its row', () => {
        const ui = mounted();
        ui.show();
        ui.tab()!.click();

        for (const reference of QUICK_REFERENCE) {
            const row = ui.rows().find(node => Number(node.getAttribute('data-value')) === reference.value)!;
            expect(row.textContent, `value ${reference.value}`).toContain(String(reference.count));
        }
    });

    it('shares a row between characters of the same value', () => {
        const ui = mounted();
        ui.show();
        ui.tab()!.click();

        const five = ui.rows().find(node => node.getAttribute('data-value') === '5')!;
        expect(five.textContent).toContain('Bayta Darell');
        expect(five.textContent).toContain('Toran Darell');
    });

    it('states what each value does, not only who holds it', () => {
        // The panel exists to answer "what is still out there"; a player who has
        // to remember what a 5 does has to leave the panel to find out.
        const ui = mounted();
        ui.show();
        ui.tab()!.click();

        for (const reference of QUICK_REFERENCE) {
            const row = ui.rows().find(node => Number(node.getAttribute('data-value')) === reference.value)!;
            expect(row.textContent, `value ${reference.value}`).toContain(reference.effect);
        }
    });

    it('heads the ability column', () => {
        const ui = mounted();
        ui.show();
        ui.tab()!.click();

        const headings = [...ui.root.querySelectorAll('th[scope="col"]')].map(cell => cell.textContent);
        expect(headings).toContain('Ability');
    });

    it('accounts for all sixteen cards', () => {
        const ui = mounted();
        ui.show();
        ui.tab()!.click();

        const counted = QUICK_REFERENCE.reduce((sum, row) => sum + row.count, 0);
        expect(counted).toBe(totalCards());
        expect(counted).toBe(16);
    });
});

describe('layering and dismissal', () => {
    it('layers above an open action sheet', () => {
        const ui = mounted();
        ui.show();
        ui.tab()!.click();

        const sheet = document.createElement('div');
        sheet.className = 'action-sheet';
        ui.root.appendChild(sheet);

        const above = Number(getComputedStyle(ui.modal()!).zIndex);
        const below = Number(getComputedStyle(sheet).zIndex);
        expect(above).toBeGreaterThan(below);
    });

    it('closes on Escape and returns focus to the tab', () => {
        const ui = mounted();
        ui.show();
        ui.tab()!.click();

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        expect(ui.modal()).toBeNull();
        expect(document.activeElement).toBe(ui.tab());
    });

    it('closes on its own close button', () => {
        const ui = mounted();
        ui.show();
        ui.tab()!.click();

        (ui.root.querySelector('[data-action="close-reference"]') as HTMLButtonElement).click();

        expect(ui.modal()).toBeNull();
        expect(document.activeElement).toBe(ui.tab());
    });

    it('takes focus when it opens', () => {
        const ui = mounted();
        ui.show();
        ui.tab()!.click();
        expect(document.activeElement).toBe(ui.modal());
    });

    it('ignores Escape when it is not open', () => {
        const ui = mounted();
        ui.show();
        expect(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))).not.toThrow();
    });

    it('closes when the table goes away, rather than floating over the lobby', () => {
        const ui = mounted();
        ui.show();
        ui.tab()!.click();

        ui.panel.update(makeState({ screen: 'lobby' }));

        expect(ui.modal()).toBeNull();
    });

    it('stops listening for Escape once destroyed', () => {
        const ui = mounted();
        ui.show();
        ui.tab()!.click();
        ui.panel.destroy();

        expect(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))).not.toThrow();
        expect(ui.root.querySelector('[data-role="quick-reference-modal"]')).toBeNull();
    });
});

describe('accessibility', () => {
    it('is a dialog with an accessible name', () => {
        const ui = mounted();
        ui.show();
        ui.tab()!.click();

        expect(ui.modal()!.getAttribute('role')).toBe('dialog');
        const labelledBy = ui.modal()!.getAttribute('aria-labelledby')!;
        expect(document.getElementById(labelledBy)!.textContent!.length).toBeGreaterThan(0);
    });

    it('has no axe violations while open', async () => {
        const ui = mounted();
        ui.show();
        ui.tab()!.click();

        const results = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
        expect(results.violations.map(v => v.id)).toEqual([]);
    });
});
