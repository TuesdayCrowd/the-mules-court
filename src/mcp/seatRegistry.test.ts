import { describe, expect, it } from 'bun:test';
import { SeatRegistry } from './seatRegistry';

/** A deterministic mint, so a test can name the handle it expects to be absent. */
function countingMint(): () => string {
    let n = 0;
    return () => `handle-${++n}`;
}

function claimThree(registry: SeatRegistry): readonly string[] {
    return [
        registry.claim({ playerId: 'p2', seat: 1, nickname: 'Bayta', seatToken: 'token-p2' }),
        registry.claim({ playerId: 'p3', seat: 2, nickname: 'Toran', seatToken: 'token-p3' }),
        registry.claim({ playerId: 'p4', seat: 3, nickname: 'Magnifico', seatToken: 'token-p4' })
    ];
}

describe('SeatRegistry handles', () => {
    it('mints 128 bits of hex, matching the shape seatTokens.ts uses', () => {
        const registry = new SeatRegistry();
        const handle = registry.claim({ playerId: 'p2', seat: 1, nickname: 'Bayta', seatToken: 't' });
        expect(handle).toMatch(/^[0-9a-f]{32}$/);
    });

    it('mints a distinct handle per seat', () => {
        const registry = new SeatRegistry();
        const handles = claimThree(registry);
        expect(new Set(handles).size).toBe(3);
    });

    it('resolves a handle to its own seat', () => {
        const registry = new SeatRegistry(countingMint());
        const [h2] = claimThree(registry);
        expect(registry.resolve(h2)?.playerId).toBe('p2');
        expect(registry.resolve(h2)?.seatToken).toBe('token-p2');
    });

    it('resolves an unknown handle to undefined rather than throwing', () => {
        const registry = new SeatRegistry();
        claimThree(registry);
        expect(registry.resolve('not-a-handle')).toBeUndefined();
    });

    it('never resolves one seat\'s handle to another seat', () => {
        const registry = new SeatRegistry(countingMint());
        const [h2, h3, h4] = claimThree(registry);
        // The isolation property stated as a property rather than an example:
        // each handle resolves to exactly one seat, and never to a sibling.
        expect(registry.resolve(h2)?.playerId).toBe('p2');
        expect(registry.resolve(h3)?.playerId).toBe('p3');
        expect(registry.resolve(h4)?.playerId).toBe('p4');
    });
});

describe('SeatRegistry public roster', () => {
    it('names each seat for the referee', () => {
        const registry = new SeatRegistry(countingMint());
        claimThree(registry);
        expect(registry.roster()).toEqual([
            { playerId: 'p2', seat: 1, nickname: 'Bayta' },
            { playerId: 'p3', seat: 2, nickname: 'Toran' },
            { playerId: 'p4', seat: 3, nickname: 'Magnifico' }
        ]);
    });

    it('carries neither a handle nor a seat token', () => {
        // Blunt on purpose, the way the transport suite bans forbidden
        // substrings from client frames: a field-by-field assertion passes
        // through the serialization mistake it is meant to catch.
        const registry = new SeatRegistry(countingMint());
        const handles = claimThree(registry);
        const serialized = JSON.stringify(registry.roster());

        for (const handle of handles) {
            expect(serialized).not.toContain(handle);
        }
        for (const token of ['token-p2', 'token-p3', 'token-p4']) {
            expect(serialized).not.toContain(token);
        }
    });

    it('lists the player ids it holds, which is what routes a turn', () => {
        const registry = new SeatRegistry(countingMint());
        claimThree(registry);
        expect(registry.heldPlayerIds()).toEqual(['p2', 'p3', 'p4']);
    });
});

describe('SeatRegistry notebooks', () => {
    it('starts a claimed seat with an empty notebook, not an absent one', () => {
        const registry = new SeatRegistry(countingMint());
        const [h2] = claimThree(registry);
        expect(registry.readNotebook(h2)).toBe('');
    });

    it('distinguishes an unknown handle from an empty notebook', () => {
        const registry = new SeatRegistry();
        expect(registry.readNotebook('not-a-handle')).toBeUndefined();
        expect(registry.writeNotebook('not-a-handle', 'anything')).toBe(false);
    });

    it('round-trips what a seat wrote', () => {
        const registry = new SeatRegistry(countingMint());
        const [h2] = claimThree(registry);
        expect(registry.writeNotebook(h2, 'p1 dodged a 5 guess on turn 3')).toBe(true);
        expect(registry.readNotebook(h2)).toBe('p1 dodged a 5 guess on turn 3');
    });

    it('keeps one seat\'s notes out of another seat\'s notebook', () => {
        const registry = new SeatRegistry(countingMint());
        const [h2, h3] = claimThree(registry);
        registry.writeNotebook(h2, 'p2 thinks p1 holds the Mule');
        expect(registry.readNotebook(h3)).toBe('');
    });
});

describe('SeatRegistry reconnection', () => {
    it('replaces a seat token without minting a new handle', () => {
        // A resumed socket gets no new token from the server, but the seat may
        // be re-claimed after a reap. The handle must survive either way: the
        // agent holding it has notes it would otherwise lose.
        const registry = new SeatRegistry(countingMint());
        const [h2] = claimThree(registry);
        registry.writeNotebook(h2, 'p1 is hoarding');

        expect(registry.refreshToken(h2, 'token-p2-second')).toBe(true);
        expect(registry.resolve(h2)?.seatToken).toBe('token-p2-second');
        expect(registry.readNotebook(h2)).toBe('p1 is hoarding');
    });

    it('refuses to refresh a token for an unknown handle', () => {
        const registry = new SeatRegistry();
        expect(registry.refreshToken('not-a-handle', 'token')).toBe(false);
    });
});
