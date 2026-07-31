// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { IconName } from './icons';
import { iconElement, iconSvg } from './icons';

const ALL: IconName[] = ['shield', 'skull', 'hourglass', 'crown', 'token', 'robot'];

describe('every icon', () => {
    it.each(ALL)('%s draws something', name => {
        expect(iconSvg(name)).toContain('<svg');
        expect(iconElement(name).childNodes.length).toBeGreaterThan(0);
    });

    it.each(ALL)('%s is hidden from the accessibility tree', name => {
        // The meaning lives in adjacent text; the glyph only repeats it.
        expect(iconElement(name).getAttribute('aria-hidden')).toBe('true');
        expect(iconSvg(name)).toContain('aria-hidden="true"');
    });

    it.each(ALL)('%s is not a tab stop', name => {
        // SVG is focusable by default in some browsers, which would put an
        // unlabelled stop in the middle of a seat row.
        expect(iconElement(name).getAttribute('focusable')).toBe('false');
    });

    it.each(ALL)('%s takes its colour from the text beside it', name => {
        expect(iconElement(name).getAttribute('stroke')).toBe('currentColor');
    });

    it.each(ALL)('%s scales with the text beside it', name => {
        expect(iconElement(name).getAttribute('width')).toBe('1em');
    });
});

describe('the element form', () => {
    it('builds a real SVG element, not an HTML one', () => {
        expect(iconElement('crown').namespaceURI).toBe('http://www.w3.org/2000/svg');
    });

    it('carries no text, so it can never be read aloud as a word', () => {
        expect(iconElement('skull').textContent).toBe('');
    });
});
