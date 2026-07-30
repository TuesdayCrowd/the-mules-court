import { describe, expect, it } from 'bun:test';
import type { PlayerId, RedactedView } from '../game/engine';
import type { SeatClient, SeatIdentity, SeatPlay, StateUpdate } from './seatClient';
import { MatchSession, type Seat } from './session';

/** SeatClient must satisfy the contract the session depends on, without importing it. */
const _contract: (client: SeatClient) => Seat = client => client;
void _contract;

function makeView(playerId: PlayerId, overrides: Partial<RedactedView> = {}): RedactedView {
    return {
        matchId: 'match-1',
        playerCount: 4,
        tokensToWin: 4,
        mode: 'normal',
        players: (['p1', 'p2', 'p3', 'p4'] as const).map((id, seat) => ({
            id,
            seat,
            tokens: 0,
            alive: true,
            protected: false,
            discardPile: [],
            discardValueTotal: 0
        })),
        deckCount: 9,
        setAsideFaceUp: null,
        removedFaceDownCount: 1,
        currentPlayerId: 'p1',
        turnNumber: 1,
        publicLog: [],
        roundHistory: [],
        own: { playerId, hand: [`informant#${playerId.slice(1)}`], legalPlays: [], legalTargets: {} },
        revealed: [],
        roundResult: null,
        matchWinnerId: null,
        ...overrides
    } as RedactedView;
}

function makeState(playerId: PlayerId, overrides: Partial<StateUpdate> = {}, view: Partial<RedactedView> = {}): StateUpdate {
    return {
        type: 'STATE_UPDATE',
        view: makeView(playerId, view),
        nicknames: { p1: 'Human', p2: 'Bayta', p3: 'Toran', p4: 'Magnifico' },
        phase: 'active',
        paused: false,
        missingSeats: [],
        serverTime: 1_000,
        ...overrides
    } as StateUpdate;
}

class FakeSeat implements Seat {
    lastState: StateUpdate | null = null;
    lastError: { readonly code: 'PAUSED' | 'NOT_YOUR_SEAT' } | null = null;
    readonly plays: SeatPlay[] = [];
    closed = false;
    private waiters: ((state: StateUpdate) => void)[] = [];

    constructor(readonly identity: SeatIdentity) {}

    push(state: StateUpdate): void {
        this.lastState = state;
        for (const resolve of this.waiters.splice(0)) resolve(state);
    }

    nextState(timeoutMs = 50): Promise<StateUpdate> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('fake seat: timeout')), timeoutMs);
            this.waiters.push(state => {
                clearTimeout(timer);
                resolve(state);
            });
        });
    }

    play(move: SeatPlay): void {
        this.plays.push(move);
    }

    close(): void {
        this.closed = true;
    }
}

/** A session already holding p2/p3/p4, with the fakes returned for driving. */
async function seatedSession() {
    const fakes: FakeSeat[] = [];
    const session = new MatchSession({
        connect: async (_url, _matchId, nickname) => {
            const playerId = `p${fakes.length + 2}` as PlayerId;
            const fake = new FakeSeat({ seat: fakes.length + 1, playerId, seatToken: `token-${playerId}`, nickname });
            fakes.push(fake);
            return fake;
        }
    });
    const joined = await session.joinMatch({ matchId: 'match-1', nicknames: ['Bayta', 'Toran', 'Magnifico'], serverUrl: 'ws://x' });
    return { session, fakes, joined };
}

describe('joinMatch', () => {
    it('returns one handle per nickname, all distinct', async () => {
        const { joined } = await seatedSession();
        expect(joined.map(s => s.nickname)).toEqual(['Bayta', 'Toran', 'Magnifico']);
        expect(new Set(joined.map(s => s.handle)).size).toBe(3);
    });

    it('is the only place a handle is ever returned', async () => {
        const { session, joined } = await seatedSession();
        const everythingElse = JSON.stringify([session.tableStatus(), await session.awaitTurn(0)]);
        for (const seat of joined) expect(everythingElse).not.toContain(seat.handle);
    });
});

