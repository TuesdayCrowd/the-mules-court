// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { MAX_NICKNAME_LENGTH } from '../content/nickname';
import { makeState, makeUiRootElement } from './__fixtures__/dom';
import { createJoinScreen } from './joinScreen';

function mounted() {
    const root = makeUiRootElement();
    const submitted: string[] = [];
    const screen = createJoinScreen({ onSubmit: nickname => submitted.push(nickname) });
    screen.mount(root);

    const q = <T extends Element>(selector: string) => root.querySelector(selector) as T | null;

    return {
        root,
        screen,
        submitted,
        form: () => q<HTMLFormElement>('form'),
        input: () => q<HTMLInputElement>('input[type="text"]'),
        button: () => q<HTMLButtonElement>('button[type="submit"]'),
        error: () => q<HTMLElement>('[data-role="nickname-error"]'),
        /** Type into the field the way a person does, firing the event the screen listens for. */
        type(value: string) {
            const input = q<HTMLInputElement>('input[type="text"]')!;
            input.value = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        },
        show(overrides = {}) {
            screen.update(makeState({ screen: 'joining', matchId: 'K7QX2', ...overrides }));
        }
    };
}

describe('when it is not this screen’s turn', () => {
    it('renders nothing on the menu', () => {
        const ui = mounted();
        ui.screen.update(makeState({ screen: 'menu' }));
        expect(ui.form()).toBeNull();
    });

    it('renders nothing at the table', () => {
        const ui = mounted();
        ui.show();
        ui.screen.update(makeState({ screen: 'table' }));
        expect(ui.form()).toBeNull();
    });
});

describe('the nickname form', () => {
    it('gives the field an accessible name through a real label', () => {
        const ui = mounted();
        ui.show();

        const label = ui.root.querySelector('label') as HTMLLabelElement;
        expect(label.htmlFor).toBe(ui.input()!.id);
        expect(label.textContent!.length).toBeGreaterThan(0);
        expect(ui.input()!.id).not.toBe('');
    });

    it('caps the field at the server’s limit so the browser helps too', () => {
        const ui = mounted();
        ui.show();
        expect(ui.input()!.maxLength).toBe(MAX_NICKNAME_LENGTH);
    });

    it('labels the button "Take a seat"', () => {
        const ui = mounted();
        ui.show();
        expect(ui.button()!.textContent).toBe('Take a seat');
    });

    it('focuses the field so a phone keyboard opens without a second tap', () => {
        const ui = mounted();
        ui.show();
        expect(document.activeElement).toBe(ui.input());
    });

    it('starts with the button disabled and no scolding', () => {
        const ui = mounted();
        ui.show();

        expect(ui.button()!.disabled).toBe(true);
        expect(ui.error()).toBeNull(); // a pristine empty field has done nothing wrong
    });

    it('enables the button once the name validates', () => {
        const ui = mounted();
        ui.show();
        ui.type('Ana');

        expect(ui.button()!.disabled).toBe(false);
        expect(ui.error()).toBeNull();
    });

    it('explains a name that is too long, and keeps the button disabled', () => {
        const ui = mounted();
        ui.show();
        ui.type('C'.repeat(MAX_NICKNAME_LENGTH + 1));

        expect(ui.button()!.disabled).toBe(true);
        expect(ui.error()!.textContent).toContain(String(MAX_NICKNAME_LENGTH));
    });

    it('explains a name carrying a hidden character', () => {
        const ui = mounted();
        ui.show();
        ui.type('Ana\u0007na');

        expect(ui.button()!.disabled).toBe(true);
        expect(ui.error()!.textContent!.length).toBeGreaterThan(0);
    });

    it('ties the message to the field, so it is read with it rather than adrift', () => {
        const ui = mounted();
        ui.show();
        ui.type('C'.repeat(MAX_NICKNAME_LENGTH + 1));

        expect(ui.input()!.getAttribute('aria-describedby')).toBe(ui.error()!.id);
        expect(ui.input()!.getAttribute('aria-invalid')).toBe('true');
    });

    it('clears the message and the invalid flag once the name is fixed', () => {
        const ui = mounted();
        ui.show();
        ui.type('C'.repeat(MAX_NICKNAME_LENGTH + 1));
        ui.type('Ana');

        expect(ui.error()).toBeNull();
        expect(ui.input()!.getAttribute('aria-invalid')).toBe('false');
        expect(ui.input()!.getAttribute('aria-describedby')).toBeNull();
    });

    it('says nothing about a field the player has emptied again', () => {
        const ui = mounted();
        ui.show();
        ui.type('Ana');
        ui.type('');

        expect(ui.button()!.disabled).toBe(true);
        expect(ui.error()).toBeNull();
    });
});

describe('submitting', () => {
    it('submits on Enter, which is what a submit button in a form buys', () => {
        const ui = mounted();
        ui.show();
        ui.type('Ana');

        ui.form()!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

        expect(ui.submitted).toEqual(['Ana']);
    });

    it('submits the trimmed name, matching what the server will store', () => {
        const ui = mounted();
        ui.show();
        ui.type('   Bayta   ');
        ui.button()!.click();

        expect(ui.submitted).toEqual(['Bayta']);
    });

    it('refuses an invalid name even when Enter bypasses the disabled button', () => {
        const ui = mounted();
        ui.show();
        ui.type('C'.repeat(MAX_NICKNAME_LENGTH + 1));

        ui.form()!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

        expect(ui.submitted).toEqual([]);
    });

    it('never reloads the page', () => {
        const ui = mounted();
        ui.show();
        ui.type('Ana');

        const event = new Event('submit', { bubbles: true, cancelable: true });
        ui.form()!.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
    });

    it('submits once per press, not once per keystroke typed before it', () => {
        const ui = mounted();
        ui.show();
        ui.type('A');
        ui.type('An');
        ui.type('Ana');
        ui.button()!.click();

        expect(ui.submitted).toEqual(['Ana']);
    });
});

describe('a seat this browser already holds', () => {
    it('asks no name of a host who named themselves on the menu', () => {
        // D2: the host arrives at /join/:matchId holding a token and a nickname,
        // so the form would be asking a question already answered.
        const ui = mounted();
        ui.show({ seat: { seat: 0, playerId: 'p1' } });

        expect(ui.form()).toBeNull();
        expect(ui.root.textContent).toContain('Taking your seat');
    });

    it('shows the form again if that seat is dropped', () => {
        // FATAL BAD_TOKEN clears the seat and returns here for a fresh claim.
        const ui = mounted();
        ui.show({ seat: { seat: 0, playerId: 'p1' } });
        ui.show({ seat: null });

        expect(ui.form()).not.toBeNull();
    });

    it('keeps what the player had typed across an unrelated update', () => {
        const ui = mounted();
        ui.show();
        ui.type('Ana');
        ui.show({ connection: 'reconnecting' });

        expect(ui.input()!.value).toBe('Ana');
        expect(ui.button()!.disabled).toBe(false);
    });
});

describe('teardown', () => {
    it('removes itself', () => {
        const ui = mounted();
        ui.show();
        ui.screen.destroy();
        expect(ui.root.querySelector('[data-role="join"]')).toBeNull();
    });
});
