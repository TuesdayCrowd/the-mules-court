// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { CardInstanceId, CardTypeId, CardValue, PlayerId, RedactedView } from '../../game/engine';
import { makeView } from '../store/__fixtures__/view';
import type { ViewOverrides } from '../store/__fixtures__/view';
import { fakeTimers, loadRealStyles, makeState, makeTable, makeUiRootElement } from './__fixtures__/dom';
import type { TableDeps } from './table';
import { assetUrl, createTable } from './table';
import { medallionRunWidth, pipBlockHeight, pipFaceHeight, PIP_GAP_PX } from '../layout/tableLayout';
import { BANNER_PLATE_PAD, LABEL_PAD, MIN_BANNER_PX } from '../layout/tableMetrics';
import { portraitPath } from '../content/portraits';

/** A wide desktop viewport — plenty of room, so a chip growing to fit an
 * 8-value pip block (interface rule 7) is never fighting the layout for it. */
const DESKTOP = { w: 1200, h: 900 } as const;

const NICKNAMES = { p1: 'Ana', p2: 'Bayta', p3: 'Toran', p4: 'Magnifico' } as const;

function seat(
    id: PlayerId,
    seatNum: number,
    overrides: Partial<RedactedView['players'][number]> = {}
): RedactedView['players'][number] {
    return {
        id,
        seat: seatNum,
        tokens: 0,
        alive: true,
        protected: false,
        discardPile: [],
        discardValueTotal: 0,
        ...overrides
    };
}

/** A four-player view (three opponents), seen from p1, with every seat's state controllable. */
function fourPlayerView(
    overrides: ViewOverrides = {},
    players: RedactedView['players'] = [seat('p1', 0), seat('p2', 1), seat('p3', 2), seat('p4', 3)]
): RedactedView {
    const base = makeView(overrides);
    const { own: _own, players: _players, ...rest } = overrides;
    return { ...base, playerCount: 4, players, ...rest };
}

function harness(viewport: { w: number; h: number } = DESKTOP) {
    const root = makeUiRootElement();
    const selected: CardInstanceId[] = [];
    const seatsSelected: PlayerId[] = [];
    const tokensSelected: PlayerId[] = [];
    const hinted: Array<{ cardId: CardTypeId; at: { x: number; y: number } }> = [];
    let hintsCleared = 0;
    const clock = fakeTimers();

    const deps: TableDeps = {
        onCardSelected: id => selected.push(id),
        onCardHinted: (cardId, at) => hinted.push({ cardId, at }),
        onCardHintCleared: () => {
            hintsCleared++;
        },
        onSeatSelected: id => seatsSelected.push(id),
        onTokensSelected: id => tokensSelected.push(id),
        viewport: () => viewport,
        timers: clock.timers
    };

    const table = createTable(deps);
    table.mount(root);

    return {
        root,
        table,
        clock,
        selected,
        seatsSelected,
        tokensSelected,
        hinted,
        hintsCleared: () => hintsCleared,
        driveView(view: RedactedView, overrides: Parameters<typeof makeTable>[0] = {}) {
            table.update(
                makeState({
                    screen: 'table',
                    table: makeTable({ view, nicknames: NICKNAMES, ...overrides })
                })
            );
        }
    };
}

function seatWraps(root: HTMLElement): HTMLElement[] {
    return [...root.querySelectorAll('[data-role="seat-chip"]')] as HTMLElement[];
}

/** Finds the seat chip by the nickname drawn on it — the same name a player reads. */
function seatWrapNamed(root: HTMLElement, nickname: string): HTMLElement {
    const wrap = seatWraps(root).find(w => w.querySelector('.tbl-seat-name')?.textContent === nickname);
    if (wrap === undefined) throw new Error(`no seat chip named "${nickname}"`);
    return wrap;
}

const click = (el: Element | null) => (el as HTMLButtonElement).click();

const pxOf = (value: string) => Number.parseFloat(value);

/** The scale a shrink-to-fit pass applied, or `null` if it applied none. */
function scaleOf(el: HTMLElement): number | null {
    const match = /^scale\(([\d.]+)\)$/.exec(el.style.transform);
    return match === null ? null : Number.parseFloat(match[1]);
}

/**
 * How wide the stubbed measurement below reports one character to be.
 *
 * Any constant would do; what matters is that it is bigger than zero, which
 * is what jsdom reports for `offsetWidth` on every element in the document
 * because it performs no layout at all. A shrink-to-fit pass measured against
 * zero never fires, so a test that let jsdom answer would assert that nothing
 * happens and pass whether or not the renderer is correct — the exact way
 * every text-overrun defect on this table reached a real match unnoticed.
 */
const PX_PER_CHAR = 10;

/**
 * Runs `body` with `offsetWidth` reporting a width proportional to the text an
 * element actually holds, then puts jsdom's own back.
 *
 * The stub is on `HTMLElement.prototype`, because the elements being measured
 * are created inside `draw()` and there is no handle on them until after the
 * fits have already run.
 */
function withTextMeasurement<T>(body: () => T): T {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
        configurable: true,
        get(this: HTMLElement) {
            return (this.textContent ?? '').length * PX_PER_CHAR;
        }
    });
    try {
        return body();
    } finally {
        if (original === undefined) delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth;
        else Object.defineProperty(HTMLElement.prototype, 'offsetWidth', original);
    }
}

/** The width the stub above reports for an element's own text. */
const measured = (el: HTMLElement) => (el.textContent ?? '').length * PX_PER_CHAR;

/**
 * The viewports every geometry sweep below runs at.
 *
 * The same four `discard pips stay within their chip` already sweeps: the
 * smallest phone the design supports, a common one, that phone rotated (the
 * class with the tightest vertical budget), and a desktop.
 */
const SWEEP = [
    { name: 'small phone', w: 320, h: 568 },
    { name: 'phone', w: 390, h: 844 },
    { name: 'rotated phone', w: 844, h: 390 },
    { name: 'desktop', w: 1200, h: 900 }
] as const;

