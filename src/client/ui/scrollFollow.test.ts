// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { FOLLOWING, anchorOf, applyAnchor, isAtBottom, scrollTopFor } from './scrollFollow';

/** jsdom has no layout, so a scroll container's metrics are stated outright. */
function box(options: { top?: number; clientHeight?: number; scrollHeight?: number } = {}): HTMLElement {
    const element = document.createElement('div');
    Object.defineProperty(element, 'clientHeight', { value: options.clientHeight ?? 100, configurable: true });
    Object.defineProperty(element, 'scrollHeight', { value: options.scrollHeight ?? 500, configurable: true });
    element.scrollTop = options.top ?? 0;
    return element;
}

describe('isAtBottom', () => {
    it('is true resting exactly on the last pixel', () => {
        expect(isAtBottom(400, 100, 500)).toBe(true);
    });

    /**
     * Fractional device pixel ratios and zoom leave `scrollTop` a hair short of
     * the arithmetic bottom, so an exact comparison reads a pinned log as
     * scrolled and quietly stops following.
     */
    it('tolerates a sub-pixel gap left by zoom', () => {
        expect(isAtBottom(399.5, 100, 500)).toBe(true);
    });

    it('is false once the reader has actually scrolled up', () => {
        expect(isAtBottom(120, 100, 500)).toBe(false);
    });

    it('is true when the content does not fill the box', () => {
        // Nothing to scroll: a short log is at its own bottom.
        expect(isAtBottom(0, 500, 120)).toBe(true);
    });
});

describe('anchorOf', () => {
    it('follows when there is no container yet, so a log opens on its newest line', () => {
        expect(anchorOf(null)).toEqual(FOLLOWING);
    });

    it('records a reader who has scrolled up, and stops following', () => {
        expect(anchorOf(box({ top: 120 }))).toEqual({ top: 120, pinnedToBottom: false });
    });

    it('keeps following a reader resting at the bottom', () => {
        expect(anchorOf(box({ top: 400 }))).toEqual({ top: 400, pinnedToBottom: true });
    });
});

describe('scrollTopFor', () => {
    it('pins to the new bottom, not the old one', () => {
        // The whole point: the container grew, and a follower goes with it.
        expect(scrollTopFor({ top: 400, pinnedToBottom: true }, 100, 900)).toBe(800);
    });

    it('never returns a negative top when the content is shorter than the box', () => {
        expect(scrollTopFor({ top: 0, pinnedToBottom: true }, 500, 120)).toBe(0);
    });

    it('holds a scrolled reader exactly where they were', () => {
        expect(scrollTopFor({ top: 120, pinnedToBottom: false }, 100, 900)).toBe(120);
    });
});

describe('applyAnchor', () => {
    it('moves a follower to the bottom of the rebuilt container', () => {
        const element = box({ top: 0, clientHeight: 100, scrollHeight: 900 });
        applyAnchor(element, { top: 400, pinnedToBottom: true });
        expect(element.scrollTop).toBe(800);
    });

    it('puts a scrolled reader back', () => {
        const element = box({ top: 0, clientHeight: 100, scrollHeight: 900 });
        applyAnchor(element, { top: 120, pinnedToBottom: false });
        expect(element.scrollTop).toBe(120);
    });
});
