import { describe, expect, it } from 'vitest';
import type { CardTypeId, CardValue, RedactedView } from '../../game/engine';
import { makeView } from '../store/__fixtures__/view';
import type { ViewOverrides } from '../store/__fixtures__/view';
import { TOKENS } from '../tokens/tokens';
import type { RenderInput } from './renderPlan';
import { buildRenderPlan } from './renderPlan';
import { computeLayout } from './tableLayout';

const SPEC = computeLayout({
    w: 390,
    h: 844,
    opponentCount: 3,
    handCount: 2,
    showsRemovedCard: false,
    maxDiscards: 3
});

function seat(id: string, overrides: Partial<RedactedView['players'][number]> = {}) {
    return {
        id,
        seat: 0,
        tokens: 0,
        alive: true,
        protected: false,
        discardPile: [] as ReadonlyArray<{ readonly cardId: CardTypeId; readonly value: CardValue }>,
        discardValueTotal: 0,
        ...overrides
    };
}

function fourSeats(overrides: ViewOverrides = {}): RedactedView {
    return makeView({
        players: [seat('p1'), seat('p2'), seat('p3'), seat('p4')],
        currentPlayerId: 'p1',
        own: { playerId: 'p1', hand: ['informant#1'], legalPlays: ['informant#1'] },
        ...overrides
    });
}

function plan(view: RedactedView, extra: Partial<RenderInput> = {}) {
    return buildRenderPlan(
        {
            view,
            nicknames: { p1: 'Ana', p2: 'Bayta', p3: 'Toran', p4: 'Magnifico' },
            phase: 'active',
            paused: false,
            missingSeats: [],
            ...extra
        },
        SPEC
    );
}

describe('seats', () => {
    it('renders every opponent and never the viewer', () => {
        const seats = plan(fourSeats()).seats;
        expect(seats).toHaveLength(3);
        expect(seats.map(s => s.playerId)).toEqual(['p2', 'p3', 'p4']);
    });

    it('marks the current player and no one else', () => {
        const seats = plan(fourSeats({ currentPlayerId: 'p3' })).seats;
        expect(seats.filter(s => s.state === 'current').map(s => s.playerId)).toEqual(['p3']);
    });

    it('marks a protected seat with its caption', () => {
        const view = fourSeats();
        const seats = plan({ ...view, players: [view.players[0], seat('p2', { protected: true }), view.players[2], view.players[3]] }).seats;

        expect(seats[0].state).toBe('protected');
        expect(seats[0].caption).toBe('Protected — cannot be targeted');
    });

    it("reveals an eliminated seat's held card atop their discard pile", () => {
        // The case that actually happens mid-round, with no `roundResult` at
        // all. `eliminate()` pushes whatever they held onto their own pile
        // (engine/discard.ts), so the TOP of that pile is the reveal — and
        // `revealedHands` is populated on deck-out only, so reading it here
        // would leave every real elimination showing nothing.
        const view = fourSeats();
        const seats = plan({
            ...view,
            players: [
                view.players[0],
                seat('p2', {
                    alive: false,
                    discardPile: [
                        { cardId: 'informant', value: 1 },
                        { cardId: 'mule', value: 8 }
                    ],
                    discardValueTotal: 9
                }),
                view.players[2],
                view.players[3]
            ]
        }).seats;

        expect(seats[0].state).toBe('eliminated');
        expect(seats[0].revealedCard).toBe('mule');
    });

    it('reveals the showdown hand at round over, which no discard pile carries', () => {
        // A deck-out survivor still HOLDS their card, so it is not on their
        // pile. `revealedHands` is the only legal source (interface rule 4).
        const view = fourSeats({ roundResult: { reason: 'deck-out', winnerIds: ['p1'], revealedHands: { p2: 'mule' } } });
        expect(plan(view, { phase: 'round_over' }).seats[0].revealedCard).toBe('mule');
    });

    it('reveals nothing for a living seat', () => {
        expect(plan(fourSeats()).seats.every(s => s.revealedCard === null)).toBe(true);
    });

    it('marks a living seat as holding a card, and an eliminated one as holding none', () => {
        const view = fourSeats();
        const seats = plan({
            ...view,
            players: [view.players[0], seat('p2', { alive: false }), view.players[2], view.players[3]]
        }).seats;

        expect(seats[0].holdsCard).toBe(false); // UIX §6.2's card-back marker
        expect(seats[1].holdsCard).toBe(true);
    });

    it('carries each seat\'s devotion token count', () => {
        const view = fourSeats();
        const seats = plan({
            ...view,
            players: [view.players[0], seat('p2', { tokens: 3 }), view.players[2], view.players[3]]
        }).seats;
        expect(seats[0].tokens).toBe(3);
    });
});

