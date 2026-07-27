import { describe, it, expect } from 'vitest';
import { view, broadcastViews } from '../view';
import { reduce } from '../reduce';
import { createMatch } from '../setup';
import type { MatchState } from '../types';

const match = (): MatchState => {
    const base = createMatch(['p0', 'p1', 'p2'], 'view-seed');
    return {
        ...base,
        round: {
            ...base.round,
            seatOrder: ['p0', 'p1', 'p2'],
            currentPlayerIndex: 0,
            deckOrder: ['mule#0', 'magnifico#0', 'shielded-mind#0'],
            setAsideFaceDown: ['first-speaker#0'],
            players: {
                p0: { ...base.round.players.p0, hand: ['han-pritcher#0', 'informant#0'] },
                p1: { ...base.round.players.p1, hand: ['mayor-indbur#0'] },
                p2: { ...base.round.players.p2, hand: ['bail-channis#0'] }
            }
        }
    };
};

describe('view — what a player sees of themselves', () => {
    it('shows the viewer their own hand', () => {
        expect(view(match(), 'p0').own.hand).toEqual(['han-pritcher#0', 'informant#0']);
    });

    it('offers legal plays only to the player holding the turn', () => {
        expect(view(match(), 'p0').own.legalPlays).toEqual(['han-pritcher#0', 'informant#0']);
        expect(view(match(), 'p1').own.legalPlays).toEqual([]);
    });

    it('reports the viewer\'s own id', () => {
        expect(view(match(), 'p2').own.playerId).toBe('p2');
    });
});

describe('view — legal targets', () => {
    /** p0 holds a Darell (self-targetable) and an Informant (not). */
    const darellMatch = (overrides: Partial<MatchState['round']['players']> = {}): MatchState => {
        const base = match();
        return {
            ...base,
            round: {
                ...base.round,
                players: {
                    ...base.round.players,
                    p0: { ...base.round.players.p0, hand: ['toran-darell#0', 'informant#0'] },
                    ...overrides
                }
            }
        };
    };

    it('answers for every legal play, so the client never has to derive one', () => {
        const own = view(darellMatch(), 'p0').own;
        expect(Object.keys(own.legalTargets).sort()).toEqual([...own.legalPlays].sort());
    });

    it('includes the viewer for a card that may target its own player', () => {
        // Value 5 is "choose any player". The client cannot know that without
        // being told, and guessing it wrong is what stranded a turn.
        expect(view(darellMatch(), 'p0').own.legalTargets['toran-darell#0']).toContain('p0');
    });

    it('excludes the viewer for a card that may not', () => {
        expect(view(darellMatch(), 'p0').own.legalTargets['informant#0']).not.toContain('p0');
    });

    it('excludes a protected opponent but never a protected self', () => {
        const guarded = darellMatch();
        const state: MatchState = {
            ...guarded,
            round: {
                ...guarded.round,
                players: {
                    ...guarded.round.players,
                    p0: { ...guarded.round.players.p0, protected: true },
                    p1: { ...guarded.round.players.p1, protected: true }
                }
            }
        };

        const targets = view(state, 'p0').own.legalTargets['toran-darell#0'];
        expect(targets).toContain('p0'); // protection is against other players
        expect(targets).not.toContain('p1');
        expect(targets).toContain('p2');
    });

    it('excludes an eliminated player', () => {
        const base = darellMatch();
        const state: MatchState = {
            ...base,
            round: {
                ...base.round,
                players: { ...base.round.players, p2: { ...base.round.players.p2, alive: false } }
            }
        };
        expect(view(state, 'p0').own.legalTargets['toran-darell#0']).not.toContain('p2');
    });

    it('is empty for a card that takes no target at all', () => {
        const base = match();
        const state: MatchState = {
            ...base,
            round: {
                ...base.round,
                players: { ...base.round.players, p0: { ...base.round.players.p0, hand: ['shielded-mind#0'] } }
            }
        };
        expect(view(state, 'p0').own.legalTargets['shielded-mind#0']).toEqual([]);
    });

    it('offers nothing to a player who does not hold the turn', () => {
        expect(view(darellMatch(), 'p1').own.legalTargets).toEqual({});
    });

    it('names only players, never a card', () => {
        const serialized = JSON.stringify(view(darellMatch(), 'p0').own.legalTargets);
        for (const id of ['mayor-indbur', 'bail-channis', 'mule']) {
            expect(serialized).not.toContain(id);
        }
    });
});