describe('seats', () => {
    it('renders every opponent with its identity and state', () => {
        const h = harness();
        h.driveView(
            fourPlayerView(
                {},
                [
                    seat('p1', 0),
                    seat('p2', 1), // idle: not current, not protected, alive
                    seat('p3', 2, { protected: true }),
                    seat('p4', 3, { alive: false, discardPile: [{ cardId: 'mule', value: 8 }], discardValueTotal: 8 })
                ]
            )
        );

        expect(seatWraps(h.root)).toHaveLength(3); // the viewer is never drawn as a seat chip

        const bayta = seatWrapNamed(h.root, 'Bayta').querySelector('.tbl-seat-hit') as HTMLElement;
        expect(bayta.dataset.state).toBe('idle');

        const toran = seatWrapNamed(h.root, 'Toran').querySelector('.tbl-seat-hit') as HTMLElement;
        expect(toran.dataset.state).toBe('protected');

        const magnifico = seatWrapNamed(h.root, 'Magnifico').querySelector('.tbl-seat-hit') as HTMLElement;
        expect(magnifico.dataset.state).toBe('eliminated');
    });

    it('marks the current player distinctly from the others', () => {
        const h = harness();
        h.driveView(fourPlayerView({ currentPlayerId: 'p2' as PlayerId }));

        const bayta = seatWrapNamed(h.root, 'Bayta').querySelector('.tbl-seat-hit') as HTMLElement;
        expect(bayta.dataset.state).toBe('current');
    });

    it('never truncates a discard pile — every pip survives the worst case (interface rule 7)', () => {
        const h = harness();
        const worstCase: ReadonlyArray<{ readonly cardId: CardTypeId; readonly value: CardValue }> = [
            { cardId: 'informant', value: 1 },
            { cardId: 'han-pritcher', value: 2 },
            { cardId: 'bail-channis', value: 2 },
            { cardId: 'ebling-mis', value: 3 },
            { cardId: 'magnifico', value: 3 },
            { cardId: 'shielded-mind', value: 4 },
            { cardId: 'bayta-darell', value: 5 },
            { cardId: 'toran-darell', value: 5 }
        ];
        h.driveView(
            fourPlayerView({}, [
                seat('p1', 0),
                seat('p2', 1, { discardPile: worstCase, discardValueTotal: 25 }),
                seat('p3', 2),
                seat('p4', 3)
            ])
        );

        const pips = seatWrapNamed(h.root, 'Bayta').querySelectorAll('.tbl-seat-pip');
        expect(pips).toHaveLength(8);
        expect([...pips].map(p => p.textContent)).toEqual(['1', '2', '2', '3', '3', '4', '5', '5']);
    });

    it('tapping a seat chip calls onSeatSelected with that seat', () => {
        const h = harness();
        h.driveView(fourPlayerView());

        click(seatWrapNamed(h.root, 'Toran').querySelector('.tbl-seat-hit'));

        expect(h.seatsSelected).toEqual(['p3']);
    });

    it('tapping the medallion run on a seat chip calls onTokensSelected with that seat', () => {
        const h = harness();
        h.driveView(fourPlayerView({}, [seat('p1', 0), seat('p2', 1, { tokens: 3 }), seat('p3', 2), seat('p4', 3)]));

        click(seatWrapNamed(h.root, 'Bayta').querySelector('.tbl-seat-tokens-hit'));

        expect(h.tokensSelected).toEqual(['p2']);
        expect(h.seatsSelected).toEqual([]); // the token run is its own target, not the chip's
    });

    /**
     * The chip's state ring must not eat the coordinate space `ChipSpec` is
     * written in.
     *
     * "Every offset is from the chip's own top edge" (`ChipSpec`'s docblock),
     * and a `border-width: 2px` on the element that holds every chip child
     * makes that false: absolutely positioned children resolve against the
     * padding box, so the whole chip landed 2px down and 2px right inside a
     * box 4px smaller than `seat.rect` — spending two of the six pixels
     * `pipTop` reserves beneath the pip block. jsdom has no layout and cannot
     * see the drift; it can see that the ring is drawn by a property which
     * takes no layout space.
     */
    it('draws its state ring without consuming the chip’s own box', () => {
        loadRealStyles();
        const h = harness();
        h.driveView(fourPlayerView({}, [seat('p1', 0), seat('p2', 1, { protected: true }), seat('p3', 2), seat('p4', 3)]));

        const hit = seatWrapNamed(h.root, 'Bayta').querySelector('.tbl-seat-hit') as HTMLElement;
        const style = getComputedStyle(hit);

        expect(style.borderTopWidth, 'a border shifts every ChipSpec offset by its own width').not.toBe('2px');
        expect(style.outlineWidth).toBe('2px');
        expect(style.outlineStyle).toBe('solid');
        expect(style.outlineOffset, 'the ring belongs on the chip’s own edge, not outside it').toBe('-2px');
        // The state still chooses the colour — UIX §6.3 is never colour alone,
        // but it is never *without* colour either.
        expect(hit.style.outlineColor).not.toBe('');
        expect(hit.style.borderColor).toBe('');
    });

    it('sizes the token tap target to the medallion run the chip actually draws', () => {
        const h = harness();
        h.driveView(fourPlayerView({}, [seat('p1', 0), seat('p2', 1, { tokens: 4 }), seat('p3', 2), seat('p4', 3)]));

        const spec = h.table.currentLayout()!;
        const wrap = seatWrapNamed(h.root, 'Bayta');
        const target = wrap.querySelector('.tbl-seat-tokens-hit') as HTMLElement;
        const medallions = [...wrap.querySelectorAll('.tbl-medallion')] as HTMLElement[];

        expect(medallions, 'four tokens draw four medallions').toHaveLength(4);

        // The run as drawn: from the first medallion's left edge to the last
        // one's right edge. A literal `medallion * 5` missed this by 4px.
        const drawnRun =
            pxOf(medallions[3].style.left) + pxOf(medallions[3].style.width) - pxOf(medallions[0].style.left);
        expect(pxOf(target.style.width)).toBe(drawnRun);
        expect(pxOf(target.style.width)).toBe(medallionRunWidth(spec.chip.medallion));
        expect(target.style.left).toBe(`${spec.chip.pad}px`);
    });
});

