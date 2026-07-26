import { describe, expect, it } from 'vitest';
import type { ClientMessage, ServerMessage } from '../../server/protocol';
import type { StoredSeat } from './seatTokenStore';
import type { ConnectionStatus } from './types';
import type { SocketDeps, WebSocketLike } from './socket';
import { createSocket, parseServerMessage, socketUrl } from './socket';

// ------------------------------------------------------------------- fakes

/** A WebSocketLike that records what it was told and lets a test fire its handlers. */
class FakeSocket implements WebSocketLike {
    readonly sent: string[] = [];
    closed = false;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(readonly url: string) {}

    send(data: string): void {
        this.sent.push(data);
    }

    close(): void {
        this.closed = true;
    }

    /** The frames this socket was given, parsed back into messages. */
    frames(): ClientMessage[] {
        return this.sent.map(raw => JSON.parse(raw) as ClientMessage);
    }
}

function fakeTransport() {
    const sockets: FakeSocket[] = [];
    return {
        sockets,
        open: (url: string): WebSocketLike => {
            const socket = new FakeSocket(url);
            sockets.push(socket);
            return socket;
        },
        last(): FakeSocket {
            // Index arithmetic, not `.at(-1)`: tsconfig's lib is ES2020 and the
            // rest of the codebase never reaches for ES2022 array methods.
            if (sockets.length === 0) throw new Error('no socket has been opened');
            return sockets[sockets.length - 1];
        }
    };
}

interface Pending {
    readonly handle: number;
    readonly fn: () => void;
    readonly ms: number;
}

/** Deterministic timers: nothing fires until a test says so. */
function fakeTimers() {
    let nextHandle = 1;
    let pending: Pending[] = [];
    const delays: number[] = [];

    return {
        delays,
        pendingCount: () => pending.length,
        timers: {
            setTimeout(fn: () => void, ms: number): number {
                const handle = nextHandle++;
                delays.push(ms);
                pending.push({ handle, fn, ms });
                return handle;
            },
            clearTimeout(handle: unknown): void {
                pending = pending.filter(entry => entry.handle !== handle);
            }
        },
        /** Fire every timer scheduled so far, oldest first. */
        run(): void {
            const due = pending;
            pending = [];
            for (const entry of due) entry.fn();
        }
    };
}

const SEAT: StoredSeat = { seat: 0, playerId: 'p1', seatToken: 'tok-abc' };

interface Harness {
    readonly transport: ReturnType<typeof fakeTransport>;
    readonly clock: ReturnType<typeof fakeTimers>;
    readonly received: ServerMessage[];
    readonly statuses: ConnectionStatus[];
    readonly socket: ReturnType<typeof createSocket>;
}

function harness(overrides: Partial<SocketDeps> = {}): Harness {
    const transport = fakeTransport();
    const clock = fakeTimers();
    const received: ServerMessage[] = [];
    const statuses: ConnectionStatus[] = [];

    const socket = createSocket({
        url: 'ws://court.test/ws',
        matchId: 'K7QX2',
        open: transport.open,
        storedSeat: () => null,
        nickname: () => undefined,
        onMessage: msg => received.push(msg),
        onStatus: status => statuses.push(status),
        timers: clock.timers,
        random: () => 0.5,
        ...overrides
    });

    return { transport, clock, received, statuses, socket };
}

/** Drive one full failed-connection cycle: open the socket, then drop it. */
function dropConnection(h: Harness): void {
    h.transport.last().onclose?.();
}

// -------------------------------------------------------------------- tests

describe('socketUrl', () => {
    it('upgrades http to ws on the same origin', () => {
        expect(socketUrl('http://localhost:8080')).toBe('ws://localhost:8080/ws');
    });

    it('upgrades https to wss', () => {
        expect(socketUrl('https://court.example.com')).toBe('wss://court.example.com/ws');
    });
});

describe('parseServerMessage', () => {
    it('returns the message for a well-formed frame', () => {
        expect(parseServerMessage(JSON.stringify({ type: 'PONG' }))).toEqual({ type: 'PONG' });
    });

    it('returns null for a frame that is not JSON', () => {
        expect(parseServerMessage('{not json')).toBeNull();
    });

    it('returns null for JSON that is not an object', () => {
        expect(parseServerMessage('"PONG"')).toBeNull();
        expect(parseServerMessage('[]')).toBeNull();
        expect(parseServerMessage('null')).toBeNull();
    });

    it('returns null for an object with no known type', () => {
        expect(parseServerMessage(JSON.stringify({ type: 'SURRENDER' }))).toBeNull();
        expect(parseServerMessage(JSON.stringify({ code: 'BAD_TOKEN' }))).toBeNull();
    });
});

