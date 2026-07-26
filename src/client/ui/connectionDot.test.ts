// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ConnectionStatus, Screen } from '../store/types';
import { makeState, makeUiRootElement } from './__fixtures__/dom';
import { createConnectionDot } from './connectionDot';

function mounted() {
    const root = makeUiRootElement();
    const dot = createConnectionDot();
    dot.mount(root);
    return { root, dot, element: () => root.querySelector('[data-role="connection"]') as HTMLElement };
}

describe('the connection dot', () => {
    it.each([
        ['connecting', 'Connecting'],
        ['open', 'Connected'],
        ['reconnecting', 'Reconnecting'],
        ['closed', 'Disconnected']
    ] as const)('names the %s state as "%s"', (connection: ConnectionStatus, expected) => {
        const { dot, element } = mounted();
        dot.update(makeState({ connection }));
        expect(element().getAttribute('aria-label')).toBe(expected);
    });

    it('carries the status as data, so styling never has to parse the label', () => {
        const { dot, element } = mounted();
        dot.update(makeState({ connection: 'reconnecting' }));
        expect(element().getAttribute('data-status')).toBe('reconnecting');
    });

    it('announces a change, because a dropped socket is worth interrupting for', () => {
        expect(mounted().element().getAttribute('role')).toBe('status');
    });

    it.each(['menu', 'joining', 'lobby', 'table', 'fatal'] as const)('renders on the %s screen', (screen: Screen) => {
        // UIX §5: the dot lives in a screen corner on EVERY surface.
        const { dot, element } = mounted();
        dot.update(makeState({ screen, connection: 'open' }));
        expect(element()).not.toBeNull();
    });

    it('holds no visible text, so it never reads as a label beside itself', () => {
        const { dot, element } = mounted();
        dot.update(makeState({ connection: 'open' }));
        expect(element().textContent).toBe('');
    });

    it('removes itself on destroy', () => {
        const { root, dot } = mounted();
        dot.destroy();
        expect(root.querySelector('[data-role="connection"]')).toBeNull();
    });
});
