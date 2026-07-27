// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { RedactedView } from '../../game/engine';
import { computeLayout } from '../layout/tableLayout';
import type { LayoutSpec } from '../layout/types';
import { makeView } from '../store/__fixtures__/view';
import type { ViewOverrides } from '../store/__fixtures__/view';
import { loadRealStyles, makeState, makeTable } from './__fixtures__/dom';
import { createA11yTwin } from './a11yTwin';

const LAYOUT: LayoutSpec = computeLayout({
    w: 390,
    h: 844,
    opponentCount: 1,
    handCount: 2,
    showsRemovedCard: false,
    maxDiscards: 2
});

beforeEach(() => {
    loadRealStyles();
});

function viewWithSeats(overrides: ViewOverrides = {}): RedactedView {
    const base = makeView(overrides);
    // `own` is already merged by makeView; re-spreading the partial here would
    // put its optional fields back and undo that.
    const { own: _merged, ...rest } = overrides;
    return {
        ...base,
        players: [
            {
                id: 'p1',
                seat: 0,
                tokens: 2,
                alive: true,
                protected: false,
                discardPile: [{ cardId: 'informant', value: 1 }],
                discardValueTotal: 1
            },
            {
                id: 'p2',
                seat: 1,
                tokens: 0,
                alive: false,
                protected: false,
                discardPile: [],
                discardValueTotal: 0
            }
        ],
        ...rest
    };
}

function mounted(view: RedactedView = viewWithSeats(), layout: LayoutSpec | null = LAYOUT) {
    document.body.innerHTML = '<div id="a11y-twin"></div>';
    const host = document.getElementById('a11y-twin') as HTMLElement;

    const twin = createA11yTwin({ layout: () => layout });
    twin.mount(host);
    twin.update(makeState({ screen: 'table', table: makeTable({ view }) }));

    return {
        host,
        twin,
        seats: () => [...host.querySelectorAll('[data-twin="seat"]')],
        cards: () => [...host.querySelectorAll('[data-twin="hand"]')] as HTMLButtonElement[],
        shadows: () => [...host.querySelectorAll('[data-twin]')]
    };
}

describe('the per-seat status list', () => {
    it('gives one item per seat', () => {
        expect(mounted().seats()).toHaveLength(2);
    });

    it('names the seat, its tokens, its status, and its discard total', () => {
        const text = mounted().seats()[0].textContent ?? '';
        expect(text).toContain('Ana');
        expect(text).toContain('2');
        expect(text).toContain('In the round');
        expect(text).toContain('1');
    });

    it('says when a seat is out', () => {
        expect(mounted().seats()[1].textContent).toContain('Out of the round');
    });

    it('says when a seat is protected', () => {
        const view = viewWithSeats();
        const ui = mounted({ ...view, players: [{ ...view.players[0], protected: true }, view.players[1]] });
        expect(ui.seats()[0].textContent).toContain('Protected');
    });

    it('marks the seat holding the turn', () => {
        expect(mounted(viewWithSeats({ currentPlayerId: 'p1' })).seats()[0].textContent).toContain('their turn');
    });

    it('renders a hostile nickname as text', () => {
        const ui = mounted();
        ui.twin.update(
            makeState({
                screen: 'table',
                table: makeTable({ view: viewWithSeats(), nicknames: { p1: '<img src=x onerror=alert(1)>', p2: 'Bayta' } })
            })
        );
        expect(ui.host.querySelector('img')).toBeNull();
    });

    it('re-renders on each snapshot', () => {
        const ui = mounted();
        const view = viewWithSeats();

        ui.twin.update(
            makeState({
                screen: 'table',
                table: makeTable({
                    view: { ...view, players: [{ ...view.players[0], tokens: 5 }, view.players[1]] }
                })
            })
        );

        expect(ui.seats()[0].textContent).toContain('5');
    });
});

