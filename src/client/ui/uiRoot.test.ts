// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { loadRealStyles, makeState, makeUiRootElement } from './__fixtures__/dom';
import type { Surface } from './surface';
import { createUiRoot } from './uiRoot';

/** A surface that records what it was told and mounts one element, as the contract requires. */
function fakeSurface(tag = 'div') {
    const element = document.createElement(tag);
    const calls: string[] = [];
    const surface: Surface = {
        mount: parent => {
            calls.push('mount');
            parent.appendChild(element);
        },
        update: () => void calls.push('update'),
        destroy: () => {
            calls.push('destroy');
            element.remove();
        }
    };
    return { surface, element, calls };
}

beforeEach(() => {
    loadRealStyles();
});

describe('the ui root', () => {
    it('does not swallow taps meant for the table beneath it', () => {
        const root = createUiRoot(makeUiRootElement());
        expect(getComputedStyle(root.element).pointerEvents).toBe('none');
    });

    it('restores interactivity to a mounted surface', () => {
        const root = createUiRoot(makeUiRootElement());
        const { surface, element } = fakeSurface();

        root.add(surface);

        expect(element.parentElement).toBe(root.element); // a DIRECT child; `#ui-root > *` keys on it
        expect(getComputedStyle(element).pointerEvents).toBe('auto');
    });

    it('lets a surface nest freely, because pointer-events inherits', () => {
        const root = createUiRoot(makeUiRootElement());
        const { surface, element } = fakeSurface();
        root.add(surface);

        const button = document.createElement('button');
        element.appendChild(document.createElement('div')).appendChild(button);

        expect(getComputedStyle(button).pointerEvents).toBe('auto');
    });

    it('lets non-interactive chrome opt back out of taps', () => {
        // `#ui-root > *` restores `auto` for every direct child, which is right
        // for a screen and wrong for a toast strip: left interactive it would
        // sit over the table swallowing taps meant for the cards beneath.
        const root = createUiRoot(makeUiRootElement());
        const strip = document.createElement('div');
        strip.className = 'toasts';
        root.element.appendChild(strip);

        expect(getComputedStyle(strip).pointerEvents).toBe('none');
    });

    it('keeps a button inside non-interactive chrome tappable', () => {
        const root = createUiRoot(makeUiRootElement());
        const strip = document.createElement('div');
        strip.className = 'toasts';
        const button = document.createElement('button');
        strip.appendChild(button);
        root.element.appendChild(strip);

        expect(getComputedStyle(button).pointerEvents).toBe('auto');
    });

    it('pushes one update to every surface', () => {
        const root = createUiRoot(makeUiRootElement());
        const first = fakeSurface();
        const second = fakeSurface();
        root.add(first.surface);
        root.add(second.surface);

        root.update(makeState());

        expect(first.calls).toEqual(['mount', 'update']);
        expect(second.calls).toEqual(['mount', 'update']);
    });

    it('mounts in the order surfaces were added, so later chrome layers above earlier', () => {
        const root = createUiRoot(makeUiRootElement());
        const first = fakeSurface('section');
        const second = fakeSurface('aside');
        root.add(first.surface);
        root.add(second.surface);

        expect([...root.element.children]).toEqual([first.element, second.element]);
    });

    it('destroys every surface and leaves the root empty', () => {
        const root = createUiRoot(makeUiRootElement());
        const first = fakeSurface();
        const second = fakeSurface();
        root.add(first.surface);
        root.add(second.surface);

        root.destroy();

        expect(first.calls).toContain('destroy');
        expect(second.calls).toContain('destroy');
        expect(root.element.children).toHaveLength(0);
    });

    it('stops updating surfaces once destroyed', () => {
        const root = createUiRoot(makeUiRootElement());
        const { surface, calls } = fakeSurface();
        root.add(surface);
        root.destroy();

        root.update(makeState());

        expect(calls.filter(call => call === 'update')).toHaveLength(0);
    });

    it('keeps a failing surface from silencing the rest', () => {
        // A surface that throws mid-update must not stop the connection dot from
        // reporting that the socket dropped.
        const root = createUiRoot(makeUiRootElement());
        const broken: Surface = {
            mount: parent => parent.appendChild(document.createElement('div')),
            update: () => {
                throw new Error('render failed');
            },
            destroy: () => {}
        };
        const healthy = fakeSurface();
        root.add(broken);
        root.add(healthy.surface);

        expect(() => root.update(makeState())).not.toThrow();
        expect(healthy.calls).toContain('update');
    });
});