describe('own status row', () => {
    /** The viewer with a discard of their own, so the row draws a face and a value plate. */
    function withOwnDiscards(viewport: { w: number; h: number }) {
        const h = harness(viewport);
        h.driveView(
            fourPlayerView({}, [
                seat('p1', 0, {
                    tokens: 1,
                    discardPile: [
                        { cardId: 'informant', value: 1 },
                        { cardId: 'mule', value: 8 }
                    ],
                    discardValueTotal: 9
                }),
                seat('p2', 1),
                seat('p3', 2),
                seat('p4', 3)
            ])
        );
        return h;
    }

    it('tapping its medallion run calls onTokensSelected with the viewer', () => {
        const h = harness();
        h.driveView(fourPlayerView());

        click(h.root.querySelector('.tbl-own-tokens-hit'));

        expect(h.tokensSelected).toEqual(['p1']);
    });

    /**
     * The value plate rides on the bottom of its face — it does not hang below it.
     *
     * `Court.ts:393` draws this rectangle at `faceTop + row.iconH` with
     * `.setOrigin(0, 1)`: bottom-anchored, so the plate sits OVER the face's
     * lower edge and the pair ends exactly where the face ends. Translated to
     * `setRect` the same `y` became a TOP edge, so the plate grew downward out
     * of the row — measurably past `ownStatus.h` at every viewport, and in
     * landscape under the hand cards, which `draw()` appends afterwards.
     *
     * An origin is a property of a canvas draw call; in DOM it is the choice
     * of which edge you anchor from. `.tbl-seat-revealed-value` shipped the
     * same mistranslation as a `translate(100%, 100%)`.
     */
    for (const viewport of SWEEP) {
        it(`keeps each discard's value plate on its face, inside the row, on a ${viewport.name}`, () => {
            const h = withOwnDiscards(viewport);
            const spec = h.table.currentLayout()!;
            const row = spec.ownRow;

            const faces = [...h.root.querySelectorAll('img.tbl-own-discard-face')] as HTMLElement[];
            const plates = [...h.root.querySelectorAll('.tbl-own-discard-plate')] as HTMLElement[];
            expect(faces).toHaveLength(2);
            expect(plates).toHaveLength(2);

            faces.forEach((face, index) => {
                const plate = plates[index];
                // Exactly the budget the spec published — no invented `+ 2`.
                expect(plate.style.height, 'the plate invented a height').toBe(`${row.valuePx}px`);
                expect(plate.style.width).toBe(`${row.iconW}px`);
                expect(plate.style.left).toBe(face.style.left);

                const faceBottom = pxOf(face.style.top) + pxOf(face.style.height);
                const plateBottom = pxOf(plate.style.top) + pxOf(plate.style.height);
                expect(plateBottom, 'the plate hangs below the face instead of riding on it').toBeCloseTo(
                    faceBottom,
                    6
                );
                expect(plateBottom, 'the discard block escapes the row the layout proved empty').toBeLessThanOrEqual(
                    spec.ownStatus.h
                );
            });
        });
    }
});

describe('the hand', () => {
    it('renders every card as a real <button>', () => {
        const h = harness();
        h.driveView(fourPlayerView({ own: { hand: ['informant#1', 'mule#2'], legalPlays: ['informant#1'] } }));

        const cards = h.root.querySelectorAll('[data-role="hand-card"]');
        expect(cards).toHaveLength(2);
        for (const card of cards) expect(card.tagName).toBe('BUTTON');
    });

    it('dims an unplayable card, disables it, and wires its caption by aria-describedby', () => {
        const h = harness();
        h.driveView(fourPlayerView({ own: { hand: ['informant#1', 'mule#2'], legalPlays: ['informant#1'] } }));

        const cards = [...h.root.querySelectorAll('[data-role="hand-card"]')] as HTMLButtonElement[];
        const mule = cards.find(c => c.getAttribute('aria-label')?.includes('The Mule'))!;
        const informant = cards.find(c => c.getAttribute('aria-label')?.includes('Informant'))!;

        expect(mule.getAttribute('aria-disabled')).toBe('true');
        expect(informant.hasAttribute('aria-disabled')).toBe(false);

        const describedBy = mule.getAttribute('aria-describedby');
        expect(describedBy).not.toBeNull();
        const caption = document.getElementById(describedBy!);
        expect(caption).not.toBeNull();
        expect(caption!.textContent).toContain('must play Informant');
    });

    it('leaves a playable card with no aria-describedby caption', () => {
        const h = harness();
        h.driveView(fourPlayerView({ own: { hand: ['informant#1', 'mule#2'], legalPlays: ['informant#1'] } }));

        const informant = [...h.root.querySelectorAll('[data-role="hand-card"]')].find(c =>
            c.getAttribute('aria-label')?.includes('Informant')
        )!;
        expect(informant.hasAttribute('aria-describedby')).toBe(false);
    });

    it('tapping a card calls onCardSelected with its instance id', () => {
        const h = harness();
        h.driveView(fourPlayerView({ own: { hand: ['informant#1', 'mule#2'], legalPlays: ['informant#1', 'mule#2'] } }));

        const informant = [...h.root.querySelectorAll('[data-role="hand-card"]')].find(c =>
            c.getAttribute('aria-label')?.includes('Informant')
        )!;
        click(informant);

        expect(h.selected).toEqual(['informant#1']);
    });

    it('still lets a dimmed card be tapped — reading a card off-turn is not blocked (aria-disabled, not disabled)', () => {
        const h = harness();
        h.driveView(fourPlayerView({ own: { hand: ['informant#1', 'mule#2'], legalPlays: ['informant#1'] } }));

        const mule = [...h.root.querySelectorAll('[data-role="hand-card"]')].find(c =>
            c.getAttribute('aria-label')?.includes('The Mule')
        )! as HTMLButtonElement;

        expect(mule.disabled).toBe(false);
        click(mule);
        expect(h.selected).toEqual(['mule#2']);
    });

    /**
     * The portrait's box is `HandCardPlan.rect`, not its parent's padding box.
     *
     * It was the one image on this table sized by CSS (`width: 100%; height:
     * 100%`), which makes it a function of whatever the button's padding box
     * happens to be — and the playable ring used to shrink that box by 4px in
     * each dimension, so the art jumped and shrank on every turn boundary
     * while `card.rect` never moved.
     */
    it('sizes the hand portrait from the card’s own rect, like every other piece of art', () => {
        const h = harness();
        h.driveView(fourPlayerView({ own: { hand: ['informant#1', 'mule#2'], legalPlays: ['informant#1'] } }));

        const spec = h.table.currentLayout()!;
        const portraits = [...h.root.querySelectorAll('img.tbl-hand-portrait')] as HTMLElement[];
        expect(portraits).toHaveLength(2);

        portraits.forEach((portrait, index) => {
            expect(portrait.style.width).toBe(`${spec.hand[index].w}px`);
            expect(portrait.style.height).toBe(`${spec.hand[index].h}px`);
            expect(portrait.style.left).toBe('0px');
            expect(portrait.style.top).toBe('0px');
        });
    });

    /**
     * Becoming playable must not resize the card.
     *
     * A `border: 2px` on a `box-sizing: border-box` button moves every
     * absolutely positioned child inward by 2px and shrinks `inset: 0` by 4px,
     * so the art and the name strip visibly jumped at the moment a card became
     * playable — on every turn boundary — and the name scrim, placed at
     * `rect.h - nameH`, had its bottom edge clipped by `overflow: hidden`. An
     * outline is not part of layout.
     */
    it('rings a playable card without taking layout space from it', () => {
        loadRealStyles();
        const h = harness();
        h.driveView(fourPlayerView({ own: { hand: ['informant#1', 'mule#2'], legalPlays: ['informant#1'] } }));

        const playable = [...h.root.querySelectorAll('[data-role="hand-card"].is-playable')] as HTMLElement[];
        expect(playable, 'no playable card rendered — the fixture drifted').toHaveLength(1);

        const style = getComputedStyle(playable[0]);
        expect(style.borderTopWidth, 'a border shrinks the box every child is placed in').not.toBe('2px');
        expect(style.outlineWidth).toBe('2px');
        expect(style.outlineOffset).toBe('-2px');
    });
});

