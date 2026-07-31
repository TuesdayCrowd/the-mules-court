import { describe, expect, test } from 'vitest';
import type { CardInstanceId } from '../engine';
import { reduce, view } from '../engine';
import { decisionStates, seeds, takeStates } from './__fixtures__/decisionStates';
import { determinize } from './determinize';
import { makeRng } from './rng';

describe('determinize', () => {
    test('produces a world the viewer cannot tell from the real one', () => {
        // The headline gate of Computer Opponent Design §4. A sampled world the
        // bot could distinguish from reality is one where the bot is either
        // cheating or reasoning about a game that cannot exist.
        const rng = makeRng('roundtrip');

        for (const { match, actorId } of decisionStates(seeds(60, 'rt'))) {
            const real = view(match, actorId);
            expect(view(determinize(real, rng), actorId)).toEqual(real);
        }
    });

    test('holds the roundtrip across many samples of one state', () => {
        const { match, actorId } = takeStates(1, 'single')[0];
        const real = view(match, actorId);
        const rng = makeRng('resample');

        for (let i = 0; i < 200; i++) {
            expect(view(determinize(real, rng), actorId)).toEqual(real);
        }
    });

    test('places every physical card exactly once', () => {
        const rng = makeRng('conservation');

        for (const { match, actorId } of takeStates(40, 'cons')) {
            const world = determinize(view(match, actorId), rng);
            const round = world.round;

            const placed: CardInstanceId[] = [
                ...round.deckOrder,
                ...round.setAsideFaceDown,
                ...(round.setAsideFaceUp === null ? [] : [round.setAsideFaceUp]),
                ...Object.values(round.players).flatMap(p => [
                    ...p.hand,
                    ...p.discardPile.map(entry => entry.instanceId)
                ])
            ];

            expect(placed).toHaveLength(16);
            expect(new Set(placed).size).toBe(16);
        }
    });

    test('samples different worlds from different draws', () => {
        const { match, actorId } = takeStates(1, 'variety')[0];
        const real = view(match, actorId);
        const rng = makeRng('variety');

        const decks = new Set(
            Array.from({ length: 50 }, () => determinize(real, rng).round.deckOrder.join(','))
        );

        expect(decks.size).toBeGreaterThan(1);
    });

    test('yields a state the engine accepts every legal play on', () => {
        const rng = makeRng('playable');

        for (const { match, actorId } of takeStates(40, 'play')) {
            const real = view(match, actorId);
            const world = determinize(real, rng);

            for (const cardInstanceId of real.own.legalPlays) {
                const targets = real.own.legalTargets[cardInstanceId] ?? [];
                const result = reduce(world, {
                    type: 'PLAY_CARD',
                    playerId: actorId,
                    cardInstanceId,
                    ...(targets.length > 0 ? { target: targets[0] } : {}),
                    ...(cardInstanceId.startsWith('informant#') && targets.length > 0
                        ? { guess: 4 as const }
                        : {})
                });

                expect(result.ok, `refused ${cardInstanceId}`).toBe(true);
            }
        }
    });

    test('refuses a view it cannot faithfully reconstruct', () => {
        const { match, actorId } = takeStates(1, 'guard')[0];
        const real = view(match, actorId);
        const rng = makeRng('guard');

        expect(() => determinize({ ...real, mode: 'sudden-death' }, rng)).toThrow(/sudden death/i);
    });
});
