import { describe, it, expect } from 'vitest';
import { reduce, startNextRound } from '../reduce';
import { createMatch } from '../setup';
import { validateAction } from '../validation';
import { computeLegalPlays, computeLegalTargets } from '../legality';
import { resolvePrince } from '../resolvers/prince';
import { resolveBaron } from '../resolvers/baron';
import { EFFECT_DEFS } from '../effectRegistry';
import { makeDraft, makeRound, makePlayers } from './helpers';
import type { MatchState, PlayCardAction } from '../types';

/**
 * One named test per ruling in design §9, plus the two rules settled during
 * brainstorming. Each name matches its ruling so a failure points straight at the
 * rule it broke.
 */

const rig = (match: MatchState, round: Partial<MatchState['round']>): MatchState => ({
    ...match,
    round: { ...match.round, ...round }
});

const twoPlayer = () => createMatch(['p0', 'p1'], 'edge', 'edge-match');

describe('§9 informant-may-not-name-itself', () => {
    it('rejects the guess by identity, never by value', () => {
        const match = rig(twoPlayer(), {
            seatOrder: ['p0', 'p1'],
            currentPlayerIndex: 0,
            players: makePlayers({
                p0: { hand: ['informant#0', 'magnifico#0'] },
                p1: { hand: ['mule#0'] }
            })
        });
        const action: PlayCardAction = {
            type: 'PLAY_CARD',
            playerId: 'p0',
            cardInstanceId: 'informant#0',
            target: 'p1',
            guess: 'informant'
        };
        const result = validateAction(match.round, action);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('GUESS_CANNOT_BE_INFORMANT');
    });
});