describe('hand proxies', () => {
    it('gives one focusable proxy per held card', () => {
        const ui = mounted(viewWithSeats({ own: { playerId: 'p1', hand: ['informant#1', 'mule#2'], legalPlays: [] } }));
        expect(ui.cards()).toHaveLength(2);
        for (const card of ui.cards()) expect(card.tagName).toBe('BUTTON');
    });

    it('names the card it stands for — the viewer’s own hand is theirs to know', () => {
        const ui = mounted(viewWithSeats({ own: { playerId: 'p1', hand: ['mule#2'], legalPlays: [] } }));
        expect(ui.cards()[0].textContent).toContain('The Mule');
    });

    it('says whether the card can be played right now', () => {
        const ui = mounted(
            viewWithSeats({ own: { playerId: 'p1', hand: ['informant#1', 'mule#2'], legalPlays: ['informant#1'] } })
        );
        expect(ui.cards()[0].textContent).toContain('playable');
        expect(ui.cards()[1].textContent).not.toContain('playable');
    });

    it('sits where the LayoutSpec put the canvas card', () => {
        // Positioned from the same spec that placed the sprite, so an iOS touch
        // exploration lands on the proxy exactly where the card looks to be.
        const ui = mounted(viewWithSeats({ own: { playerId: 'p1', hand: ['informant#1', 'mule#2'], legalPlays: [] } }));

        expect(ui.cards()[0].style.left).toBe(`${LAYOUT.hand[0].x}px`);
        expect(ui.cards()[0].style.top).toBe(`${LAYOUT.hand[0].y}px`);
        expect(ui.cards()[1].style.left).toBe(`${LAYOUT.hand[1].x}px`);
    });

    it('renders no proxy when the layout has not been computed yet', () => {
        const ui = mounted(viewWithSeats({ own: { playerId: 'p1', hand: ['informant#1'], legalPlays: [] } }), null);
        expect(ui.cards()).toEqual([]);
        expect(ui.seats()).toHaveLength(2); // the seat list does not need geometry
    });

    it('renders no proxy for a hand the layout has no slot for', () => {
        const narrow = computeLayout({ w: 390, h: 844, opponentCount: 1, handCount: 1, showsRemovedCard: false, maxDiscards: 2 });
        const ui = mounted(viewWithSeats({ own: { playerId: 'p1', hand: ['informant#1', 'mule#2'], legalPlays: [] } }), narrow);
        expect(ui.cards()).toHaveLength(1);
    });
});

describe('the removed card', () => {
    it('reports the face-up removed card, which is public deduction data', () => {
        // Two-player rounds remove one card FACE UP (README setup, step 3), and
        // the canvas shows it. Leaving it out of the twin hid a fact from a
        // screen reader that every sighted player could see — and it is a fact
        // worth having, because it is one card the opponent provably lacks.
        const ui = mounted(viewWithSeats({ setAsideFaceUp: 'shielded-mind' }));

        const removed = ui.host.querySelector('[data-twin="removed"]')!;
        expect(removed.textContent).toContain('Shielded Mind');
        expect(removed.textContent).toContain('4');
        expect(removed.textContent).toMatch(/removed from play/i);
    });

    it('counts the face-down removals without naming them', () => {
        // The canvas fans two card backs beside the face-up card; this is the
        // same fact for a reader. The count is public, the faces never are.
        const ui = mounted(viewWithSeats({ setAsideFaceUp: 'shielded-mind', removedFaceDownCount: 2 }));
        expect(ui.host.querySelector('[data-twin="removed"]')!.textContent).toContain('2 more face down');
    });

    it('says nothing about face-down cards when there are none', () => {
        const ui = mounted(viewWithSeats({ setAsideFaceUp: 'shielded-mind', removedFaceDownCount: 0 }));
        expect(ui.host.querySelector('[data-twin="removed"]')!.textContent).not.toMatch(/face down/i);
    });

    it('says nothing at all when no card was removed face up', () => {
        // Three and four player rounds remove nothing face up, and an element
        // announcing "none" would be noise on every turn.
        expect(mounted(viewWithSeats({ setAsideFaceUp: null })).host.querySelector('[data-twin="removed"]')).toBeNull();
    });
});

describe('these are the only shadow elements', () => {
    it('holds exactly one element per seat plus one per hand card', () => {
        // UIX §11 names these the only shadow elements in the app. Asserting the
        // count is what stops a parallel DOM table growing here unnoticed.
        const ui = mounted(viewWithSeats({ own: { playerId: 'p1', hand: ['informant#1', 'mule#2'], legalPlays: [] } }));
        expect(ui.shadows()).toHaveLength(2 + 2);
    });

    it('adds exactly one more for a face-up removed card', () => {
        const ui = mounted(
            viewWithSeats({
                setAsideFaceUp: 'shielded-mind',
                own: { playerId: 'p1', hand: ['informant#1', 'mule#2'], legalPlays: [] }
            })
        );
        expect(ui.shadows()).toHaveLength(2 + 2 + 1);
    });

    it('shrinks with the hand', () => {
        const ui = mounted(viewWithSeats({ own: { playerId: 'p1', hand: ['informant#1'], legalPlays: [] } }));
        expect(ui.shadows()).toHaveLength(2 + 1);
    });

    it('empties away from the table', () => {
        const ui = mounted();
        ui.twin.update(makeState({ screen: 'lobby' }));
        expect(ui.shadows()).toEqual([]);
    });
});

describe('staying in the accessibility tree', () => {
    it('is hidden by clipping, never by display or visibility', () => {
        // Either of those removes the twin from the tree it exists to populate.
        const style = getComputedStyle(mounted().host);
        expect(style.display).not.toBe('none');
        expect(style.visibility).not.toBe('hidden');
    });

    it('is never aria-hidden', () => {
        expect(mounted().host.getAttribute('aria-hidden')).toBeNull();
    });

    it('is not a live region — the toast channel owns announcements', () => {
        // A status list re-rendered on every snapshot would announce every seat
        // on every update, and double up with the narration toasts (UIX §6.5).
        expect(mounted().host.getAttribute('aria-live')).toBeNull();
    });
});
