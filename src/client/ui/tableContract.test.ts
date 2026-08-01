/**
 * `table.ts`'s half of the same guarantee `courtContract.test.ts` holds
 * `Court.ts` to — read that file's own docstring first; the reasoning below
 * only covers what differs for a DOM renderer.
 *
 * The bug this repo has shipped three times (see `courtContract.test.ts`'s
 * header) is not particular to Phaser: `computeLayout` and `buildRenderPlan`
 * can be exactly right while whichever scene consumes them simply never
 * reads one of their fields, and a pure test cannot see that — a pure test
 * only ever exercises the pure layer. `table.ts` is a second, independent
 * consumer of the same `RenderPlan`/`LayoutSpec`, so it needs its own copy of
 * this question asked of its own source text: does every field the pure
 * layer publishes reach the DOM at all?
 *
 * One difference from the Phaser original, because a `<div>` is not a
 * `Graphics.rectangle`: there is no `drawSeat`-shaped "did the scene
 * re-derive geometry it should have read" section here. That check greps a
 * named private method for the exact literal offsets a historical bug
 * hardcoded (`seat.rect.y + 26`, `seat.rect.h - 16`); `table.ts` never had
 * those bugs to guard against, and inventing new literals to search for
 * without a reported regression behind them would be exactly the "add an
 * entry without a reason" failure `courtContract.test.ts` warns its own
 * `NOT_DRAWN` about.
 *
 * `ChipSpec.nameBandH` and `.smallH` are NOT in this file's `NOT_DRAWN`, even
 * though `.tbl-seat-name-scrim` and `.tbl-chip-line` are `width: fit-content`
 * in `table.css` and so size their own width from their text. Both scrims
 * still need an explicit *height*: a `fit-content` box with no `height` set
 * takes its line box's height instead, which drifts past the budget
 * `chipBands` reserved for it on a large enough chip — the same collision
 * `ChipSpec`'s own docblock already documents the token row shipping once —
 * so `table.ts` reads both fields to set `style.height` directly.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const UI_DIR = join(import.meta.dirname, '.');
const LAYOUT_DIR = join(import.meta.dirname, '..', 'layout');

const tableSource = readFileSync(join(UI_DIR, 'table.ts'), 'utf8');

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
    // a field's type declare no fields of their own that table.ts names.
    return [...body.matchAll(/^\s{4}readonly (\w+)[?]?:/gm)].map(match => match[1]);
}

/**
 * Fields the pure layer publishes that `table.ts` deliberately does not draw.
 *
 * Each needs a reason. An entry added without one is how this test stops
 * working — the allowlist is the only thing standing between it and a rubber
 * stamp. Both entries are inherited from `courtContract.test.ts`'s own
 * allowlist, unchanged, because the reasons are still true of this renderer.
 */
const NOT_DRAWN: Readonly<Record<string, string>> = {
    // UIX §6.2 keeps the running total in the seat dossier: the chip carries
    // every discard as a pip, and a total beside them would be a second
    // reading of data already fully shown. `seatDossier.ts` renders it.
    'SeatPlan.discardTotal': 'shown in the seat dossier, not on the chip',
    // Consumed through `pipBlockHeight(pip)`, which `draw()` calls and which
    // reads `rows` itself. Naming it here too would be re-deriving the
    // packing, the exact first bug `courtContract.test.ts` lists.
    'PipSpec.rows': 'read by pipBlockHeight, which table.ts calls'
};

const SOURCES = [
    { file: 'renderPlan.ts', interfaces: ['SeatPlan', 'HandCardPlan', 'OwnStatusPlan', 'DeckPlan', 'BannerPlan'] },
    { file: 'types.ts', interfaces: ['ChipSpec', 'PipSpec', 'OwnRowSpec'] }
] as const;

describe('every field the pure layer publishes reaches table.ts', () => {
    for (const { file, interfaces } of SOURCES) {
        const source = readFileSync(join(LAYOUT_DIR, file), 'utf8');

        for (const name of interfaces) {
            it(`draws every field of ${name}`, () => {
                const fields = fieldsOf(source, name);
                expect(fields.length, `${name} declared no fields — the parser drifted`).toBeGreaterThan(0);

                for (const field of fields) {
                    if (`${name}.${field}` in NOT_DRAWN) continue;
                    expect(
                        tableSource.includes(`.${field}`),
                        `${name}.${field} is computed and tested but table.ts never reads it. ` +
                            `Draw it, or add it to NOT_DRAWN with the reason.`
                    ).toBe(true);
                }
            });
        }
    }
});

/**
 * Nothing on the table may animate forever — AGENTS.md's render-loop
 * discipline is stated for the Phaser table, but the underlying reason
 * (an endless animation burns a compositor frame forever for no player
 * benefit) applies just as much to a CSS animation with no scene to sleep at
 * all. `courtContract.test.ts` greps `Court.ts` for a literal `repeat: -1`,
 * the shape the deck's warning pulse broke it with once; this is the same
 * question asked of the DOM analogue, `animationIterationCount: 'infinite'`.
 */
describe('no animation runs without end', () => {
    it('never sets an unbounded animation-iteration-count', () => {
        const offenders = tableSource
            .split('\n')
            .map((line, index) => ({ line: line.trim(), number: index + 1 }))
            .filter(({ line }) => !line.startsWith('*') && !line.startsWith('//') && !line.startsWith('/*'))
            .filter(({ line }) => /animationIterationCount\s*[:=]\s*['"]infinite['"]/.test(line));

        expect(
            offenders.map(o => `table.ts:${o.number}`),
            "an endless animation is this renderer's shape of the repeat: -1 bug — see this file's own header"
        ).toEqual([]);
    });

    it('still pulses the deck, so its state is not colour alone', () => {
        // UIX §6.3. Bounding the pulse must not quietly delete it.
        expect(tableSource).toContain('DECK_PULSE_REPEATS_STRONG');
        expect(tableSource).toContain('deck.pulse');
    });
});
