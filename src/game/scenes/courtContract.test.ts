/**
 * The scene draws what the pure layer decided — all of it.
 *
 * This repo has now shipped the same bug three times, and it is invisible to
 * every other kind of test because both halves are individually correct:
 *
 *  - `fitPips` searched for a pip size that provably fit, and `drawSeat`
 *    reinvented the packing with its own 18px step and a hardcoded 12px.
 *  - `computeLayout` sized the nickname from the chip while `drawSeat` pinned
 *    the devotion-token row to a literal `y + 26`, so the name's scrim was
 *    painted over the tokens on every display larger than a phone.
 *  - `dimCaption` computed "must play The First Speaker", `renderPlan.test.ts`
 *    asserted it, and nothing drew it — under a comment claiming it did.
 *
 * A pure test cannot catch any of these: `computeLayout` and `buildRenderPlan`
 * are right in all three. What is wrong is that the scene ignored them. So this
 * reads `Court.ts` as text, the way `client/__tests__/purity.test.ts` does, and
 * asks one question of every field the pure layer publishes — does the scene
 * mention it at all?
 *
 * It is a crude question and it is the right one. Drawing a field correctly is
 * not something source text can prove; never drawing it is exactly what source
 * text can prove, and that is the failure that keeps happening.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCENE_DIR = join(import.meta.dirname, '.');
const LAYOUT_DIR = join(import.meta.dirname, '..', '..', 'client', 'layout');

const courtSource = readFileSync(join(SCENE_DIR, 'Court.ts'), 'utf8');

/** Field names declared by one `interface Name { ... }` block. */
function fieldsOf(source: string, interfaceName: string): string[] {
    const start = source.indexOf(`interface ${interfaceName} {`);
    if (start === -1) throw new Error(`no interface ${interfaceName} — did it get renamed?`);

    const open = source.indexOf('{', start);
    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) {
            end = i;
            break;
        }
    }

    const body = source.slice(open + 1, end);
    // `readonly name:` at the top level of the block. Nested object literals in
    // a field's type declare no fields of their own that the scene names.
    return [...body.matchAll(/^\s{4}readonly (\w+)[?]?:/gm)].map(match => match[1]);
}

/**
 * Fields the pure layer publishes that the scene deliberately does not draw.
 *
 * Each needs a reason. An entry added without one is how this test stops
 * working — the allowlist is the only thing standing between it and a rubber
 * stamp.
 */
const NOT_DRAWN: Readonly<Record<string, string>> = {
    // UIX §6.2 keeps the running total in the seat dossier: the chip carries
    // every discard as a pip, and a total beside them would be a second reading
    // of data already fully shown. `seatDossier.ts` renders it.
    'SeatPlan.discardTotal': 'shown in the seat dossier, not on the chip',
    // Consumed through `pipBlockHeight(pip)`, which the scene calls and which
    // reads `rows` itself. Naming it here too would be re-deriving the packing,
    // which is the first bug in the list above.
    'PipSpec.rows': 'read by pipBlockHeight, which the scene calls'
};

const SOURCES = [
    { file: 'renderPlan.ts', interfaces: ['SeatPlan', 'HandCardPlan', 'OwnStatusPlan', 'DeckPlan', 'BannerPlan'] },
    { file: 'types.ts', interfaces: ['ChipSpec', 'PipSpec', 'OwnRowSpec'] }
] as const;

describe('every field the pure layer publishes reaches the scene', () => {
    for (const { file, interfaces } of SOURCES) {
        const source = readFileSync(join(LAYOUT_DIR, file), 'utf8');

        for (const name of interfaces) {
            it(`draws every field of ${name}`, () => {
                const fields = fieldsOf(source, name);
                expect(fields.length, `${name} declared no fields — the parser drifted`).toBeGreaterThan(0);

                for (const field of fields) {
                    if (`${name}.${field}` in NOT_DRAWN) continue;
                    expect(
                        courtSource.includes(`.${field}`),
                        `${name}.${field} is computed and tested but Court.ts never reads it. ` +
                            `Draw it, or add it to NOT_DRAWN with the reason.`
                    ).toBe(true);
                }
            });
        }
    }
});

/**
 * Nothing on the table may animate forever.
 *
 * `Court.isAnimating()` is true while any tween is live, and the render pump
 * cannot stop the loop while it is — so one endless tween holds a turn-based
 * card game at the display's refresh rate for as long as it runs. The deck's
 * warning pulse was written `repeat: -1` and did exactly that for the back half
 * of every round.
 */
describe('no animation runs without end', () => {
    it('never asks a tween to repeat forever', () => {
        // Code only. Unlike `purity.test.ts`, where a comment naming a banned
        // global is itself the smell, the comments here are the record of why
        // the endless version was removed — worth keeping, and not a violation.
        const offenders = courtSource
            .split('\n')
            .map((line, index) => ({ line: line.trim(), number: index + 1 }))
            .filter(({ line }) => !line.startsWith('*') && !line.startsWith('//') && !line.startsWith('/*'))
            .filter(({ line }) => /repeat:\s*-1/.test(line));

        expect(
            offenders.map(o => `Court.ts:${o.number}`),
            'an endless tween keeps isAnimating() true, so the render loop can never sleep'
        ).toEqual([]);
    });

    it('still pulses the deck, so its state is not colour alone', () => {
        // UIX §6.3. Bounding the pulse must not quietly delete it.
        expect(courtSource).toContain('DECK_PULSE_REPEATS_STRONG');
        expect(courtSource).toContain('plan.deck.pulse');
    });
});

describe('the scene does not re-derive chip geometry', () => {
    /** `drawSeat`'s body, where the collision lived. */
    function drawSeatBody(): string {
        const start = courtSource.indexOf('private drawSeat(');
        expect(start, 'drawSeat was renamed').toBeGreaterThan(-1);
        const end = courtSource.indexOf('\n    private ', start + 1);
        return courtSource.slice(start, end === -1 ? undefined : end);
    }

    it('positions the token row from the spec rather than a literal offset', () => {
        const body = drawSeatBody();
        expect(body).toContain('chip.tokenTop');
        // The offset that buried the tokens. Named explicitly because a plain
        // "no magic numbers" rule would fail on the stroke widths and alphas
        // that legitimately live here.
        expect(body).not.toMatch(/seat\.rect\.y \+ 26\b/);
    });

    it('takes the nickname size and the pip top from the spec too', () => {
        const body = drawSeatBody();
        expect(body).toContain('chip.nameH');
        expect(body).toContain('chip.pipTop');
    });

    it('positions the peek marker and the state caption from the spec', () => {
        // The caption was drawn at `seat.rect.h - 16` while the pip block was
        // measured up from the bottom edge, so it landed inside the discard
        // values at every viewport — reported as the protected text sitting on
        // an opponent's discard.
        const body = drawSeatBody();
        expect(body).toContain('chip.markerTop');
        expect(body).toContain('chip.captionTop');
        expect(body).not.toMatch(/seat\.rect\.h - 16\b/);
    });
});