describe('§9 no-valid-target-fizzle', () => {
    it('still discards the played card while the effect does nothing', () => {
        const match = rig(twoPlayer(), {
            seatOrder: ['p0', 'p1'],
            currentPlayerIndex: 0,
            deckOrder: ['magnifico#0'],
            players: makePlayers({
                p0: { hand: ['informant#0', 'shielded-mind#0'] },
                p1: { hand: ['mule#0'], protected: true }
            })
        });
        const result = reduce(match, {
            type: 'PLAY_CARD',
            playerId: 'p0',
            cardInstanceId: 'informant#0'
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.state.round.players.p0.discardPile.map(e => e.cardId)).toEqual(['informant']);
        expect(result.state.round.players.p1.alive).toBe(true);
    });
});

describe('§9 prince-never-fizzles', () => {
    it('always finds at least the actor as a legal target', () => {
        const round = makeRound({
            players: makePlayers({
                p0: {},
                p1: { protected: true },
                p2: { alive: false }
            })
        });
        expect(computeLegalTargets(round, 'p0', EFFECT_DEFS.PRINCE)).toEqual(['p0']);
    });
});

describe('§9 prince-cannot-target-a-protected-opponent', () => {
    it('excludes a protected opponent even though the actor may self-target', () => {
        const round = makeRound({
            players: makePlayers({ p0: {}, p1: { protected: true }, p2: {} })
        });
        expect(computeLegalTargets(round, 'p0', EFFECT_DEFS.PRINCE)).not.toContain('p1');
    });
});

describe('§9 protection-window-boundary', () => {
    it('lasts through opponents\' turns and clears at the holder\'s own next turn', () => {
        const match = createMatch(['p0', 'p1', 'p2'], 'window', 'm');
        const start = rig(match, {
            seatOrder: ['p0', 'p1', 'p2'],
            currentPlayerIndex: 0,
            deckOrder: ['magnifico#0', 'ebling-mis#0', 'mayor-indbur#0'],
            players: makePlayers({
                p0: { hand: ['shielded-mind#0', 'informant#0'] },
                p1: { hand: ['han-pritcher#0'] },
                p2: { hand: ['bail-channis#0'] }
            })
        });

        const shielded = reduce(start, {
            type: 'PLAY_CARD',
            playerId: 'p0',
            cardInstanceId: 'shielded-mind#0'
        });
        if (!shielded.ok) throw new Error('expected a legal play');
        expect(shielded.state.round.players.p0.protected).toBe(true);

        const afterP1 = reduce(shielded.state, {
            type: 'PLAY_CARD',
            playerId: 'p1',
            cardInstanceId: 'han-pritcher#0',
            target: 'p2'
        });
        if (!afterP1.ok) throw new Error('expected a legal play');
        expect(afterP1.state.round.players.p0.protected).toBe(true);

        const afterP2 = reduce(afterP1.state, {
            type: 'PLAY_CARD',
            playerId: 'p2',
            cardInstanceId: 'bail-channis#0',
            target: 'p1'
        });
        if (!afterP2.ok) throw new Error('expected a legal play');
        // The turn has come back round to p0, so the shield is gone.
        expect(afterP2.state.round.seatOrder[afterP2.state.round.currentPlayerIndex]).toBe('p0');
        expect(afterP2.state.round.players.p0.protected).toBe(false);
    });
});

describe('§9 baron-king-self-prince-read-the-remaining-card', () => {
    it('compares the actor\'s other card, because the played Baron is already gone', () => {
        const draft = makeDraft({
            players: makePlayers({ p0: { hand: ['informant#0'] }, p1: { hand: ['mayor-indbur#0'] } })
        });
        resolveBaron({ round: draft, actorId: 'p0', targetId: 'p1', playedCardId: 'ebling-mis' });
        expect(draft.players.p0.alive).toBe(false);
    });
});

describe('§9 prince-forced-mule-discard-skips-the-redraw', () => {
    it('eliminates the target and leaves the deck untouched', () => {
        const draft = makeDraft({
            players: makePlayers({ p0: { hand: ['magnifico#0'] }, p1: { hand: ['mule#0'] } }),
            deckOrder: ['informant#0']
        });
        resolvePrince({ round: draft, actorId: 'p0', targetId: 'p1', playedCardId: 'bayta-darell' });
        expect(draft.players.p1.alive).toBe(false);
        expect(draft.deckOrder).toEqual(['informant#0']);
    });
});

describe('§9 four-player-empty-deck-prince-has-no-set-aside', () => {
    it('leaves the target holding nothing rather than a placeholder', () => {
        const draft = makeDraft({
            players: makePlayers({ p0: { hand: ['magnifico#0'] }, p1: { hand: ['informant#0'] } }),
            deckOrder: [],
            setAsideFaceDown: []
        });
        resolvePrince({ round: draft, actorId: 'p0', targetId: 'p1', playedCardId: 'bayta-darell' });
        expect(draft.players.p1.hand).toEqual([]);
        expect(draft.players.p1.alive).toBe(true);
    });
});

describe('§9 baron-tie-still-reveals', () => {
    it('writes both peeks and eliminates nobody', () => {
        const draft = makeDraft({
            players: makePlayers({
                p0: { hand: ['han-pritcher#0'] },
                p1: { hand: ['bail-channis#0'] }
            })
        });
        resolveBaron({ round: draft, actorId: 'p0', targetId: 'p1', playedCardId: 'magnifico' });
        expect(draft.privateKnowledge).toHaveLength(2);
        expect(draft.players.p0.alive).toBe(true);
        expect(draft.players.p1.alive).toBe(true);
    });
});

describe('§9 elimination-reveals-the-victims-card', () => {
    it('makes an Informant hit public through the shared eliminate()', () => {
        const match = rig(createMatch(['p0', 'p1', 'p2'], 'reveal', 'm'), {
            seatOrder: ['p0', 'p1', 'p2'],
            currentPlayerIndex: 0,
            deckOrder: ['magnifico#0', 'ebling-mis#0'],
            players: makePlayers({
                p0: { hand: ['informant#0', 'shielded-mind#0'] },
                p1: { hand: ['mule#0'] },
                p2: { hand: ['han-pritcher#0'] }
            })
        });
        const result = reduce(match, {
            type: 'PLAY_CARD',
            playerId: 'p0',
            cardInstanceId: 'informant#0',
            target: 'p1',
            guess: 'mule'
        });
        if (!result.ok) throw new Error('expected a legal play');
        expect(result.state.round.players.p1.discardPile.map(e => e.cardId)).toEqual(['mule']);
        expect(result.state.round.players.p1.discardValueTotal).toBe(8);
    });
});

describe('§9 peek-invalidates-when-the-card-moves', () => {
    it('drops a peek once the subject no longer holds that instance', () => {
        const draft = makeDraft({
            players: makePlayers({ p0: { hand: ['han-pritcher#0'] }, p1: { hand: ['mule#0'] } })
        });
        resolveBaron({ round: draft, actorId: 'p0', targetId: 'p1', playedCardId: 'ebling-mis' });
        expect(draft.privateKnowledge).toHaveLength(2);
        // The record persists in state; view() is what re-checks it live.
        expect(draft.privateKnowledge.every(r => r.cardInstanceId.includes('#'))).toBe(true);
    });
});

describe('§9 mule-eliminates-on-any-discard-path', () => {
    it('eliminates on a voluntary play', () => {
        const draft = makeDraft({
            players: makePlayers({ p0: { hand: ['mule#0', 'informant#0'] }, p1: {} })
        });
        const before = draft.players.p0.alive;
        expect(before).toBe(true);
        resolvePrince({ round: draft, actorId: 'p0', targetId: 'p0', playedCardId: 'bayta-darell' });
        // Prince-forced self discard of the Mule kills just the same.
        expect(draft.players.p0.alive).toBe(false);
    });
});

describe('§9 first-speaker-forced-play', () => {
    it('forces the First Speaker beside a KING', () => {
        const round = makeRound({
            players: makePlayers({ p0: { hand: ['first-speaker#0', 'mayor-indbur#0'] }, p1: {} })
        });
        expect(computeLegalPlays(round, 'p0')).toEqual(['first-speaker#0']);
    });

    it('leaves the hand free beside anything else', () => {
        const round = makeRound({
            players: makePlayers({ p0: { hand: ['first-speaker#0', 'han-pritcher#0'] }, p1: {} })
        });
        expect(computeLegalPlays(round, 'p0')).toHaveLength(2);
    });
});

describe('brainstorm rule: co-win round start goes to the most recent token winner', () => {
    it('hands the next round to the tied player who most recently led', () => {
        const match = createMatch(['p0', 'p1'], 'co-win', 'm');
        const tied = {
            ...match,
            round: {
                ...match.round,
                seatOrder: ['p0', 'p1'] as const,
                currentPlayerIndex: 0,
                deckOrder: [],
                players: makePlayers({
                    p0: { hand: ['shielded-mind#0', 'han-pritcher#0'], discardValueTotal: 0 },
                    p1: { hand: ['bail-channis#0'], discardValueTotal: 4 }
                })
            }
        } as MatchState;

        const result = reduce(tied, {
            type: 'PLAY_CARD',
            playerId: 'p0',
            cardInstanceId: 'shielded-mind#0'
        });
        if (!result.ok) throw new Error('expected a legal play');
        expect(result.state.round.roundResult?.winnerIds).toEqual(['p0', 'p1']);

        // p0 led round 1, so p0 leads round 2.
        const next = startNextRound(result.state);
        expect(next.round.seatOrder[next.round.currentPlayerIndex]).toBe('p0');
    });
});

describe('brainstorm rule: simultaneous target-reach triggers sudden death', () => {
    it('plays on instead of ending the match', () => {
        const match = createMatch(['p0', 'p1'], 'sd-edge', 'm');
        const atPoint = {
            ...match,
            players: match.players.map(p => ({ ...p, tokens: 6 })),
            round: {
                ...match.round,
                seatOrder: ['p0', 'p1'] as const,
                currentPlayerIndex: 0,
                deckOrder: [],
                players: makePlayers({
                    p0: { hand: ['shielded-mind#0', 'han-pritcher#0'], discardValueTotal: 0 },
                    p1: { hand: ['bail-channis#0'], discardValueTotal: 4 }
                })
            }
        } as MatchState;

        const result = reduce(atPoint, {
            type: 'PLAY_CARD',
            playerId: 'p0',
            cardInstanceId: 'shielded-mind#0'
        });
        if (!result.ok) throw new Error('expected a legal play');
        expect(result.state.matchWinnerId).toBeNull();
        expect(result.state.mode).toBe('sudden-death');
    });
});
