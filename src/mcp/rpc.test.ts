import { describe, expect, it } from 'bun:test';
import { handleLine, type MethodHandlers } from './rpc';

const METHODS: MethodHandlers = {
    ping: () => ({}),
    echo: params => params,
    boom: () => {
        throw new Error('handler exploded');
    }
};

async function call(line: string): Promise<Record<string, unknown> | null> {
    const out = await handleLine(line, METHODS);
    return out === null ? null : (JSON.parse(out) as Record<string, unknown>);
}

describe('handleLine responses', () => {
    it('answers a request with the same id', async () => {
        const res = await call('{"jsonrpc":"2.0","id":7,"method":"ping"}');
        expect(res).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
    });

    it('accepts a string id, which the spec allows', async () => {
        const res = await call('{"jsonrpc":"2.0","id":"abc","method":"ping"}');
        expect(res?.id).toBe('abc');
    });

    it('passes params through to the handler', async () => {
        const res = await call('{"jsonrpc":"2.0","id":1,"method":"echo","params":{"a":1}}');
        expect(res?.result).toEqual({ a: 1 });
    });
});

describe('handleLine says nothing when it must not', () => {
    it('returns null for a notification, which has no id', async () => {
        expect(await call('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toBeNull();
    });

    it('returns null for an unknown notification rather than erroring', async () => {
        // A notification never gets a response, not even an error one — that is
        // the rule most hand-rolled servers get wrong, and it makes a client
        // hang waiting for a reply to something it never asked to be answered.
        expect(await call('{"jsonrpc":"2.0","method":"notifications/cancelled"}')).toBeNull();
    });

    it('returns null for a blank line', async () => {
        expect(await call('   ')).toBeNull();
    });
});

describe('handleLine errors', () => {
    it('reports a parse error with a null id, having no id to echo', async () => {
        const res = await call('{not json');
        expect(res?.id).toBeNull();
        expect((res?.error as { code: number }).code).toBe(-32700);
    });

    it('reports an invalid request for a non-object payload', async () => {
        const res = await call('[1,2,3]');
        expect((res?.error as { code: number }).code).toBe(-32600);
    });

    it('reports method not found, and names the method', async () => {
        const res = await call('{"jsonrpc":"2.0","id":2,"method":"nope"}');
        const error = res?.error as { code: number; message: string };
        expect(error.code).toBe(-32601);
        expect(error.message).toContain('nope');
    });

    it('turns a thrown handler into an internal error rather than a crash', async () => {
        const res = await call('{"jsonrpc":"2.0","id":3,"method":"boom"}');
        const error = res?.error as { code: number; message: string };
        expect(error.code).toBe(-32603);
        expect(error.message).toContain('handler exploded');
    });

    it('never lets a handler failure take the transport down', async () => {
        await call('{"jsonrpc":"2.0","id":3,"method":"boom"}');
        // Still serving afterwards.
        expect((await call('{"jsonrpc":"2.0","id":4,"method":"ping"}'))?.result).toEqual({});
    });
});
