/**
 * The hover lift, held to the two rules that make it safe.
 *
 * jsdom has no layout and evaluates no media query, so nothing here can watch a
 * card rise. What it *can* do is prove the guards are still around the rules —
 * and both guards fail silently in exactly the way a screenshot would not catch:
 * a hover state left stuck to a card on a phone looks like a selection the game
 * does not have, and a lift that ignores `prefers-reduced-motion` looks like
 * nothing at all to the person who reads the code.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Comments removed first, and that is not tidiness either.
 *
 * `table.css` documents this rule at length, and the documentation quotes the
 * very selectors these assertions look for — so a raw read would find `:hover`
 * outside every media query and fail on the paragraph explaining why it must
 * never be there. Braces inside a comment would break the brace matching below
 * for the same reason.
 */
const CSS = readFileSync('src/client/styles/table.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

interface MediaBlock {
    /** Everything between `@media` and the opening brace. */
    readonly prelude: string;
    readonly body: string;
}

/** Every `@media` rule in the sheet, brace-matched rather than regexed. */
function mediaBlocks(): MediaBlock[] {
    const found: MediaBlock[] = [];
    let from = 0;

    for (;;) {
        const at = CSS.indexOf('@media', from);
        if (at === -1) return found;

        const open = CSS.indexOf('{', at);
        if (open === -1) return found;

        let depth = 0;
        let end = CSS.length - 1;
        for (let i = open; i < CSS.length; i += 1) {
            if (CSS[i] === '{') depth += 1;
            if (CSS[i] === '}') {
                depth -= 1;
                if (depth === 0) {
                    end = i;
                    break;
                }
            }
        }

        found.push({ prelude: CSS.slice(at + '@media'.length, open).trim(), body: CSS.slice(open + 1, end) });
        from = end + 1;
    }
}

const BLOCKS = mediaBlocks();

function bodiesWhere(predicate: (prelude: string) => boolean): string {
    return BLOCKS.filter(block => predicate(block.prelude))
        .map(block => block.body)
        .join('\n');
}

/** Rules that apply to every device, whatever it can do — i.e. outside any query. */
function unconditional(): string {
    let stripped = CSS;
    for (const block of BLOCKS) stripped = stripped.replace(block.body, '');
    return stripped;
}

const hoverCapable = (prelude: string) => prelude.includes('hover: hover') && prelude.includes('pointer: fine');
const collapsible = (prelude: string) => prelude.includes('prefers-reduced-motion: no-preference');

describe('the hand-card hover lift', () => {
    it('exists at all', () => {
        const guarded = bodiesWhere(hoverCapable);
        expect(guarded).toContain(':hover');
        expect(guarded).toContain('translateY(-8px)');
    });

    it('never applies to a device that cannot hover', () => {
        // A touch browser matches `:hover` on tap and keeps matching it until
        // something else is touched, so an unguarded rule leaves one card stuck
        // in the air for the rest of the turn.
        expect(unconditional()).not.toContain(':hover');
    });

    it('lifts a playable card further than one a rule forbids', () => {
        const guarded = bodiesWhere(hoverCapable);
        // A dimmed card acknowledges the pointer without inviting a click the
        // game refuses, so both lifts exist and they are not the same lift.
        expect(guarded).toContain('.is-playable:hover');
        expect(guarded).toContain('translateY(-3px)');
        expect(guarded).toContain('translateY(-8px)');
    });

    it('collapses the movement under reduced motion', () => {
        const stillMoving = bodiesWhere(prelude => hoverCapable(prelude) && !collapsible(prelude));
        expect(stillMoving).not.toContain('transform');
        expect(stillMoving).not.toContain('transition');

        // The brightening is deliberately NOT behind the preference: knowing
        // where the pointer is costs no motion, and a reduced-motion player
        // loses nothing by keeping it.
        expect(stillMoving).toContain('opacity');
    });

    it('animates nothing that would cost a layout', () => {
        const guarded = bodiesWhere(hoverCapable);
        // `transform` and `opacity` stay on the compositor; a `filter`, a
        // `box-shadow` or a size change repaints the portrait underneath on
        // every frame of the lift.
        for (const banned of ['filter:', 'box-shadow', 'width:', 'height:', 'margin']) {
            expect(guarded).not.toContain(banned);
        }
    });
});
