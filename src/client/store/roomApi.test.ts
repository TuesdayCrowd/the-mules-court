import { describe, expect, it } from 'vitest';
import type { HttpResponse, RoomApiDeps } from './roomApi';
import { createRoomApi } from './roomApi';

const ROOM = {
    matchId: 'K7QX2',
    joinUrl: 'http://localhost:3000/join/K7QX2',
    hostSeat: 'p1',
    hostSeatToken: 'tok-host'
};

function reply(status: number, body: unknown = ROOM): HttpResponse {
    return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

/** Yields to the real event loop so the code under test can advance its awaits. */
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** Timers that record their delays and fire on demand. */
function fakeTimers() {
    const delays: number[] = [];
    let pending: Array<() => void> = [];

    function run(): void {
        const due = pending;
        pending = [];
        for (const fn of due) fn();
    }

    return {
        delays,
        run,
        timers: {
            setTimeout(fn: () => void, ms: number) {
                delays.push(ms);
                pending.push(fn);
                return pending.length;
            },
            clearTimeout() {}
        },
        /**
         * Let the retry loop run to completion.
         *
         * Yield first, fire second: at the moment `createRoom()` is called
         * nothing is scheduled yet, so a drain that checked for pending timers
         * up front would find none and return before the first retry existed.
         */
        async drain() {
            for (let i = 0; i < 20; i++) {
                await tick();
                if (pending.length > 0) run();
            }
        }
    };
}

function harness(replies: HttpResponse[] | (() => Promise<HttpResponse>), overrides: Partial<RoomApiDeps> = {}) {
    const calls: Array<{ url: string; method: string }> = [];
    const queue = Array.isArray(replies) ? [...replies] : null;
    const clock = fakeTimers();

    const api = createRoomApi({
        fetch: (url, init) => {
            calls.push({ url, method: init?.method ?? 'GET' });
            if (queue === null) return (replies as () => Promise<HttpResponse>)();
            const next = queue.shift();
            if (next === undefined) throw new Error('fetch called more times than the test allowed');
            return Promise.resolve(next);
        },
        timers: clock.timers,
        random: () => 0.5,
        ...overrides
    });

    return { api, calls, clock };
}

describe('createRoom on the happy path', () => {
    it('POSTs to /api/rooms and returns the room', async () => {
        const h = harness([reply(201)]);

        const result = await h.api.createRoom();

        expect(h.calls).toEqual([{ url: '/api/rooms', method: 'POST' }]);
        expect(result).toEqual({ ok: true, room: ROOM });
    });

    it('asks for a relative path, so dev and production share one origin', async () => {
        const h = harness([reply(201)]);
        await h.api.createRoom();
        expect(h.calls[0].url.startsWith('/')).toBe(true);
    });
});

describe('createRoom under rate limiting', () => {
    it('retries a 429 and succeeds on a later attempt', async () => {
        const h = harness([reply(429, null), reply(429, null), reply(201)]);

        const pending = h.api.createRoom();
        await h.clock.drain();

        expect(await pending).toEqual({ ok: true, room: ROOM });
        expect(h.calls).toHaveLength(3);
    });

    it('backs off between attempts rather than hammering', async () => {
        const h = harness([reply(429, null), reply(429, null), reply(201)]);

        const pending = h.api.createRoom();
        await h.clock.drain();
        await pending;

        expect(h.clock.delays).toEqual([400, 800]); // random() === 0.5 removes the jitter
    });

    it('caps its retries and reports rate-limited rather than throwing', async () => {
        const h = harness([reply(429, null), reply(429, null), reply(429, null)]);

        const pending = h.api.createRoom();
        await h.clock.drain();

        expect(await pending).toEqual({ ok: false, reason: 'rate-limited' });
        expect(h.calls).toHaveLength(3);
    });

    it('jitters the wait so a rate-limited crowd does not return in lockstep', async () => {
        const h = harness([reply(429, null), reply(201)], { random: () => 0 });
        const pending = h.api.createRoom();
        await h.clock.drain();
        await pending;

        expect(h.clock.delays).toEqual([300]); // 400 * 0.75
    });
});

describe('createRoom when the server is unhappy', () => {
    it('fails a 500 immediately without retrying', async () => {
        // UIX §5 names 429 alone as the retryable case; retrying a server error
        // is not a promise the design makes, and hammering a broken server is
        // how a broken server stays broken.
        const h = harness([reply(500, null)]);

        expect(await h.api.createRoom()).toEqual({ ok: false, reason: 'server-error' });
        expect(h.calls).toHaveLength(1);
        expect(h.clock.delays).toEqual([]);
    });

    it('fails a 404 immediately too', async () => {
        const h = harness([reply(404, null)]);
        expect(await h.api.createRoom()).toEqual({ ok: false, reason: 'server-error' });
    });

    it('reports an unreachable server rather than throwing', async () => {
        const h = harness(() => Promise.reject(new TypeError('Failed to fetch')));
        expect(await h.api.createRoom()).toEqual({ ok: false, reason: 'unreachable' });
    });

    it('reports a body it cannot read rather than throwing', async () => {
        const h = harness([{ ok: true, status: 201, json: () => Promise.reject(new SyntaxError('bad json')) }]);
        expect(await h.api.createRoom()).toEqual({ ok: false, reason: 'malformed' });
    });
});

describe('createRoom guards the response shape', () => {
    // The host seat token arrives here and nowhere else. A response missing it
    // must fail loudly at the boundary rather than persist `undefined` and lose
    // the seat on the first reconnect.
    it.each([
        ['a missing token', { ...ROOM, hostSeatToken: undefined }],
        ['a non-string token', { ...ROOM, hostSeatToken: 42 }],
        ['a missing matchId', { ...ROOM, matchId: undefined }],
        ['a missing joinUrl', { ...ROOM, joinUrl: undefined }],
        ['a missing hostSeat', { ...ROOM, hostSeat: undefined }],
        ['an array', []],
        ['null', null],
        ['a string', 'K7QX2']
    ])('rejects %s', async (_name, body) => {
        const h = harness([reply(201, body)]);
        expect(await h.api.createRoom()).toEqual({ ok: false, reason: 'malformed' });
    });

    it('accepts the exact shape the server sends', async () => {
        const h = harness([reply(201, ROOM)]);
        expect(await h.api.createRoom()).toEqual({ ok: true, room: ROOM });
    });

    it('ignores extra fields a later server version might add', async () => {
        const h = harness([reply(201, { ...ROOM, somethingNew: true })]);
        expect(await h.api.createRoom()).toEqual({ ok: true, room: ROOM });
    });
});