describe('createSocket handshake', () => {
    it('sends RESUME_SEAT carrying the nickname as its first frame when a token is stored', () => {
        const h = harness({ storedSeat: () => SEAT, nickname: () => 'Cornelius' });
        h.socket.connect();
        h.transport.last().onopen?.();

        expect(h.transport.last().frames()).toEqual([
            { type: 'RESUME_SEAT', matchId: 'K7QX2', seatToken: 'tok-abc', nickname: 'Cornelius' }
        ]);
    });

    it('omits the nickname key entirely when none is known', () => {
        const h = harness({ storedSeat: () => SEAT });
        h.socket.connect();
        h.transport.last().onopen?.();

        expect(h.transport.last().frames()).toEqual([{ type: 'RESUME_SEAT', matchId: 'K7QX2', seatToken: 'tok-abc' }]);
    });

    it('omits a blank nickname rather than sending one the server calls MALFORMED', () => {
        // parseNickname trims and rejects empty, and an invalid nickname fails the
        // whole frame — a blank name would cost the seat, not just the name.
        const h = harness({ storedSeat: () => SEAT, nickname: () => '   ' });
        h.socket.connect();
        h.transport.last().onopen?.();

        expect(h.transport.last().frames()).toEqual([{ type: 'RESUME_SEAT', matchId: 'K7QX2', seatToken: 'tok-abc' }]);
    });

    it('omits a nickname the server would reject for length, keeping the resume alive', () => {
        // parseNickname caps at maxNicknameLength (24). An over-length name fails
        // the WHOLE frame as MALFORMED, so sending it costs the seat; dropping it
        // costs only the name, which the lobby already falls back to 'Host' for.
        const h = harness({ storedSeat: () => SEAT, nickname: () => 'C'.repeat(25) });
        h.socket.connect();
        h.transport.last().onopen?.();

        expect(h.transport.last().frames()).toEqual([{ type: 'RESUME_SEAT', matchId: 'K7QX2', seatToken: 'tok-abc' }]);
    });

    it('sends a nickname of exactly the maximum length', () => {
        const h = harness({ storedSeat: () => SEAT, nickname: () => 'C'.repeat(24) });
        h.socket.connect();
        h.transport.last().onopen?.();

        expect(h.transport.last().frames()[0]).toHaveProperty('nickname', 'C'.repeat(24));
    });

    it('omits a nickname carrying a control character, which trim cannot remove', () => {
        const h = harness({ storedSeat: () => SEAT, nickname: () => 'Ana\u0007na' });
        h.socket.connect();
        h.transport.last().onopen?.();

        expect(h.transport.last().frames()).toEqual([{ type: 'RESUME_SEAT', matchId: 'K7QX2', seatToken: 'tok-abc' }]);
    });

    it('sends a trimmed nickname, matching what the server would store', () => {
        const h = harness({ storedSeat: () => SEAT, nickname: () => '  Ana  ' });
        h.socket.connect();
        h.transport.last().onopen?.();

        expect(h.transport.last().frames()[0]).toHaveProperty('nickname', 'Ana');
    });

    it('sends nothing on open when no token is stored — the join flow drives CLAIM_SEAT', () => {
        const h = harness();
        h.socket.connect();
        h.transport.last().onopen?.();

        expect(h.transport.last().sent).toEqual([]);
    });

    it('re-reads the stored seat on every open, so a seat claimed mid-session is resumed', () => {
        let seat: StoredSeat | null = null;
        const h = harness({ storedSeat: () => seat });

        h.socket.connect();
        h.transport.last().onopen?.();
        expect(h.transport.last().sent).toEqual([]);

        seat = SEAT; // SEAT_CLAIMED landed between the two connections
        dropConnection(h);
        h.clock.run();
        h.transport.last().onopen?.();

        expect(h.transport.last().frames()).toEqual([{ type: 'RESUME_SEAT', matchId: 'K7QX2', seatToken: 'tok-abc' }]);
    });
});

describe('createSocket inbound frames', () => {
    it('delivers a parsed ServerMessage to the sink exactly once', () => {
        const h = harness();
        h.socket.connect();
        h.transport.last().onopen?.();

        const pong: ServerMessage = { type: 'PONG' };
        h.transport.last().onmessage?.({ data: JSON.stringify(pong) });

        expect(h.received).toEqual([pong]);
    });

    it('drops an unparseable frame without throwing', () => {
        const h = harness();
        h.socket.connect();
        h.transport.last().onopen?.();

        expect(() => h.transport.last().onmessage?.({ data: '{not json' })).not.toThrow();
        expect(h.received).toEqual([]);
    });

    it('drops a well-formed frame of an unknown type', () => {
        const h = harness();
        h.socket.connect();
        h.transport.last().onopen?.();

        h.transport.last().onmessage?.({ data: JSON.stringify({ type: 'DEAL_ME_IN' }) });

        expect(h.received).toEqual([]);
    });
});

