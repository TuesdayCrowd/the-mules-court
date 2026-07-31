/**
 * The icon set, retiring the emoji placeholders (UIX §12).
 *
 * Inline SVG rather than an icon font or sprite sheet: five glyphs do not earn a
 * second font request, and emoji render differently on every platform — a skull
 * that reads as a warning on one device reads as a cartoon on another.
 *
 * **Every icon is `aria-hidden` and unfocusable.** The meaning always lives in
 * adjacent text: a seat is "Out of the round" in words, and the skull only
 * repeats it. An icon carrying meaning alone would be invisible to a screen
 * reader and ambiguous to everyone else.
 */

export type IconName = 'shield' | 'skull' | 'hourglass' | 'crown' | 'token' | 'robot';

/** Drawn on a 24×24 grid, stroked in `currentColor` so a parent's colour carries. */
const PATHS: Readonly<Record<IconName, string>> = {
    // Protected — cannot be targeted.
    shield: '<path d="M12 3l7 3v6c0 4-3 7.2-7 9-4-1.8-7-5-7-9V6z"/>',
    // Eliminated.
    skull: '<path d="M12 3a7 7 0 0 0-7 7v3l2 2v3h10v-3l2-2v-3a7 7 0 0 0-7-7z"/><circle cx="9.5" cy="11" r="1.4"/><circle cx="14.5" cy="11" r="1.4"/>',
    // Waiting, paused, or reconnecting.
    hourglass: '<path d="M7 3h10M7 21h10M8 3v4l4 5 4-5V3M8 21v-4l4-5 4 5v4"/>',
    // Host.
    crown: '<path d="M4 8l3.5 4L12 5l4.5 7L20 8v10H4z"/>',
    // A devotion token.
    token: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
    // A computer opponent.
    robot: '<path d="M12 2v3"/><rect x="4" y="5" width="16" height="14" rx="3"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><path d="M9.5 16h5"/>'
};

/**
 * An SVG string for `innerHTML`-free insertion.
 *
 * Returned as markup rather than a node because callers build these once at
 * render time; the string contains no interpolated caller input, which is what
 * makes it safe to hand to a parser at all.
 */
export function iconSvg(name: IconName): string {
    return (
        `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" ` +
        `stroke-width="1.6" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name]}</svg>`
    );
}

/**
 * The same icon as a detached element.
 *
 * Preferred at call sites, because it never goes near an HTML parser — the
 * surfaces in this directory write text with `textContent` precisely so that a
 * nickname can never become markup, and an icon helper that reached for
 * `innerHTML` would reopen that door beside them.
 */
export function iconElement(name: IconName): SVGSVGElement {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '1em');
    svg.setAttribute('height', '1em');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linejoin', 'round');
    // Hidden from the tree, and never a tab stop: the words beside it carry the
    // meaning, and SVG is focusable by default in some browsers.
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    const template = document.createElement('template');
    template.innerHTML = `<svg xmlns="${NS}">${PATHS[name]}</svg>`;
    const parsed = template.content.firstElementChild;
    if (parsed !== null) svg.append(...Array.from(parsed.childNodes));

    return svg;
}