describe("the viewer's own status", () => {
    it("carries the viewer's own tokens and every discard value, at the spec's rect", () => {
        // UIX §6.1 puts "own tokens + discards" above the hand. The viewer is
        // filtered out of `seats`, so without this the one player who cannot
        // see their own standing is the player whose standing it is.
        const view = fourSeats();
        const built = plan({
            ...view,
            players: [
                seat('p1', {
                    tokens: 2,
                    discardPile: [
                        { cardId: 'informant', value: 1 },
                        { cardId: 'magnifico', value: 3 }
                    ],
                    discardValueTotal: 4
                }),
                view.players[1],
                view.players[2],
                view.players[3]
            ]
        });

        expect(built.own.rect).toBe(SPEC.ownStatus);
        expect(built.own.tokens).toBe(2);
        expect(built.own.discardValues).toEqual([1, 3]);
        expect(built.own.discardTotal).toBe(4);
    });

    it('marks a missing seat disconnected without removing their cards', () => {
        const view = fourSeats();
        const withCards = {
            ...view,
            players: [
                view.players[0],
                seat('p2', { discardPile: [{ cardId: 'informant', value: 1 }], discardValueTotal: 1 }),
                view.players[2],
                view.players[3]
            ]
        };
        const seats = plan(withCards, { missingSeats: ['p2'] }).seats;

        expect(seats[0].state).toBe('disconnected');
        expect(seats[0].caption).toBe('Reconnecting…');
        expect(seats[0].discardValues).toEqual([1]); // the seat is held, not cleared
    });

    it('lets elimination outrank disconnection', () => {
        const view = fourSeats();
        const seats = plan(
            { ...view, players: [view.players[0], seat('p2', { alive: false }), view.players[2], view.players[3]] },
            { missingSeats: ['p2'] }
        ).seats;
        expect(seats[0].state).toBe('eliminated');
    });

    it('carries every discard value, never a truncation', () => {
        const view = fourSeats();
        const pile = [1, 2, 3, 4, 5, 6, 7, 8].map(value => ({ cardId: 'informant' as const, value: value as 1 }));
        const seats = plan({
            ...view,
            players: [view.players[0], seat('p2', { discardPile: pile, discardValueTotal: 36 }), view.players[2], view.players[3]]
        }).seats;

        expect(seats[0].discardValues).toHaveLength(8);
        expect(seats[0].discardTotal).toBe(36);
    });

    it("shows this viewer's own peek on a seat", () => {
        const seats = plan(fourSeats({ revealed: [{ subjectId: 'p3', cardTypeId: 'mule' }] })).seats;
        expect(seats.find(s => s.playerId === 'p3')!.knownCard).toBe('mule');
        expect(seats.find(s => s.playerId === 'p2')!.knownCard).toBeNull();
    });
});

describe('the deck', () => {
    it('colours the deck purple, orange at 3 or fewer, dark red at empty', () => {
        expect(plan(fourSeats({ deckCount: 11 })).deck.colour).toBe(TOKENS.colorDeckFull);
        expect(plan(fourSeats({ deckCount: 3 })).deck.colour).toBe(TOKENS.colorDeckLow);
        expect(plan(fourSeats({ deckCount: 0 })).deck.colour).toBe(TOKENS.colorDeckEmpty);
    });

    it('pulses harder as it empties, so the state is never colour alone', () => {
        expect(plan(fourSeats({ deckCount: 11 })).deck.pulse).toBe('none');
        expect(plan(fourSeats({ deckCount: 3 })).deck.pulse).toBe('subtle');
        expect(plan(fourSeats({ deckCount: 0 })).deck.pulse).toBe('strong');
    });

    it('carries the count itself, which is the real signal', () => {
        expect(plan(fourSeats({ deckCount: 7 })).deck.count).toBe(7);
    });
});

