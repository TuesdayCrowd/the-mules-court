// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { SoundControl } from './sound';
import { createSoundToggle } from './soundToggle';
import { makeState, makeUiRootElement } from './__fixtures__/dom';

/** The player's mute half, standing in for the whole synthesis engine. */
function fakeSound(initial = false): SoundControl & { calls: boolean[] } {
    let muted = initial;
    const calls: boolean[] = [];
    return {
        calls,
        muted: () => muted,
        setMuted(next) {
            muted = next;
            calls.push(next);
        }
    };
}

function mount(sound: SoundControl) {
    const root = makeUiRootElement();
    const surface = createSoundToggle({ sound });
    surface.mount(root);
    const button = root.querySelector('[data-role="sound-toggle"]') as HTMLButtonElement;
    return { root, surface, button };
}

describe('the mute control', () => {
    it('is a real button, so it is reachable by keyboard without any help', () => {
        const { button } = mount(fakeSound());
        expect(button.tagName).toBe('BUTTON');
        expect(button.type).toBe('button');
    });

    it('mounts exactly one element, as the pointer-events discipline requires', () => {
        const root = makeUiRootElement();
        createSoundToggle({ sound: fakeSound() }).mount(root);
        expect(root.children).toHaveLength(1);
    });

    it('states the toggle state as a pressed state', () => {
        const { button } = mount(fakeSound());
        expect(button.getAttribute('aria-pressed')).toBe('false');
        button.click();
        expect(button.getAttribute('aria-pressed')).toBe('true');
    });

    it('has a name that survives being read on its own', () => {
        // One glyph in a corner with no adjacent text, so the name has to carry
        // both what is true now and what pressing it will do.
        const { button } = mount(fakeSound());
        expect(button.getAttribute('aria-label')).toBe('Sound on. Mute.');
        button.click();
        expect(button.getAttribute('aria-label')).toBe('Sound muted. Unmute.');
    });

    it('turns sound off and on again', () => {
        const sound = fakeSound();
        const { button } = mount(sound);
        button.click();
        button.click();
        expect(sound.calls).toEqual([true, false]);
    });

    it('opens in the state the player left it in', () => {
        // The preference lives in the player, which read it from storage; this
        // surface asks rather than remembering a second copy of the answer.
        const { button } = mount(fakeSound(true));
        expect(button.getAttribute('aria-pressed')).toBe('true');
        expect(button.dataset.muted).toBe('true');
    });

    it('offers styling a state hook, so nothing has to parse the label', () => {
        const { button } = mount(fakeSound());
        expect(button.dataset.muted).toBe('false');
        button.click();
        expect(button.dataset.muted).toBe('true');
    });

    it('carries an icon that is hidden from the accessibility tree', () => {
        // The name says it in words; the glyph would only repeat it, and
        // repeating it as an unlabelled SVG would say it wrong.
        const { button } = mount(fakeSound());
        const icon = button.querySelector('svg') as SVGSVGElement;
        expect(icon.getAttribute('aria-hidden')).toBe('true');
        expect(button.textContent).toBe('');
    });

    it('redraws only when the state it shows has actually changed', () => {
        const { button, surface } = mount(fakeSound());
        const icon = button.querySelector('svg');
        surface.update(makeState({ screen: 'table' }));
        surface.update(makeState({ screen: 'lobby' }));
        expect(button.querySelector('svg')).toBe(icon);
    });

    it('follows a mute that came from somewhere else', () => {
        const sound = fakeSound();
        const { button, surface } = mount(sound);
        sound.setMuted(true);
        surface.update(makeState({ screen: 'table' }));
        expect(button.getAttribute('aria-pressed')).toBe('true');
    });

    it('detaches on destroy', () => {
        const { root, surface } = mount(fakeSound());
        surface.destroy();
        expect(root.children).toHaveLength(0);
    });
});