describe('the deck and the banner', () => {
    it('renders the deck count', () => {
        const h = harness();
        h.driveView(fourPlayerView({ deckCount: 12 }));

        const deck = h.root.querySelector('[data-role="deck"]')!;
        expect(deck.querySelector('.tbl-deck-count')!.textContent).toBe('12');
    });

    it("renders a banner naming whoever's turn it is", () => {
        const h = harness();
        h.driveView(fourPlayerView({ currentPlayerId: 'p2' as PlayerId }));

        const banner = h.root.querySelector('[data-role="banner"]')!;
        expect(banner.querySelector('.tbl-banner-plate')!.textContent).toContain('Bayta');
    });

    it('names the viewer directly when it is their own turn', () => {
        const h = harness();
        h.driveView(fourPlayerView({ currentPlayerId: 'p1' as PlayerId }));

        const banner = h.root.querySelector('[data-role="banner"]')!;
        expect(banner.querySelector('.tbl-banner-plate')!.textContent).toBe('Your turn');
    });

    /**
     * The banner plate's height is its font plus its own padding — and that
     * total has to fit `BannerPlan.rect.h`.
     *
     * `Court.ts` sized the text at `0.7 × h` and clamped the plate SEPARATELY,
     * so a short band gave a short plate and the words never lost pixels. In
     * DOM the padding is part of the same box: at `0.7 × h` plus 14px of
     * padding (plus a `line-height: normal` line box of about 1.2 ×) the plate
     * was larger than its band at every viewport a phone has, and the
     * `max-height: 100%` that was supposed to save it only clipped the glyphs
     * inside their own plate instead.
     *
     * jsdom cannot lay the text out, but the arithmetic that decides all of
     * this is `fontSize + BANNER_PLATE_PAD` against `banner.rect.h`, and that
     * it can check — provided `line-height` really is 1, which is what makes
     * the line box the font size.
     */
    for (const viewport of SWEEP) {
        it(`fits the banner plate, padding included, inside its band on a ${viewport.name}`, () => {
            loadRealStyles();
            const h = harness(viewport);
            h.driveView(fourPlayerView({ currentPlayerId: 'p1' as PlayerId }));

            const spec = h.table.currentLayout()!;
            const plate = h.root.querySelector('.tbl-banner-plate') as HTMLElement;
            const fontPx = pxOf(plate.style.fontSize);
            const style = getComputedStyle(plate);

            expect(style.lineHeight, 'a 1.2× line box puts the plate outside its band again').toBe('1');
            expect(style.maxHeight, 'capping the padded box clips the words rather than shrinking them').toBe('none');

            if (fontPx > MIN_BANNER_PX) {
                expect(fontPx + BANNER_PLATE_PAD, 'the plate overflows the band the layout gave it').toBeLessThanOrEqual(
                    spec.banner.h
                );
            } else {
                // The legibility floor is what binds, the same trade
                // `MIN_PIP_PX` makes: a bounded overflow beats an illegible
                // banner, and beats clipping the words outright.
                expect(fontPx).toBe(MIN_BANNER_PX);
            }
        });
    }
});

describe('the removed-card panel', () => {
    function twoPlayerBurn(h: ReturnType<typeof harness>): void {
        const twoPlayer: RedactedView = {
            ...makeView({ setAsideFaceUp: 'mule', removedFaceDownCount: 2 }),
            playerCount: 2,
            players: [seat('p1', 0), seat('p2', 1)]
        };
        h.driveView(twoPlayer, { nicknames: { p1: 'Ana', p2: 'Bayta' } });
    }

    it('appears in a two-player round, where the burn card is shown face up', () => {
        const h = harness();
        const twoPlayer: RedactedView = {
            ...makeView({ setAsideFaceUp: 'mule', removedFaceDownCount: 1 }),
            playerCount: 2,
            players: [seat('p1', 0), seat('p2', 1)]
        };
        h.driveView(twoPlayer, { nicknames: { p1: 'Ana', p2: 'Bayta' } });

        expect(h.root.querySelector('[data-role="removed-card"]')).not.toBeNull();
    });

    /**
     * `contain` is the wrong fit rule for a box that is deliberately not a
     * card's shape.
     *
     * `.tbl-art` argues for `contain` on the grounds that the box and the art
     * disagree by about five per cent — true of a hand card, false on this
     * panel. The face-up card gives its width to the fan (`faceW = panel.w -
     * sliverStep × faceDownCount`) and each sliver is only the edge of a card
     * peeking out, so both boxes run near 0.44 against art at 0.71–0.75.
     * Contained, the card back floated inside its own 1px border with empty
     * box above and below it (reported from a real match), and the burn
     * portrait shrank to a third of its panel while the "Removed" caption and
     * the card's name — both positioned from the BOX — sat on bare table.
     *
     * A two-player round always sets aside two face-down cards, so this panel
     * is never the un-narrowed case.
     */
    it('fills the burn face and its slivers, which are narrower than a card by design', () => {
        loadRealStyles();
        const h = harness();
        twoPlayerBurn(h);

        const face = h.root.querySelector('img.tbl-removed-face') as HTMLElement;
        const slivers = [...h.root.querySelectorAll('img.tbl-removed-sliver')] as HTMLElement[];

        expect(slivers, 'a two-player round fans both face-down removals').toHaveLength(2);
        expect(getComputedStyle(face).objectFit, 'the label bands are placed from the box, so the art must fill it').toBe(
            'cover'
        );
        for (const sliver of slivers) {
            expect(getComputedStyle(sliver).objectFit, 'the card back letterboxes inside its own border').toBe('cover');
        }

        // And the boxes really are the narrow ones the fit rule is about — if
        // the layout ever gave the face a card's aspect, `contain` would be
        // right again and this test should be revisited rather than deleted.
        expect(pxOf(face.style.width) / pxOf(face.style.height)).toBeLessThan(0.75);
    });

    it('is absent in a three-or-four-player round, where nothing is set aside face up', () => {
        const h = harness();
        h.driveView(fourPlayerView({ setAsideFaceUp: null }));

        expect(h.root.querySelector('[data-role="removed-card"]')).toBeNull();
    });
});

