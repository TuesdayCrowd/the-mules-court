import { describe, expect, it } from 'bun:test';
import { routeTurn, type TurnInput } from './turnRouter';

const HELD = ['p2', 'p3', 'p4'] as const;

/** The human holds p1; the MCP holds the other three. */
function input(overrides: Partial<TurnInput> = {}): TurnInput {
    return {
        heldPlayerIds: HELD,
        currentPlayerId: 'p3',
        turnNumber: 7,
        phase: 'active',
        paused: false,
        ...overrides
    };
}

describe('routeTurn during an active round', () => {
    it('routes to the held seat whose turn it is', () => {
        const signal = routeTurn(input({ currentPlayerId: 'p3' }));
        expect(signal.status).toBe('your_turn');
        expect(signal.seat).toBe('p3');
    });

    it('waits when the turn belongs to a seat we do not hold', () => {
        const signal = routeTurn(input({ currentPlayerId: 'p1' }));
        expect(signal.status).toBe('waiting');
    });

    it('echoes the turn number and phase, which the referee narrates', () => {
        const signal = routeTurn(input({ turnNumber: 12 }));
        expect(signal.turnNumber).toBe(12);
        expect(signal.phase).toBe('active');
    });
});

describe('routeTurn precedence', () => {
    it('reports round_over during a reveal, whoever holds the turn', () => {
        // The reveal window is a server timer; nobody may play through it.
        const signal = routeTurn(input({ phase: 'round_over', currentPlayerId: 'p3' }));
        expect(signal.status).toBe('round_over');
        expect(signal.seat).toBeUndefined();
    });

    it('reports match_over once the match has ended', () => {
        const signal = routeTurn(input({ phase: 'ended', currentPlayerId: 'p3' }));
        expect(signal.status).toBe('match_over');
        expect(signal.seat).toBeUndefined();
    });

    it('waits while the room is paused, even on a held seat\'s turn', () => {
        // dispatch.ts answers PLAY_CARD with PAUSED while a seat is missing.
        // Routing to `your_turn` here would send an agent to earn that error.
        const signal = routeTurn(input({ paused: true, currentPlayerId: 'p3' }));
        expect(signal.status).toBe('waiting');
        expect(signal.seat).toBeUndefined();
    });

    it('still reports match_over when a paused match has ended', () => {
        const signal = routeTurn(input({ phase: 'ended', paused: true }));
        expect(signal.status).toBe('match_over');
    });
});

describe('routeTurn carries no seat it was not asked for', () => {
    it('omits the seat key entirely unless it is a held seat\'s turn', () => {
        // Blunt on purpose, as with the roster: a signal that serialises a
        // seat under any other status has leaked routing into a wait.
        for (const overrides of [
            { currentPlayerId: 'p1' },
            { phase: 'round_over' as const },
            { phase: 'ended' as const },
            { paused: true }
        ]) {
            expect(JSON.stringify(routeTurn(input(overrides)))).not.toContain('"seat"');
        }
    });

    it('never carries a hand, a deck, or anything but routing', () => {
        expect(Object.keys(routeTurn(input())).sort()).toEqual([
            'phase',
            'seat',
            'status',
            'turnNumber'
        ]);
    });
});
