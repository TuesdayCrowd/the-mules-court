// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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

/**
 * A screen taller than the viewport must still be usable.
 *
 * `.screen` is a centred grid, and a plain `place-content: center` overflows in
 * BOTH directions once the content outgrows the box — the half above the start
 * edge unreachable, because centring pushes it past the scroll origin. The lobby
 * shipped exactly that when the difficulty fieldset arrived: the title and the
 * invite line were cut off the top, Start Match off the bottom, and neither
 * could be scrolled to.
 *
 * jsdom performs no layout, so the overflow itself is invisible here. What is
 * visible is the pair of declarations that prevent it, which is the same bargain
 * every other rendering test in this repo makes: assert the numbers that cause
 * the visual bug.
 */
describe('a screen that outgrows the viewport', () => {
    it('can scroll to what no longer fits', () => {
        const screen = document.createElement('div');
        screen.className = 'screen';
        document.body.appendChild(screen);

        expect(getComputedStyle(screen).overflowY, 'an overflowing screen with no scroll strands its own content').toBe(
            'auto'
        );
    });

    it('falls back to start alignment rather than centring past the top edge', () => {
        // Read from the stylesheet text, not from `getComputedStyle`: jsdom's
        // CSS parser does not implement the `safe` alignment keyword and drops
        // the declaration, so the computed value would report the fallback and
        // prove nothing. The rule's presence is the assertable fact.
        const css = readFileSync('src/client/styles/ui.css', 'utf8');
        const rule = css.slice(css.indexOf('.screen {'), css.indexOf('.screen:empty'));

        expect(rule, '`safe` is what makes overflowing content reachable').toContain('place-content: safe center');
        expect(rule, 'the unprefixed declaration must stay first, as the fallback').toMatch(
            /place-content:\s*center;[\s\S]*place-content:\s*safe center;/
        );
    });
});