describe('chip band heights (defect 1 — the nickname scrim must not paint over the token row)', () => {
    // A large enough viewport that `chip.nameH` clears 60px: `.tbl-seat-name-scrim`
    // is `width: fit-content` with no CSS height, so without an explicit inline
    // height its line-box height (~nameH * 1.2) would exceed the `CHIP_PAD * 2`
    // budget `chipBands` reserved and paint over the devotion tokens below it —
    // the exact regression this project already shipped once (see `ChipSpec`'s
    // own docblock).
    const LARGE = { w: 3840, h: 2400 } as const;

    function twoPlayerProtected(): RedactedView {
        return {
            ...makeView({}),
            playerCount: 2,
            players: [seat('p1', 0), seat('p2', 1, { protected: true })]
        };
    }

    it("sizes the nickname scrim from the real computed spec, not its own text metrics", () => {
        const h = harness(LARGE);
        h.driveView(twoPlayerProtected(), { nicknames: { p1: 'Ana', p2: 'Bayta' } });

        const spec = h.table.currentLayout()!;
        // Sanity check that this viewport actually reproduces the overflow the
        // fix guards against, rather than passing for an unrelated reason.
        expect(spec.chip.nameH).toBeGreaterThan(60);

        const scrim = seatWrapNamed(h.root, 'Bayta').querySelector('.tbl-seat-name-scrim') as HTMLElement;
        expect(scrim.style.height).toBe(`${spec.chip.nameBandH}px`);
    });

    it('sizes a chip line (the peek marker / state caption) from the real computed spec too', () => {
        const h = harness(LARGE);
        h.driveView(twoPlayerProtected(), { nicknames: { p1: 'Ana', p2: 'Bayta' } });

        const spec = h.table.currentLayout()!;
        const line = seatWrapNamed(h.root, 'Bayta').querySelector('.tbl-chip-line') as HTMLElement;
        expect(line).not.toBeNull();
        expect(line.style.height).toBe(`${spec.chip.smallH}px`);
    });
});

describe('the long-press-to-hint gesture (defect 2 — routed through injected timers)', () => {
    function pointer(type: string, overrides: Partial<PointerEventInit> = {}): PointerEvent {
        return new PointerEvent(type, { pointerType: 'touch', clientX: 10, clientY: 10, ...overrides });
    }

    function informantCard(h: ReturnType<typeof harness>): HTMLButtonElement {
        h.driveView(fourPlayerView({ own: { hand: ['informant#1'], legalPlays: ['informant#1'] } }));
        return [...h.root.querySelectorAll('[data-role="hand-card"]')].find(c =>
            c.getAttribute('aria-label')?.includes('Informant')
        ) as HTMLButtonElement;
    }

    it('fires onCardHinted once the press has been held past LONG_PRESS_MS', () => {
        const h = harness();
        const card = informantCard(h);

        card.dispatchEvent(pointer('pointerdown'));
        expect(h.hinted).toEqual([]); // not yet — the timer has not fired

        h.clock.run();

        expect(h.hinted).toEqual([{ cardId: 'informant', at: { x: 10, y: 10 } }]);
    });

    it('fires onCardSelected instead when the press is released before the timer fires', () => {
        const h = harness();
        const card = informantCard(h);

        card.dispatchEvent(pointer('pointerdown'));
        card.dispatchEvent(pointer('pointerup'));
        card.click();

        expect(h.hinted).toEqual([]);
        expect(h.selected).toEqual(['informant#1']);
    });

    it('suppresses the tap that follows a long-press that has already fired', () => {
        const h = harness();
        const card = informantCard(h);

        card.dispatchEvent(pointer('pointerdown'));
        h.clock.run(); // the long-press resolves and shows the hint
        expect(h.hinted).toHaveLength(1);

        card.click(); // the same gesture's follow-up tap must not also select the card

        expect(h.selected).toEqual([]);
    });
});

describe('lifecycle', () => {
    it('reports no layout before the first table update', () => {
        const h = harness();
        expect(h.table.currentLayout()).toBeNull();
    });

    it('reports the layout it last drew from', () => {
        const h = harness();
        h.driveView(fourPlayerView());
        expect(h.table.currentLayout()).not.toBeNull();
    });

    it('clears its layout and its drawing when the screen leaves the table', () => {
        const h = harness();
        h.driveView(fourPlayerView());
        h.table.update(makeState({ screen: 'lobby' }));

        expect(h.table.currentLayout()).toBeNull();
        expect(h.root.querySelector('[data-role="deck"]')).toBeNull();
    });

    it('removes its own root element on destroy', () => {
        const h = harness();
        h.driveView(fourPlayerView());
        h.table.destroy();

        expect(h.root.querySelector('[data-role="table-host"]')).toBeNull();
    });
});

/**
 * Art is never left at its natural size.
 *
 * An `<img>` with no width or height renders at the pixels the file happens to
 * be — 512×720 for every portrait here — and `object-fit` cannot help, because
 * it only describes how pixels fill a box that has already been sized. The hand
 * portrait shipped exactly that way: it hung off the bottom of the viewport with
 * the card's own name strip stranded across its middle, and no test noticed,
 * because jsdom has no layout and every assertion in this file was about
 * structure.
 *
 * This is the narrowest thing that WOULD have noticed, and it runs against the
 * real stylesheet rather than a stub — the rule under test lives in
 * `table.css`, so asserting it against a fixture would only prove the fixture.
 */
