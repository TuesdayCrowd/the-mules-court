import { describe, it, expect } from 'vitest';
import * as engine from '../index';
import { createMatch, reduce, startNextRound, view, broadcastViews } from '../index';
import type { MatchState, PlayCardAction, PlayerId, RedactedView } from '../index';

const PLAYERS: PlayerId[] = ['p0', 'p1', 'p2', 'p3'];

/**
 * Drives a match by always playing the first legal card, choosing the first legal
 * target, and always guessing 'mule'. Deterministic, and enough to walk a real
 * game through every branch of the pipeline.
 */
function autoAction(match: MatchState): PlayCardAction | null {
    const round = match.round;
    if (round.phase !== 'awaiting-play') return null;

    const playerId = round.seatOrder[round.currentPlayerIndex];
    const projection = view(match, playerId);
    const cardInstanceId = projection.own.legalPlays[0];
    if (cardInstanceId === undefined) return null;

    const cardId = engine.cardTypeOf(cardInstanceId);
    const effect = engine.EFFECT_DEFS[engine.CARD_CATALOG[cardId].effectType];
    const targets = engine.computeLegalTargets(round, playerId, effect);

    const action: PlayCardAction = { type: 'PLAY_CARD', playerId, cardInstanceId };
    if (!effect.requiresTarget || targets.length === 0) return action;

    const target = targets[0];
    if (!effect.requiresGuess) return { ...action, target };
    return { ...action, target, guess: 8 };
}

/** Plays a whole match to completion, collecting every state along the way. */
function playMatch(seed: string, maxSteps = 4000): MatchState[] {
    let match = createMatch(PLAYERS, seed, 'integration');
    const states: MatchState[] = [match];

    for (let step = 0; step < maxSteps; step++) {
        if (match.matchWinnerId !== null) break;

        if (match.round.phase === 'round-over') {
            match = startNextRound(match);
            states.push(match);
            continue;
        }

        const action = autoAction(match);
        if (action === null) break;

        const result = reduce(match, action);
        if (!result.ok) throw new Error(`illegal action: ${result.error.code}`);
        match = result.state;
        states.push(match);
    }

    return states;
}

describe('a full match', () => {
    it('runs to a single winner', () => {
        const states = playMatch('integration-a');
        const final = states[states.length - 1];
        expect(final.matchWinnerId).not.toBeNull();
    });

    it('awards the winner at least the token target', () => {
        const final = playMatch('integration-a').slice(-1)[0];
        const winner = final.players.find(p => p.id === final.matchWinnerId);
        expect(winner!.tokens).toBeGreaterThanOrEqual(final.tokensToWin);
    });

    it('never loses or duplicates a card in any state', () => {
        for (const state of playMatch('integration-b')) {
            const round = state.round;
            const cards = [
                ...round.deckOrder,
                ...round.setAsideFaceDown,
                ...(round.setAsideFaceUp ? [round.setAsideFaceUp] : []),
                ...Object.values(round.players).flatMap(p => p.hand),
                ...Object.values(round.players).flatMap(p => p.discardPile.map(e => e.instanceId))
            ];
            expect(cards).toHaveLength(16);
            expect(new Set(cards).size).toBe(16);
        }
    });

    it('keeps every state JSON-serializable', () => {
        for (const state of playMatch('integration-c')) {
            expect(JSON.parse(JSON.stringify(state))).toEqual(state);
        }
    });
});

describe('replay determinism', () => {
    it('produces identical states from the same seed', () => {
        expect(playMatch('replay-seed')).toEqual(playMatch('replay-seed'));
    });

    it('produces different games from different seeds', () => {
        const a = playMatch('replay-a').slice(-1)[0];
        const b = playMatch('replay-b').slice(-1)[0];
        expect(a.actionLog).not.toEqual(b.actionLog);
    });

    it('replays a finished match from its seed and action log', () => {
        const original = playMatch('replay-from-log').slice(-1)[0];

        let replayed = createMatch(PLAYERS, original.seed, original.matchId);
        for (const action of original.actionLog) {
            if (replayed.round.phase === 'round-over') replayed = startNextRound(replayed);
            const result = reduce(replayed, action);
            if (!result.ok) throw new Error(`replay diverged: ${result.error.code}`);
            replayed = result.state;
        }

        expect(replayed).toEqual(original);
    });
});

