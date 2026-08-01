// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { CardInstanceId, CardTypeId, CardValue, PlayerId, RedactedView } from '../../game/engine';
import { makeView } from '../store/__fixtures__/view';
import type { ViewOverrides } from '../store/__fixtures__/view';
import { fakeTimers, loadRealStyles, makeState, makeTable, makeUiRootElement } from './__fixtures__/dom';
import type { TableDeps } from './table';
import { createTable } from './table';

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
});

describe('own status row', () => {
    it('tapping its medallion run calls onTokensSelected with the viewer', () => {
        const h = harness();
        h.driveView(fourPlayerView());

        click(h.root.querySelector('.tbl-own-tokens-hit'));

        expect(h.tokensSelected).toEqual(['p1']);
    });
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
});

describe('the removed-card panel', () => {
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
});