/**
 * Text that will not fit is shrunk — and its backdrop shrinks with it.
 *
 * Four separate defects live here, all the same shape: a string is measured
 * against a budget the pure layer published, and something in the measurement
 * or the clamp is wrong, so a black scrim and a stranger's nickname end up
 * painted over the seat next door or clipped mid-word.
 *
 * jsdom lays out nothing, so `offsetWidth` is 0 for every element and every
 * one of these passes read as "the text fits" — which is precisely why all
 * four reached a real match. `withTextMeasurement` puts a deterministic width
 * behind the measurement so the comparison the renderer makes is the one under
 * test; without it, this whole block would be asserting that nothing happens.
 */
describe('text shrinks to the budget the layout published', () => {
    const PHONE = { w: 390, h: 844 } as const;

    it('scales a card name that overruns its card, and is not clamped into measuring as fitting', () => {
        loadRealStyles();
        const h = harness(PHONE);
        withTextMeasurement(() =>
            h.driveView(fourPlayerView({ own: { hand: ['magnifico#1'], legalPlays: ['magnifico#1'] } }))
        );

        const spec = h.table.currentLayout()!;
        const name = h.root.querySelector('.tbl-card-name') as HTMLElement;
        const available = spec.hand[0].w - LABEL_PAD;

        expect(measured(name), 'the fixture no longer overruns the card — pick a longer name').toBeGreaterThan(
            available
        );
        expect(
            getComputedStyle(name).maxWidth,
            'a clamped box reports the clamped width, so the fit could never fire'
        ).toBe('none');
        expect(scaleOf(name), 'the name ran on past its box to be clipped by overflow: hidden').toBeCloseTo(
            available / measured(name),
            6
        );
    });

    it('scales the caption above a dimmed card the same way', () => {
        const h = harness(PHONE);
        withTextMeasurement(() =>
            h.driveView(fourPlayerView({ own: { hand: ['informant#1', 'mule#2'], legalPlays: ['informant#1'] } }))
        );

        const caption = h.root.querySelector('.tbl-card-overline-text') as HTMLElement;
        expect(caption, 'no caption rendered — the dimmed card drifted').not.toBeNull();
        // `fitOverline` answers 1 for a caption of zero width, so a measurement
        // jsdom could satisfy would leave this at exactly 1 and prove nothing.
        expect(scaleOf(caption)).toBeLessThan(1);
    });

    it('keeps a long nickname and its scrim inside the chip', () => {
        const longest = 'Magnifico Giganticus III'; // 24 chars — the server's nickname cap
        const h = harness(PHONE);
        withTextMeasurement(() =>
            h.driveView(fourPlayerView(), { nicknames: { ...NICKNAMES, p2: longest } })
        );

        const spec = h.table.currentLayout()!;
        const room = spec.opponents[0].w - spec.chip.pad * 2;
        const wrap = seatWrapNamed(h.root, longest);
        const scrim = wrap.querySelector('.tbl-seat-name-scrim') as HTMLElement;
        const name = wrap.querySelector('.tbl-seat-name') as HTMLElement;

        expect(measured(name), 'the fixture fits the chip — this asserts nothing').toBeGreaterThan(room);
        expect(scrim.style.maxWidth, 'the scrim grew with the text, over the seat beside it').toBe(`${room}px`);
        expect(scaleOf(name), 'the nickname was the one chip string with no fit at all').toBeCloseTo(
            room / measured(name),
            6
        );
        expect(getComputedStyle(name).transformOrigin, 'scaled from its centre, it drifts off chip.pad').toContain(
            'left'
        );
    });

    it('keeps a chip line’s scrim inside the chip, not just the words inside the scrim', () => {
        const h = harness(PHONE);
        withTextMeasurement(() =>
            h.driveView(
                fourPlayerView({ revealed: [{ subjectId: 'p2' as PlayerId, cardTypeId: 'first-speaker' }] })
            )
        );

        const spec = h.table.currentLayout()!;
        const room = spec.opponents[0].w - spec.chip.pad * 2;
        const line = seatWrapNamed(h.root, 'Bayta').querySelector('.tbl-chip-line') as HTMLElement;
        const label = line.querySelector('span') as HTMLElement;

        expect(label.textContent).toContain('you know:');
        expect(measured(label)).toBeGreaterThan(room);
        // A transform is a paint-time operation: without this the scrim kept
        // the full unscaled width and ran out of the chip while the words
        // inside it shrank obediently.
        expect(line.style.maxWidth, 'the scrim is unbounded — only its text was clamped').toBe(`${room}px`);
        expect(scaleOf(label)).toBeCloseTo(room / measured(label), 6);
        expect(getComputedStyle(label).transformOrigin).toContain('left');
        expect(getComputedStyle(label).flexShrink, 'a shrunken label measures as fitting').toBe('0');
    });
});