describe('seat-scoped tools refuse an unknown handle', () => {
    it('refuses get_view, play_card, and both notebook calls', async () => {
        const { session } = await seatedSession();
        expect(session.getView('nope').ok).toBe(false);
        expect(session.readNotebook('nope').ok).toBe(false);
        expect(session.writeNotebook('nope', 'x').ok).toBe(false);
        expect((await session.playCard('nope', { cardInstanceId: 'informant#0' })).ok).toBe(false);
    });

    it('names the failure as a missing capability rather than a rule', async () => {
        const { session } = await seatedSession();
        const result = session.getView('nope');
        expect(result.ok === false && result.error).toBe('UNKNOWN_HANDLE');
    });
});

describe('getView', () => {
    it('serves the view belonging to that handle and no other', async () => {
        const { session, fakes, joined } = await seatedSession();
        fakes.forEach(fake => fake.push(makeState(fake.identity.playerId)));

        const result = session.getView(joined[1]!.handle);
        expect(result.ok).toBe(true);
        expect(result.ok === true && result.view.own.playerId).toBe('p3');
    });

    it('reports that the match has not started rather than inventing a view', async () => {
        const { session, joined } = await seatedSession();
        expect(session.getView(joined[0]!.handle).ok).toBe(false);
    });
});

describe('tableStatus', () => {
    it('carries the roster, phase, and public log, and no hand at all', async () => {
        const { session, fakes } = await seatedSession();
        fakes.forEach(fake => fake.push(makeState(fake.identity.playerId)));

        const status = session.tableStatus();
        expect(status.seats.map(s => s.playerId)).toEqual(['p2', 'p3', 'p4']);
        expect(status.phase).toBe('active');

        // Blunt, as elsewhere: every hand the session can see, absent from the
        // one tool the referee is allowed to call.
        const serialized = JSON.stringify(status);
        for (const fake of fakes) {
            for (const card of fake.lastState!.view.own.hand) {
                expect(serialized).not.toContain(card);
            }
        }
    });
});

describe('awaitTurn', () => {
    it('returns immediately when a held seat holds the turn', async () => {
        const { session, fakes } = await seatedSession();
        fakes.forEach(f => f.push(makeState(f.identity.playerId, {}, { currentPlayerId: 'p3' })));

        const signal = await session.awaitTurn(50);
        expect(signal.status).toBe('your_turn');
        expect(signal.seat).toBe('p3');
    });

    it('keeps waiting while the human is up, then reports waiting on timeout', async () => {
        const { session, fakes } = await seatedSession();
        fakes.forEach(f => f.push(makeState(f.identity.playerId, {}, { currentPlayerId: 'p1' })));

        const signal = await session.awaitTurn(30);
        expect(signal.status).toBe('waiting');
        expect(signal.seat).toBeUndefined();
    });

    it('unblocks when a later push hands a held seat the turn', async () => {
        const { session, fakes } = await seatedSession();
        fakes.forEach(f => f.push(makeState(f.identity.playerId, {}, { currentPlayerId: 'p1' })));

        const pending = session.awaitTurn(500);
        setTimeout(() => fakes.forEach(f => f.push(makeState(f.identity.playerId, {}, { currentPlayerId: 'p4' }))), 10);

        expect((await pending).status).toBe('your_turn');
    });

    it('returns match_over without waiting', async () => {
        const { session, fakes } = await seatedSession();
        fakes.forEach(f => f.push(makeState(f.identity.playerId, { phase: 'ended' })));
        expect((await session.awaitTurn(500)).status).toBe('match_over');
    });

    it('will not hand a seat its turn on another seat\'s word', async () => {
        // The cross-socket race Stage 4 caught. p2's frame has landed and says
        // p3 is up; p3's own frame for that commit has not arrived, so its
        // view still carries the previous turn — and own.legalPlays is
        // populated only in the frame where its viewer holds the turn. Acting
        // here hands p3 a turn with no legal move in it.
        const { session, fakes } = await seatedSession();
        fakes[0]!.push(makeState('p2', {}, { currentPlayerId: 'p3' }));
        fakes[1]!.push(makeState('p3', {}, { currentPlayerId: 'p1' }));

        expect((await session.awaitTurn(30)).status).toBe('waiting');

        // Once p3's own frame lands, the turn is real and the view can back it.
        fakes[1]!.push(makeState('p3', {}, { currentPlayerId: 'p3' }));
        const signal = await session.awaitTurn(30);
        expect(signal.status).toBe('your_turn');
        expect(signal.seat).toBe('p3');
    });
});

