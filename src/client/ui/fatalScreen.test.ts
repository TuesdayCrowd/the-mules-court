// @vitest-environment jsdom
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { failureCopy } from '../content/failureCopy';
import { loadRealStyles, makeState, makeUiRootElement } from './__fixtures__/dom';
import { createFatalScreen } from './fatalScreen';

function mounted() {
    const root = makeUiRootElement();
    const actions: string[] = [];
    const screen = createFatalScreen({ onAction: kind => actions.push(kind) });
    screen.mount(root);

    const q = <T extends Element>(selector: string) => root.querySelector(selector) as T | null;

    return {
        root,
        screen,
        actions,
        dialog: () => q<HTMLElement>('[role="alertdialog"]'),
        button: () => q<HTMLButtonElement>('[data-action="fatal-action"]'),
        show: (fatal: Parameters<typeof failureCopy>[0]) => screen.update(makeState({ screen: 'fatal', fatal }))
    };
}

describe('when nothing is fatal', () => {
    it('renders nothing', () => {
        const ui = mounted();
        ui.screen.update(makeState({ screen: 'menu' }));
        expect(ui.dialog()).toBeNull();
    });

    it('renders nothing on the fatal screen with no code, rather than an empty wall', () => {
        const ui = mounted();
        ui.screen.update(makeState({ screen: 'fatal', fatal: null }));
        expect(ui.dialog()).toBeNull();
    });
});

describe('the fatal screen', () => {
    it('is an alert dialog, because it interrupts and demands a choice', () => {
        const ui = mounted();
        ui.show('ROOM_FULL');
        expect(ui.dialog()).not.toBeNull();
    });

    it('has an accessible name of its own', () => {
        const ui = mounted();
        ui.show('ROOM_FULL');

        const labelledBy = ui.dialog()!.getAttribute('aria-labelledby');
        expect(labelledBy).not.toBeNull();
        expect(document.getElementById(labelledBy!)!.textContent!.length).toBeGreaterThan(0);
    });

    it('takes focus, so a keyboard lands on the wall rather than behind it', () => {
        const ui = mounted();
        ui.show('ROOM_FULL');
        expect(document.activeElement).toBe(ui.dialog());
    });

    it('is reachable by keyboard without being a tab stop twice over', () => {
        const ui = mounted();
        ui.show('ROOM_FULL');
        expect(ui.dialog()!.getAttribute('tabindex')).toBe('-1');
    });

    it('shows the designed message for the code', () => {
        const ui = mounted();
        ui.show('ROOM_NOT_FOUND');
        expect(ui.root.textContent).toContain(failureCopy('ROOM_NOT_FOUND').message);
    });

    it('labels its button from the same copy', () => {
        const ui = mounted();
        ui.show('SEAT_TAKEN');
        expect(ui.button()!.textContent).toBe('Take over here');
    });

    it('emits the action kind the copy names', () => {
        const ui = mounted();
        ui.show('SEAT_TAKEN');
        ui.button()!.click();
        expect(ui.actions).toEqual(['takeover']);
    });

    it('emits menu for a code with nowhere else to go', () => {
        const ui = mounted();
        ui.show('ROOM_FULL');
        ui.button()!.click();
        expect(ui.actions).toEqual(['menu']);
    });

    it('re-renders when the code changes', () => {
        const ui = mounted();
        ui.show('ROOM_FULL');
        ui.show('MATCH_OVER');

        expect(ui.root.textContent).toContain(failureCopy('MATCH_OVER').message);
        expect(ui.root.textContent).not.toContain(failureCopy('ROOM_FULL').message);
    });

    it('does not steal focus again on an unrelated update', () => {
        // A re-focus on every state push would drag a screen reader back to the
        // top of the dialog mid-sentence.
        const ui = mounted();
        ui.show('ROOM_FULL');
        ui.button()!.focus();

        ui.screen.update(makeState({ screen: 'fatal', fatal: 'ROOM_FULL', connection: 'reconnecting' }));

        expect(document.activeElement).toBe(ui.button());
    });

    it('clears itself when the screen moves on', () => {
        // FATAL BAD_TOKEN returns to joining rather than walling the player in.
        const ui = mounted();
        ui.show('ROOM_FULL');
        ui.screen.update(makeState({ screen: 'joining', fatal: null }));
        expect(ui.dialog()).toBeNull();
    });
});

describe('accessibility', () => {
    it.each(['ROOM_NOT_FOUND', 'SEAT_TAKEN', 'ROOM_FULL', 'MATCH_OVER', 'INTERNAL'] as const)(
        'has no axe violations showing %s',
        async code => {
            loadRealStyles();
            const ui = mounted();
            ui.show(code);

            const results = await axe.run(document.body, {
                // jsdom has no layout, so colour-contrast cannot be measured
                // here at all — `tokens/contrast.test.ts` covers it arithmetically.
                rules: { 'color-contrast': { enabled: false } }
            });

            expect(results.violations.map(v => v.id)).toEqual([]);
        }
    );
});
