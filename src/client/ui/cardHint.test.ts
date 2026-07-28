// @vitest-environment jsdom
import axe from 'axe-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { cardCopyFor } from '../content/cardCopy';
import { loadRealStyles, makeState, makeTable, makeUiRootElement } from './__fixtures__/dom';
import { createCardHint } from './cardHint';

beforeEach(() => {
    loadRealStyles();
});

const VIEWPORT = { w: 1000, h: 800 };

function mounted(viewport = VIEWPORT) {
    const root = makeUiRootElement();
    const surface = createCardHint({ viewport: () => viewport });
    surface.mount(root);
    surface.update(makeState({ screen: 'table', table: makeTable() }));

    return {
        root,
        surface,
        hint: () => root.querySelector('[data-role="card-hint"]') as HTMLElement | null
    };
}

describe('showing a card’s ability', () => {
    it('names the card and states what it does', () => {
        const ui = mounted();
        ui.surface.show('first-speaker', { x: 100, y: 100 });

        const text = ui.hint()!.textContent!;
        expect(text).toContain('The First Speaker');
        expect(text).toContain('7');
        expect(text).toContain(cardCopyFor('first-speaker').effect);
    });

    it('shows nothing until asked', () => {
        expect(mounted().hint()).toBeNull();
    });

    it('replaces its content when the pointer moves to a different card', () => {
        const ui = mounted();
        ui.surface.show('mule', { x: 10, y: 10 });
        ui.surface.show('informant', { x: 20, y: 20 });

        expect(ui.hint()!.textContent).toContain('Informant');
        expect(ui.hint()!.textContent).not.toContain('The Mule');
    });

    it('goes away when hidden', () => {
        const ui = mounted();
        ui.surface.show('mule', { x: 10, y: 10 });
        ui.surface.hide();

        expect(ui.hint()).toBeNull();
    });

    it('tolerates being hidden when it is not showing', () => {
        const ui = mounted();
        expect(() => ui.surface.hide()).not.toThrow();
    });
});

describe('staying on screen', () => {
    it('sits beside the pointer, not under it', () => {
        const ui = mounted();
        ui.surface.show('mule', { x: 100, y: 200 });

        expect(Number.parseInt(ui.hint()!.style.left, 10)).toBeGreaterThan(100);
        expect(Number.parseInt(ui.hint()!.style.top, 10)).toBeGreaterThan(200);
    });

    it('is pushed back inside at the right edge', () => {
        const ui = mounted();
        ui.surface.show('mule', { x: 995, y: 100 });

        expect(Number.parseInt(ui.hint()!.style.left, 10)).toBeLessThan(VIEWPORT.w);
    });

    it('is pushed back inside at the bottom edge', () => {
        const ui = mounted();
        ui.surface.show('mule', { x: 100, y: 795 });

        expect(Number.parseInt(ui.hint()!.style.top, 10)).toBeLessThan(VIEWPORT.h);
    });

    it('never goes negative on a viewport smaller than the hint', () => {
        const ui = mounted({ w: 120, h: 90 });
        ui.surface.show('mule', { x: 10, y: 10 });

        expect(Number.parseInt(ui.hint()!.style.left, 10)).toBeGreaterThanOrEqual(0);
        expect(Number.parseInt(ui.hint()!.style.top, 10)).toBeGreaterThanOrEqual(0);
    });
});

describe('its lifetime', () => {
    it('leaves with the table, because a hint about nothing is a sentence about nothing', () => {
        const ui = mounted();
        ui.surface.show('mule', { x: 10, y: 10 });

        ui.surface.update(makeState({ screen: 'lobby' }));

        expect(ui.hint()).toBeNull();
    });

    it('takes itself down on destroy', () => {
        const ui = mounted();
        ui.surface.show('mule', { x: 10, y: 10 });
        ui.surface.destroy();

        expect(ui.hint()).toBeNull();
        expect(ui.root.querySelector('[data-role="card-hint-host"]')).toBeNull();
    });
});

describe('it never competes with the card it describes', () => {
    it('takes no pointer events', () => {
        // A tooltip that could be hovered sits between the pointer and the card
        // that summoned it, and flickers.
        const ui = mounted();
        ui.surface.show('mule', { x: 10, y: 10 });

        expect(getComputedStyle(ui.hint()!).pointerEvents).toBe('none');
    });

    it('is hidden from assistive technology, which already has this sentence', () => {
        const ui = mounted();
        ui.surface.show('mule', { x: 10, y: 10 });

        expect(ui.hint()!.getAttribute('aria-hidden')).toBe('true');
    });

    it('has no axe violations while showing', async () => {
        const ui = mounted();
        ui.surface.show('first-speaker', { x: 10, y: 10 });

        const results = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
        expect(results.violations.map(v => v.id)).toEqual([]);
    });
});