describe('every piece of card art is given a size', () => {
    it('leaves no img at its intrinsic dimensions', () => {
        loadRealStyles();
        const h = harness();
        // A view rich enough to render every art class at once: a held card
        // (the back marker), an eliminated seat (the revealed face), devotion
        // medallions, an own-row discard, and the viewer's own hand.
        h.driveView(
            fourPlayerView({}, [
                seat('p1', 0, { tokens: 2, discardPile: [{ cardId: 'informant', value: 1 }], discardValueTotal: 1 }),
                seat('p2', 1, { tokens: 3 }),
                seat('p3', 2),
                seat('p4', 3, { alive: false, discardPile: [{ cardId: 'mule', value: 8 }], discardValueTotal: 8 })
            ])
        );

        const art = [...h.root.querySelectorAll('img.tbl-art')];
        expect(art.length, 'no art rendered — the query drifted').toBeGreaterThan(0);

        for (const img of art) {
            const style = getComputedStyle(img);
            const named = img.className;
            // Either an explicit rect from `table.ts`, or `100%` from the one
            // class that means "fill your parent". Never `auto`, which is the
            // natural-size default this test exists to forbid.
            expect(style.width, `${named} has no width, so it renders at its natural size`).not.toBe('auto');
            expect(style.width, `${named} has no width, so it renders at its natural size`).not.toBe('');
            expect(style.height, `${named} has no height, so it renders at its natural size`).not.toBe('auto');
            expect(style.height, `${named} has no height, so it renders at its natural size`).not.toBe('');
        }
    });

    /**
     * A square box wants art that fills a square.
     *
     * `ChipSpec.medallion` is an edge length and the renderer honours it, but
     * `misc/devotion_token.png` is 512×720 — a portrait-shaped plaque — so
     * `.tbl-art`'s `contain` painted the token at 71% of its box's width,
     * centred. The run then read as sparse and misaligned, the first
     * medallion's pixels no longer began at `chip.pad`, and both
     * `medallionRunWidth` and the tap target reserved width for squares that
     * were never drawn.
     */
    it('fills a medallion’s square box, which its portrait-shaped art does not do on its own', () => {
        loadRealStyles();
        const h = harness();
        h.driveView(fourPlayerView({}, [seat('p1', 0), seat('p2', 1, { tokens: 2 }), seat('p3', 2), seat('p4', 3)]));

        const medallions = [...h.root.querySelectorAll('img.tbl-medallion')] as HTMLElement[];
        expect(medallions.length).toBeGreaterThan(0);
        for (const medallion of medallions) {
            expect(medallion.style.width).toBe(medallion.style.height); // the spec's edge length, both ways
            expect(getComputedStyle(medallion).objectFit).toBe('cover');
        }
    });

    /**
     * `contain` stays right for the hand portrait — this is the box the rule
     * was reasoned about. Asserted so that "cover on the burn panel" is never
     * generalised into "cover everywhere".
     */
    it('still contains the hand portrait, whose box is a card’s own aspect', () => {
        loadRealStyles();
        const h = harness();
        h.driveView(fourPlayerView({ own: { hand: ['informant#1'], legalPlays: ['informant#1'] } }));

        const portrait = h.root.querySelector('img.tbl-hand-portrait') as HTMLElement;
        expect(getComputedStyle(portrait).objectFit).toBe('contain');
    });
});

/**
 * A hand card is placed from a rect, so it must not also be stretched to fill.
 *
 * `[data-role='hand-card']` shares the `inset: 0` rule with the chip-wide
 * button, and was missing from the `inset: auto` reset the other spec-placed
 * buttons get. That leaves the element over-constrained on both axes once
 * `setRect` writes `left`/`top`/`width`/`height`, and it lands where the layout
 * put it only because CSS resolves the over-constraint by discarding `right`
 * in a left-to-right writing mode. In an RTL document `left` is the one
 * discarded, and every hand card snaps to the right edge of the viewport.
 *
 * jsdom implements no `inset` shorthand at all — it reports `right: auto`
 * either way — so this reads the shipped stylesheet instead of asking the
 * cascade a question it cannot answer.
 */
describe('the reset for elements placed from a spec rect', () => {
    it('covers every element setRect positions, the hand card included', () => {
        const css = readFileSync('src/client/styles/table.css', 'utf8');
        const rule = /([^}]*?)\{\s*inset:\s*auto;\s*\}/.exec(css);

        expect(rule, 'the inset: auto reset is gone — where did it move to?').not.toBeNull();
        for (const selector of ['.tbl-seat-tokens-hit', '.tbl-seat-revealed-hit', '.tbl-own-tokens-hit', "[data-role='hand-card']"]) {
            expect(rule![1], `${selector} is placed from a rect but still stretched by inset: 0`).toContain(selector);
        }
    });
});

/**
 * The discard block stays inside the chip the layout gave it.
 *
 * `chipBands` sets `pipTop = chipH - pipBlockHeight(pip) - CHIP_PAD`, so the
 * block is meant to end exactly `CHIP_PAD` above the chip's bottom edge — six
 * pixels, and no more. Two things ate that margin at once and put discard
 * values on top of the border:
 *
 *   - a pip span's line box is `font-size × line-height`, about 1.2 ×, while
 *     `pipRowHeight` budgets exactly `pip.valuePx` for the value;
 *   - the scrim inflated itself by an invented `-4` top and `+10` height.
 *
 * Both are the shape `courtContract.test.ts` was written for — the renderer
 * disagreeing with the geometry the pure layer already decided — so this
 * asserts the rendered block against the spec rather than against a literal.
 * jsdom has no layout, so it cannot see an overflow; it can see the numbers
 * that cause one.
 *
 * A pip is a card face with its value beneath it now, mirroring the viewer's own
 * row, so the same questions are asked of the face: does every discard have one,
 * is it the right one, and is it given a size rather than left at the 512×720 of
 * the file behind it.
 */