describe('the hand', () => {
    it('dims a hand card that is not in legalPlays and captions the forced play', () => {
        const held = fourSeats({
            own: {
                playerId: 'p1',
                hand: ['first-speaker#0', 'mayor-indbur#0'],
                legalPlays: ['first-speaker#0']
            }
        });
        const hand = plan(held).hand;

        expect(hand[0].playable).toBe(true);
        expect(hand[1].dimmed).toBe(true);
        expect(hand[1].caption).toBe('must play The First Speaker');
        // The client computed no rule — legalPlays said so.
    });

    it('never marks a card playable off-turn', () => {
        const waiting = fourSeats({
            currentPlayerId: 'p2',
            own: { playerId: 'p1', hand: ['informant#1'], legalPlays: [] }
        });
        expect(plan(waiting).hand[0].playable).toBe(false);
    });

    it('dims nothing off-turn, because no choice is being denied', () => {
        const waiting = fourSeats({
            currentPlayerId: 'p2',
            own: { playerId: 'p1', hand: ['informant#1', 'mule#1'], legalPlays: [] }
        });
        expect(plan(waiting).hand.every(card => !card.dimmed)).toBe(true);
    });

    it('captions nothing when both cards are legal', () => {
        const both = fourSeats({
            own: { playerId: 'p1', hand: ['informant#1', 'mule#1'], legalPlays: ['informant#1', 'mule#1'] }
        });
        expect(plan(both).hand.every(card => card.caption === null)).toBe(true);
    });

    it('names the card type for each held instance', () => {
        const held = fourSeats({ own: { playerId: 'p1', hand: ['mule#1'], legalPlays: ['mule#1'] } });
        expect(plan(held).hand[0].cardId).toBe('mule');
    });
});

describe('the banner', () => {
    it('banners your turn, waiting, round over, and paused with the right token colour', () => {
        const yours = plan(fourSeats({ currentPlayerId: 'p1' })).banner;
        expect(yours.text).toBe('Your turn');
        expect(yours.colour).toBe(TOKENS.colorStateYourTurn);

        const waiting = plan(fourSeats({ currentPlayerId: 'p2' })).banner;
        expect(waiting.text).toBe('Waiting for Bayta');
        expect(waiting.colour).toBe(TOKENS.colorStateWaiting);

        const over = plan(fourSeats(), { phase: 'round_over' }).banner;
        expect(over.text).toBe('Round over');
        expect(over.colour).toBe(TOKENS.colorStateRoundOver);

        const paused = plan(fourSeats(), { paused: true }).banner;
        expect(paused.text).toBe('Paused');
        expect(paused.colour).toBe(TOKENS.colorStatePaused);
    });

    it('lets paused outrank the turn it interrupted', () => {
        expect(plan(fourSeats({ currentPlayerId: 'p1' }), { paused: true }).banner.text).toBe('Paused');
    });

    it('banners the match ending above the round ending', () => {
        expect(plan(fourSeats(), { phase: 'ended' }).banner.text).toBe('Match over');
    });
});

describe('geometry comes from the spec, never from here', () => {
    it('places every element at the rect the layout computed', () => {
        const built = plan(fourSeats());
        expect(built.deck.rect).toBe(SPEC.deck);
        expect(built.banner.rect).toBe(SPEC.banner);
        expect(built.seats[0].rect).toBe(SPEC.opponents[0]);
        expect(built.hand[0].rect).toBe(SPEC.hand[0]);
    });

    it('renders no more seats than the layout has room for', () => {
        const narrow = computeLayout({ w: 390, h: 844, opponentCount: 1, handCount: 1, showsRemovedCard: false, maxDiscards: 2 });
        expect(buildRenderPlan({ view: fourSeats(), nicknames: {}, phase: 'active', paused: false, missingSeats: [] }, narrow).seats).toHaveLength(1);
    });

    it('shows the burn card only when the layout reserved a panel and the view has one', () => {
        const twoPlayer = computeLayout({ w: 390, h: 844, opponentCount: 1, handCount: 1, showsRemovedCard: true, maxDiscards: 2 });
        const view = fourSeats({ setAsideFaceUp: 'magnifico' });

        expect(buildRenderPlan({ view, nicknames: {}, phase: 'active', paused: false, missingSeats: [] }, twoPlayer).removedCard)
            .toEqual({ rect: twoPlayer.removedCard, cardId: 'magnifico' });
        expect(plan(view).removedCard).toBeNull(); // SPEC reserved no panel
    });
});
