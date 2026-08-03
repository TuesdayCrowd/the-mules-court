/**
 * The pool a computer opponent draws its display name from.
 *
 * Tested here rather than through a live lobby because every property that
 * matters is a property of the list itself, and `botSeat.test.ts` already
 * proves a seated bot carries whatever name this module hands it.
 */
import { describe, expect, it } from 'bun:test';
import { CARD_CATALOG } from '../../game/engine';
import { makeConfig } from '../config';
import { BOT_NAMES, EMPIRE_NAMES, FOUNDATION_NAMES, ROBOT_NAMES, pickBotName } from '../botNames';

/** A draw that walks the pool in order, so a test can name the exact result. */
const drawAt = (index: number) => () => index / BOT_NAMES.length;

describe('the name pool', () => {
    it('draws on all three series in Asimov\'s shared future history', () => {
        expect(ROBOT_NAMES.length).toBeGreaterThan(0);
        expect(EMPIRE_NAMES.length).toBeGreaterThan(0);
        expect(FOUNDATION_NAMES.length).toBeGreaterThan(0);
        expect(BOT_NAMES).toEqual([...ROBOT_NAMES, ...EMPIRE_NAMES, ...FOUNDATION_NAMES]);
    });

    it('offers more names than a table has seats, so a match is not always the same four', () => {
        expect(BOT_NAMES.length).toBeGreaterThan(20);
    });

    /**
     * The rule the old comment stated and nothing enforced.
     *
     * A seat labelled with a card's name reads as a revealed hand — "Bayta
     * Darell" in the seat list beside "Bayta Darell" in a discard pile is a
     * player being told something false about the round.
     */
    it('never names a card in the deck', () => {
        const cards = new Set(Object.values(CARD_CATALOG).map(def => def.displayName));
        expect(BOT_NAMES.filter(name => cards.has(name))).toEqual([]);
    });

    it('repeats no name, so two seats can never share one', () => {
        expect([...new Set(BOT_NAMES)]).toHaveLength(BOT_NAMES.length);
    });

    /**
     * Bot names bypass CLAIM_SEAT's validation — nothing sends them over the
     * wire to be checked — so the limit every human nickname is held to has to
     * be honoured here by construction.
     */
    it('keeps every name inside the nickname limit a person is held to', () => {
        const limit = makeConfig({}).maxNicknameLength;
        expect(BOT_NAMES.filter(name => name.length > limit)).toEqual([]);
    });

    it('has no blank or untrimmed entry', () => {
        expect(BOT_NAMES.filter(name => name !== name.trim() || name === '')).toEqual([]);
    });
});

describe('pickBotName', () => {
    it('draws from the pool', () => {
        expect(BOT_NAMES).toContain(pickBotName([], drawAt(0)));
    });

    it('is a function of the draw, so a seeded stream reproduces', () => {
        expect(pickBotName([], drawAt(3))).toBe(pickBotName([], drawAt(3)));
        expect(pickBotName([], drawAt(0))).toBe(BOT_NAMES[0]);
    });

    /** Two seats sharing a name would make the lobby and the log ambiguous. */
    it('never returns a name already in use at the table', () => {
        const first = pickBotName([], drawAt(0));
        expect(pickBotName([first], drawAt(0))).not.toBe(first);
    });

    it('skips a name a person happens to have typed', () => {
        // Nothing stops a human nickname colliding with the pool.
        const taken = [BOT_NAMES[0], BOT_NAMES[1]];
        expect(taken).not.toContain(pickBotName(taken, drawAt(0)));
    });

    /**
     * Four seats against a pool of dozens means this is unreachable in the
     * shipped game. It still has to return a string rather than `undefined`,
     * because the caller writes the result straight into a seat.
     */
    it('falls back to a numbered name when every name is taken', () => {
        const name = pickBotName(BOT_NAMES, drawAt(0));
        expect(typeof name).toBe('string');
        expect(name.length).toBeGreaterThan(0);
        expect(BOT_NAMES).not.toContain(name);
    });

    it('clamps a draw at the top of the range rather than falling off the end', () => {
        // `Rng.next()` promises [0, 1), but an index computed from it must not
        // depend on that promise holding.
        expect(BOT_NAMES).toContain(pickBotName([], () => 1));
        expect(BOT_NAMES).toContain(pickBotName([], () => 0.999999999));
    });
});