describe('discard pips stay within their chip', () => {
    /**
     * Eight deep, every card different.
     *
     * Eight is the deepest pile the engine can actually produce
     * (`discardCapacity.test.ts` proves it), so it is the worst case the budget
     * has to survive. A real pile of eight repeats cards; this one does not, so
     * a face drawn from the wrong entry cannot pass by coincidence.
     */
    const DEEPEST_PILE: ReadonlyArray<{ readonly cardId: CardTypeId; readonly value: CardValue }> = [
        { cardId: 'informant', value: 1 },
        { cardId: 'han-pritcher', value: 2 },
        { cardId: 'ebling-mis', value: 3 },
        { cardId: 'shielded-mind', value: 4 },
        { cardId: 'bayta-darell', value: 5 },
        { cardId: 'mayor-indbur', value: 6 },
        { cardId: 'first-speaker', value: 7 },
        { cardId: 'mule', value: 8 }
    ];

    function chipFor(nickname: string, viewport: { w: number; h: number } = DESKTOP) {
        const h = harness(viewport);
        h.driveView(
            fourPlayerView({}, [
                seat('p1', 0),
                seat('p2', 1, { discardPile: DEEPEST_PILE, discardValueTotal: 36 }),
                seat('p3', 2),
                seat('p4', 3)
            ])
        );
        return { h, wrap: seatWrapNamed(h.root, nickname) };
    }

    it('gives every pip exactly the row height the block budgets', () => {
        const { h, wrap } = chipFor('Bayta');
        const spec = h.table.currentLayout();
        expect(spec, 'no layout was computed').not.toBeNull();

        const pips = [...wrap.querySelectorAll('.tbl-seat-pip')] as HTMLElement[];
        expect(pips.length, 'interface rule 7: every value, never a truncation').toBe(8);

        for (const pip of pips) {
            expect(pip.style.height, 'a value sized by its own line box overruns the block').toBe(
                `${spec!.pip.valuePx}px`
            );
        }
    });

    it("draws one card face per discard, each showing that discard's own card", () => {
        const { wrap } = chipFor('Bayta');

        const faces = [...wrap.querySelectorAll('img.tbl-seat-pip-face')] as HTMLImageElement[];
        expect(faces, 'a seat chip shows its pile as faces, like the viewer’s own row').toHaveLength(8);
        expect(faces.map(face => face.getAttribute('src'))).toEqual(
            DEEPEST_PILE.map(discard => assetUrl(portraitPath(discard.cardId)))
        );
    });

    it('gives every face an explicit width and height, never its natural 512×720', () => {
        const { h, wrap } = chipFor('Bayta');
        const spec = h.table.currentLayout()!;

        const faces = [...wrap.querySelectorAll('img.tbl-seat-pip-face')] as HTMLImageElement[];
        for (const face of faces) {
            // `object-fit` cannot rescue an unsized <img>: it only says how the
            // pixels fill a box that has already been sized. Straight from the
            // spec, never from a constant invented here.
            expect(face.style.width, 'an unsized face renders at the pixels the file happens to be').toBe(
                `${spec.pip.size}px`
            );
            expect(face.style.height).toBe(`${pipFaceHeight(spec.pip)}px`);
        }
    });

    it('keeps the face a card rather than a square, and the value legible beside it', () => {
        const { h } = chipFor('Bayta');
        const spec = h.table.currentLayout()!;

        expect(spec.pip.size / pipFaceHeight(spec.pip), 'a stretched face is not the card').toBeCloseTo(0.75, 1);
        // The value is the deduction datum; the face is the aid. If either has
        // to give, it is the face.
        expect(spec.pip.valuePx).toBeGreaterThanOrEqual(10);
    });

    it('draws the scrim at exactly the block the spec reserved', () => {
        const { h, wrap } = chipFor('Bayta');
        const spec = h.table.currentLayout()!;
        const scrim = wrap.querySelector('.tbl-seat-pip-scrim') as HTMLElement;

        expect(scrim, 'no pip scrim rendered').not.toBeNull();
        expect(scrim.style.top, 'the scrim invented a top offset').toBe(`${spec.chip.pipTop}px`);
        expect(scrim.style.height, 'the scrim invented a height').toBe(`${pipBlockHeight(spec.pip)}px`);
    });

    /**
     * The same question one axis over, which the earlier fix did not ask.
     *
     * A row of `n` pips starts at `chip.pad` and its last one ends at `pad +
     * (n - 1) × step + size` — so the block is `n × step - PIP_GAP_PX` wide,
     * and the scrim counted a trailing inter-pip gap the block does not
     * contain. `fitPips` packs the pips against `chip.w × 0.88`, so there is
     * not always three pixels of slack to absorb it: on a three-opponent phone
     * the scrim crossed the chip's own ring while the last pip stopped well
     * short of it.
     */
    for (const viewport of SWEEP) {
        it(`ends the pip scrim exactly one pad past the last pip on a ${viewport.name}`, () => {
            const { h, wrap } = chipFor('Bayta', viewport);
            const spec = h.table.currentLayout()!;
            const scrim = wrap.querySelector('.tbl-seat-pip-scrim') as HTMLElement;

            const faces = [...wrap.querySelectorAll('img.tbl-seat-pip-face')] as HTMLElement[];
            const widest = faces
                .map(face => pxOf(face.style.left) + pxOf(face.style.width))
                .reduce((worst, right) => Math.max(worst, right), 0);

            expect(pxOf(scrim.style.width), 'the scrim backs a wider block than the pips occupy').toBe(
                widest + spec.chip.pad
            );
            expect(pxOf(scrim.style.width), 'the scrim runs out through the chip').toBeLessThanOrEqual(
                pxOf(wrap.style.width)
            );

            // And the width really is the spec's arithmetic, not a coincidence.
            const across = Math.min(8, spec.pip.perRow);
            expect(pxOf(scrim.style.width)).toBe(across * (spec.pip.size + PIP_GAP_PX) - PIP_GAP_PX + spec.chip.pad * 2);
        });
    }

    /**
     * Interface rule 7 at the sizes that test it.
     *
     * Faces are wider than the numerals they replace, so fewer fit per row and
     * the block is taller — which is exactly the pressure that would tempt a
     * renderer into dropping the eighth discard or letting the pile run out
     * through the chip's bottom border. Neither is allowed at any viewport, so
     * the whole worst case is drawn at the smallest screen the layout is swept
     * at as well as at a desktop.
     */
    const VIEWPORTS = [
        { name: 'small phone', w: 320, h: 568 },
        { name: 'phone', w: 390, h: 844 },
        { name: 'rotated phone', w: 844, h: 390 },
        { name: 'desktop', w: 1200, h: 900 }
    ] as const;

    for (const viewport of VIEWPORTS) {
        it(`shows all eight discards, face and value, on a ${viewport.name}`, () => {
            const { wrap } = chipFor('Bayta', viewport);

            expect(wrap.querySelectorAll('img.tbl-seat-pip-face'), 'a face was truncated away').toHaveLength(8);
            expect([...wrap.querySelectorAll('.tbl-seat-pip')].map(pip => pip.textContent)).toEqual([
                '1',
                '2',
                '3',
                '4',
                '5',
                '6',
                '7',
                '8'
            ]);
        });

        it(`ends the block clear of the chip on a ${viewport.name}, which is what CHIP_PAD is for`, () => {
            const { h, wrap } = chipFor('Bayta', viewport);
            const spec = h.table.currentLayout()!;
            const chipH = Number.parseFloat(wrap.style.height);

            const blockBottom = spec.chip.pipTop + pipBlockHeight(spec.pip);
            expect(blockBottom, 'the discard block reaches the chip border').toBeLessThan(chipH);

            // And the drawing agrees with the budget: the lowest thing actually
            // rendered is the last row's value, and it must finish inside the
            // block `chipBands` reserved. A row that stepped by the face's width
            // instead of the row's height would pass every spec-only assertion
            // above and still spill out of the chip.
            const lowest = [...wrap.querySelectorAll('.tbl-seat-pip')]
                .map(pip => Number.parseFloat((pip as HTMLElement).style.top) + Number.parseFloat((pip as HTMLElement).style.height))
                .reduce((worst, bottom) => Math.max(worst, bottom), 0);
            expect(lowest, 'the last row of values overruns the block').toBeLessThanOrEqual(blockBottom);
        });
    }
});