describe('redaction holds after every single reduce', () => {
    /** Every card instance a viewer is NOT entitled to see. */
    function forbiddenFor(state: MatchState, viewerId: PlayerId): string[] {
        const round = state.round;
        const revealedAtEnd = round.phase === 'round-over';
        return [
            ...round.deckOrder,
            ...round.setAsideFaceDown,
            ...Object.entries(round.players)
                .filter(([id]) => id !== viewerId)
                // Once the round is over, surviving hands are revealed on purpose.
                .filter(() => !revealedAtEnd)
                .flatMap(([, player]) => player.hand)
        ];
    }

    it('never shows a viewer a card they may not see', () => {
        for (const state of playMatch('leak-fuzz')) {
            for (const viewerId of PLAYERS) {
                const serialized = JSON.stringify(view(state, viewerId));
                for (const card of forbiddenFor(state, viewerId)) {
                    expect(serialized, `${viewerId} must not see ${card}`).not.toContain(card);
                }
            }
        }
    });

    it('never exposes the seed or the rng', () => {
        for (const state of playMatch('leak-fuzz')) {
            for (const viewerId of PLAYERS) {
                const projection = view(state, viewerId) as unknown as Record<string, unknown>;
                expect(projection.rng).toBeUndefined();
                expect(projection.seed).toBeUndefined();
                expect(projection.deckOrder).toBeUndefined();
                expect(projection.setAsideFaceDown).toBeUndefined();
                expect(projection.privateKnowledge).toBeUndefined();
                expect(projection.actionLog).toBeUndefined();
                expect(JSON.stringify(projection)).not.toContain('leak-fuzz');
            }
        }
    });

    // A redaction test asserting only absence would pass if view() returned
    // nothing at all. Presence matters just as much.
    it('still shows each viewer everything they ARE entitled to', () => {
        for (const state of playMatch('leak-fuzz')) {
            for (const viewerId of PLAYERS) {
                const projection = view(state, viewerId);
                const ownHand = state.round.players[viewerId]?.hand ?? [];
                expect(projection.own.hand).toEqual(ownHand);
                expect(projection.deckCount).toBe(state.round.deckOrder.length);
                expect(projection.players).toHaveLength(state.players.length);
            }
        }
    });

    // Each viewer sees exactly their own still-valid peeks — no more, no fewer.
    // Note two players may independently know the same card (two Priests on one
    // hand, or a Baron's mutual reveal), so this compares per viewer rather than
    // asserting a fact belongs to one player alone.
    it('shows each viewer exactly their own live peeks', () => {
        for (const state of playMatch('leak-fuzz')) {
            for (const viewerId of PLAYERS) {
                const expected = state.round.privateKnowledge
                    .filter(
                        record =>
                            record.viewerId === viewerId &&
                            record.roundNumber === state.round.roundNumber &&
                            (state.round.players[record.subjectId]?.hand ?? []).includes(
                                record.cardInstanceId
                            )
                    )
                    .map(record => ({
                        subjectId: record.subjectId,
                        cardTypeId: record.cardTypeId
                    }));
                expect(view(state, viewerId).revealed).toEqual(expected);
            }
        }
    });
});

describe('the public API barrel', () => {
    it('exports the sanctioned surface', () => {
        for (const name of [
            'createMatch',
            'reduce',
            'startNextRound',
            'validateAction',
            'view',
            'broadcastViews',
            'computeLegalPlays',
            'computeLegalTargets',
            'CARD_CATALOG',
            'EFFECT_DEFS',
            'isMatchOver',
            'getMatchWinner'
        ]) {
            expect(engine, name).toHaveProperty(name);
        }
    });

    it('keeps engine internals private', () => {
        for (const name of [
            'eliminate',
            'discardPlayedCard',
            'advanceTurn',
            'checkRoundEnd',
            'resolveGuard',
            'resolveBaron',
            'resolvePrince',
            'nextRng',
            'shuffle',
            'seedRng'
        ]) {
            expect(engine, name).not.toHaveProperty(name);
        }
    });

    it('reports match completion through its predicates', () => {
        const final = playMatch('api-seed').slice(-1)[0];
        expect(engine.isMatchOver(final)).toBe(true);
        expect(engine.getMatchWinner(final)).toBe(final.matchWinnerId);
    });

    it('broadcasts one redacted view per player', () => {
        const match = createMatch(PLAYERS, 'broadcast', 'm1');
        const views: Record<PlayerId, RedactedView> = broadcastViews(match, PLAYERS);
        expect(Object.keys(views)).toHaveLength(4);
        for (const id of PLAYERS) {
            expect(views[id].own.playerId).toBe(id);
        }
    });
});