describe('view — hidden information', () => {
    const hidden = ['mayor-indbur#0', 'bail-channis#0', 'mule#0', 'magnifico#0', 'first-speaker#0'];

    it('never leaks another player\'s hand, the deck, or the set-aside card', () => {
        const serialized = JSON.stringify(view(match(), 'p0'));
        for (const card of hidden) {
            expect(serialized, card).not.toContain(card);
        }
    });

    it('reports the deck as a count, never as an array', () => {
        const projection = view(match(), 'p0');
        expect(projection.deckCount).toBe(3);
        expect(Array.isArray((projection as unknown as Record<string, unknown>).deckOrder)).toBe(false);
    });

    it('carries no rng and no seed', () => {
        const projection = view(match(), 'p0') as unknown as Record<string, unknown>;
        expect(projection.rng).toBeUndefined();
        expect(projection.seed).toBeUndefined();
        expect(projection.actionLog).toBeUndefined();
        expect(JSON.stringify(projection)).not.toContain('view-seed');
    });

    it('exposes no privateKnowledge array', () => {
        expect((view(match(), 'p0') as unknown as Record<string, unknown>).privateKnowledge).toBeUndefined();
    });
});

describe('view — public information', () => {
    it('shows every player\'s tokens, liveness and discard pile', () => {
        const projection = view(match(), 'p0');
        expect(projection.players).toHaveLength(3);
        for (const player of projection.players) {
            expect(player).toHaveProperty('tokens');
            expect(player).toHaveProperty('alive');
            expect(player).toHaveProperty('discardValueTotal');
            expect(player).not.toHaveProperty('hand');
        }
    });

    it('shows the two-player face-up burn as a card type', () => {
        const heads = createMatch(['p0', 'p1'], 'faceup');
        const projection = view(heads, 'p0');
        expect(projection.setAsideFaceUp).not.toBeNull();
        expect(projection.setAsideFaceUp).not.toContain('#');
    });

    it('hides the face-down set-aside card entirely', () => {
        expect(JSON.stringify(view(match(), 'p0'))).not.toContain('first-speaker');
    });
});

describe('view — derived private knowledge', () => {
    /** p0 plays Han Pritcher and peeks at p1's hand. */
    const afterPeek = () => {
        const result = reduce(match(), {
            type: 'PLAY_CARD',
            playerId: 'p0',
            cardInstanceId: 'han-pritcher#0',
            target: 'p1'
        });
        if (!result.ok) throw new Error('expected a legal play');
        return result.state;
    };

    it('shows the peeked card to the viewer who earned it', () => {
        expect(view(afterPeek(), 'p0').revealed).toEqual([
            { subjectId: 'p1', cardTypeId: 'mayor-indbur' }
        ]);
    });

    it('shows that knowledge to nobody else', () => {
        expect(view(afterPeek(), 'p2').revealed).toEqual([]);
        expect(JSON.stringify(view(afterPeek(), 'p2'))).not.toContain('mayor-indbur');
    });

    it('stops showing a peek once the card leaves that hand', () => {
        const peeked = afterPeek();
        // p1 plays away the card p0 had seen.
        const played = reduce(peeked, {
            type: 'PLAY_CARD',
            playerId: 'p1',
            cardInstanceId: 'mayor-indbur#0',
            target: 'p2'
        });
        if (!played.ok) throw new Error('expected a legal play');
        expect(view(played.state, 'p0').revealed).toEqual([]);
    });
});

describe('view — round results', () => {
    it('withholds a result while the round is live', () => {
        expect(view(match(), 'p0').roundResult).toBeNull();
    });
});

describe('broadcastViews', () => {
    it('returns one projection per player', () => {
        const views = broadcastViews(match(), ['p0', 'p1', 'p2']);
        expect(Object.keys(views).sort()).toEqual(['p0', 'p1', 'p2']);
        expect(views.p0.own.hand).toEqual(['han-pritcher#0', 'informant#0']);
        expect(views.p1.own.hand).toEqual(['mayor-indbur#0']);
    });
});