describe('createSocket reconnection', () => {
    it('walks 500, 1000, 2000, 4000, 8000, 8000 ms between attempts', () => {
        const h = harness();
        h.socket.connect();

        for (let attempt = 0; attempt < 6; attempt++) {
            dropConnection(h);
            h.clock.run();
        }

        expect(h.clock.delays).toEqual([500, 1000, 2000, 4000, 8000, 8000]);
    });

    it('jitters within a quarter of the base delay', () => {
        const h = harness({ random: () => 0 });
        h.socket.connect();
        dropConnection(h);
        expect(h.clock.delays).toEqual([375]); // 500 * 0.75

        const high = harness({ random: () => 1 });
        high.socket.connect();
        dropConnection(high);
        expect(high.clock.delays).toEqual([625]); // 500 * 1.25
    });

    it('resets the backoff to 500 after a successful open', () => {
        const h = harness();
        h.socket.connect();

        dropConnection(h);
        h.clock.run();
        dropConnection(h);
        h.clock.run();
        expect(h.clock.delays).toEqual([500, 1000]);

        h.transport.last().onopen?.(); // the third attempt lands
        dropConnection(h);

        expect(h.clock.delays).toEqual([500, 1000, 500]);
    });

    it('opens a fresh socket for each attempt', () => {
        const h = harness();
        h.socket.connect();
        dropConnection(h);
        h.clock.run();

        expect(h.transport.sockets).toHaveLength(2);
    });

    it('treats an error as nothing on its own — the close that follows drives the retry', () => {
        const h = harness();
        h.socket.connect();

        h.transport.last().onerror?.();
        expect(h.clock.pendingCount()).toBe(0);

        dropConnection(h);
        expect(h.clock.pendingCount()).toBe(1);
    });
});

describe('createSocket close', () => {
    it('cancels a pending reconnect and never reconnects', () => {
        const h = harness();
        h.socket.connect();
        dropConnection(h);
        expect(h.clock.pendingCount()).toBe(1);

        h.socket.close();

        expect(h.clock.pendingCount()).toBe(0);
        h.clock.run();
        expect(h.transport.sockets).toHaveLength(1);
    });

    it('closes the underlying socket', () => {
        const h = harness();
        h.socket.connect();

        h.socket.close();

        expect(h.transport.last().closed).toBe(true);
    });

    it('ignores a close event that arrives after the caller closed', () => {
        const h = harness();
        h.socket.connect();
        h.socket.close();

        dropConnection(h);

        expect(h.clock.pendingCount()).toBe(0);
        expect(h.statuses[h.statuses.length - 1]).toBe('closed');
    });
});

describe('createSocket status', () => {
    it('reports connecting, open, reconnecting, and closed in order', () => {
        const h = harness();
        h.socket.connect();
        h.transport.last().onopen?.();
        dropConnection(h);
        h.clock.run();
        h.transport.last().onopen?.();
        h.socket.close();

        expect(h.statuses).toEqual(['connecting', 'open', 'reconnecting', 'open', 'closed']);
    });

    it('ignores a second connect while one is already live', () => {
        const h = harness();
        h.socket.connect();
        h.socket.connect();

        expect(h.transport.sockets).toHaveLength(1);
        expect(h.statuses).toEqual(['connecting']);
    });
});

describe('createSocket send', () => {
    it('writes a JSON frame while open and reports the send', () => {
        const h = harness();
        h.socket.connect();
        h.transport.last().onopen?.();

        const sent = h.socket.send({ type: 'START_MATCH', matchId: 'K7QX2' });

        expect(sent).toBe(true);
        expect(h.transport.last().frames()).toEqual([{ type: 'START_MATCH', matchId: 'K7QX2' }]);
    });

    it('drops a frame while reconnecting and says so, rather than queueing it silently', () => {
        // A queued PLAY_CARD would arrive after the server has moved on. The
        // caller is told, so a pending play can be released instead of stranded.
        const h = harness();
        h.socket.connect();
        dropConnection(h);

        const sent = h.socket.send({ type: 'START_MATCH', matchId: 'K7QX2' });

        expect(sent).toBe(false);
        expect(h.transport.last().sent).toEqual([]);
    });
});