describe('notebooks', () => {
    it('route by handle and stay out of each other', async () => {
        const { session, joined } = await seatedSession();
        session.writeNotebook(joined[0]!.handle, 'p1 dodged a 5');

        const mine = session.readNotebook(joined[0]!.handle);
        const theirs = session.readNotebook(joined[1]!.handle);
        expect(mine.ok === true && mine.text).toBe('p1 dodged a 5');
        expect(theirs.ok === true && theirs.text).toBe('');
    });
});

describe('playCard', () => {
    it('does not confirm until the seat\'s own view has moved on', async () => {
        // The bug the stdio suite caught. Confirming on "a push arrived" is
        // satisfied by a repaint of the same turn — and the referee then loops,
        // gets handed the same turn again, and finds no legal plays.
        const { session, fakes, joined } = await seatedSession();
        fakes.forEach(f => f.push(makeState(f.identity.playerId, {}, { currentPlayerId: 'p2', turnNumber: 3 })));

        const pending = session.playCard(joined[0]!.handle, { cardInstanceId: 'informant#0' }, 400);

        // A repaint of the SAME turn must not count as confirmation.
        setTimeout(() => fakes[0]!.push(makeState('p2', { paused: true }, { currentPlayerId: 'p2', turnNumber: 3 })), 10);
        // Only the turn actually advancing does.
        setTimeout(() => fakes[0]!.push(makeState('p2', {}, { currentPlayerId: 'p3', turnNumber: 4 })), 60);

        expect((await pending).ok).toBe(true);
        const view = session.getView(joined[0]!.handle);
        expect(view.ok === true && view.view.currentPlayerId).toBe('p3');
    });

    it('reports NO_RESPONSE when the table never moves on', async () => {
        const { session, fakes, joined } = await seatedSession();
        fakes.forEach(f => f.push(makeState(f.identity.playerId, {}, { currentPlayerId: 'p2', turnNumber: 3 })));

        const result = await session.playCard(joined[0]!.handle, { cardInstanceId: 'informant#0' }, 60);
        expect(result.ok === false && result.error).toBe('NO_RESPONSE');
    });

    it('names the engine\'s own refusal instead of reporting a timeout', async () => {
        // Found by a 40-match soak: two matches died reporting NO_RESPONSE when
        // the round had advanced underneath a play that was already chosen. The
        // server had said exactly why; nothing was reading it.
        const { session, fakes, joined } = await seatedSession();
        fakes.forEach(f => f.push(makeState(f.identity.playerId, {}, { currentPlayerId: 'p2', turnNumber: 3 })));

        setTimeout(() => {
            fakes[0]!.lastError = { code: 'NOT_YOUR_SEAT' };
        }, 10);

        const result = await session.playCard(joined[0]!.handle, { cardInstanceId: 'informant#0' }, 2000);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.error).toBe('NOT_YOUR_SEAT');
    });

    it('ignores a stale error left over from an earlier turn', async () => {
        const { session, fakes, joined } = await seatedSession();
        fakes[0]!.lastError = { code: 'PAUSED' };
        fakes.forEach(f => f.push(makeState(f.identity.playerId, {}, { currentPlayerId: 'p2', turnNumber: 3 })));

        setTimeout(() => fakes[0]!.push(makeState('p2', {}, { currentPlayerId: 'p3', turnNumber: 4 })), 20);
        expect((await session.playCard(joined[0]!.handle, { cardInstanceId: 'informant#0' }, 500)).ok).toBe(true);
    });

    it('sends the move on the socket that handle authorises', async () => {
        const { session, fakes, joined } = await seatedSession();
        fakes.forEach(f => f.push(makeState(f.identity.playerId)));

        const pending = session.playCard(joined[2]!.handle, { cardInstanceId: 'informant#0', target: 'p1', guess: 5 });
        setTimeout(() => fakes[2]!.push(makeState('p4')), 5);
        await pending;

        expect(fakes[2]!.plays).toEqual([{ cardInstanceId: 'informant#0', target: 'p1', guess: 5 }]);
        expect(fakes[0]!.plays).toEqual([]);
    });
});
