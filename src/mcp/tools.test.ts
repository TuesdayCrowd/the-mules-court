import { describe, expect, it } from 'bun:test';
import type { PlayerId } from '../game/engine';
import { callTool, TOOL_DEFS, type ToolSurface } from './tools';

/** Records what the session was asked to do, and answers plausibly. */
function stubSurface(overrides: Partial<ToolSurface> = {}) {
    const calls: { name: string; args: unknown[] }[] = [];
    const record = (name: string, ...args: unknown[]) => calls.push({ name, args });

    const base: ToolSurface = {
        joinMatch: async input => {
            record('joinMatch', input);
            return input.nicknames.map((nickname, i) => ({
                seat: i + 1,
                handle: `h${i + 2}`,
                nickname,
                playerId: `p${i + 2}` as PlayerId
            }));
        },
        awaitTurn: async timeoutMs => {
            record('awaitTurn', timeoutMs);
            return { status: 'your_turn', seat: 'p3', turnNumber: 4, phase: 'active' };
        },
        tableStatus: () => {
            record('tableStatus');
            return {
                matchId: 'm1',
                seats: [{ playerId: 'p2', seat: 1, nickname: 'Bayta' }],
                nicknames: { p2: 'Bayta' },
                phase: 'active',
                paused: false,
                turnNumber: 4,
                currentPlayerId: 'p3',
                recentLog: []
            };
        },
        getView: handle => {
            record('getView', handle);
            return { ok: false, error: 'NOT_STARTED' };
        },
        playCard: async (handle, move, timeoutMs) => {
            record('playCard', handle, move, timeoutMs);
            return { ok: true };
        },
        readNotebook: handle => {
            record('readNotebook', handle);
            return { ok: true, text: 'notes' };
        },
        writeNotebook: (handle, text) => {
            record('writeNotebook', handle, text);
            return { ok: true };
        },
        ...overrides
    };

    return { surface: base, calls };
}

function textOf(result: { readonly content: readonly { readonly text: string }[] }): string {
    return result.content.map(block => block.text).join('');
}

describe('TOOL_DEFS', () => {
    it('declares exactly the seven tools the design names', () => {
        expect(TOOL_DEFS.map(def => def.name).sort()).toEqual([
            'await_turn',
            'get_view',
            'join_match',
            'play_card',
            'read_notebook',
            'table_status',
            'write_notebook'
        ]);
    });

    it('gives every tool an object schema with no stray required keys', () => {
        for (const def of TOOL_DEFS) {
            expect(def.inputSchema.type).toBe('object');
            for (const key of def.inputSchema.required ?? []) {
                expect(Object.keys(def.inputSchema.properties)).toContain(key);
            }
        }
    });

    it('tells the caller when to reach for each tool, not just what it does', () => {
        // A description that states the trigger measurably improves call rate.
        // These are the four that are easy to misuse, so each names its moment.
        const byName = new Map(TOOL_DEFS.map(def => [def.name, def.description]));
        expect(byName.get('await_turn')).toMatch(/call|again|after/i);
        expect(byName.get('get_view')).toMatch(/before/i);
        expect(byName.get('write_notebook')).toMatch(/before|after|end/i);
        expect(byName.get('play_card')).toMatch(/legal/i);
    });

    it('warns on the seat-scoped tools that a handle is required', () => {
        for (const name of ['get_view', 'play_card', 'read_notebook', 'write_notebook']) {
            const def = TOOL_DEFS.find(d => d.name === name)!;
            expect(def.inputSchema.required).toContain('handle');
        }
    });
});

describe('callTool routing', () => {
    it('routes join_match, passing the nicknames through', async () => {
        const { surface, calls } = stubSurface();
        const result = await callTool(surface, 'join_match', { matchId: 'm1', nicknames: ['A', 'B'] });
        expect(result.isError).toBeUndefined();
        expect(calls[0]!.name).toBe('joinMatch');
        expect(textOf(result)).toContain('h2');
    });

    it('routes await_turn and reports the routed seat', async () => {
        const { surface } = stubSurface();
        const result = await callTool(surface, 'await_turn', {});
        expect(textOf(result)).toContain('p3');
    });

    it('routes the notebooks by handle', async () => {
        const { surface, calls } = stubSurface();
        await callTool(surface, 'write_notebook', { handle: 'h2', text: 'hello' });
        expect(calls[0]!.args).toEqual(['h2', 'hello']);
    });

    it('routes play_card with its optional target and guess', async () => {
        const { surface, calls } = stubSurface();
        await callTool(surface, 'play_card', { handle: 'h4', cardInstanceId: 'informant#0', target: 'p1', guess: 5 });
        expect(calls[0]!.args[1]).toEqual({ cardInstanceId: 'informant#0', target: 'p1', guess: 5 });
    });
});

describe('callTool refusals', () => {
    it('reports an unknown tool as a tool error, not a crash', async () => {
        const { surface } = stubSurface();
        const result = await callTool(surface, 'no_such_tool', {});
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('no_such_tool');
    });

    it('refuses a seat-scoped call with no handle before touching the session', async () => {
        const { surface, calls } = stubSurface();
        const result = await callTool(surface, 'get_view', {});
        expect(result.isError).toBe(true);
        expect(calls).toEqual([]);
    });

    it('refuses a handle that is not a string', async () => {
        const { surface } = stubSurface();
        expect((await callTool(surface, 'read_notebook', { handle: 42 })).isError).toBe(true);
    });

    it('surfaces a session refusal as an error result the agent can read', async () => {
        const { surface } = stubSurface();
        const result = await callTool(surface, 'get_view', { handle: 'h2' });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('NOT_STARTED');
    });

    it('refuses play_card without a card instance id', async () => {
        const { surface } = stubSurface();
        expect((await callTool(surface, 'play_card', { handle: 'h2' })).isError).toBe(true);
    });

    it('refuses join_match without nicknames', async () => {
        const { surface } = stubSurface();
        expect((await callTool(surface, 'join_match', { matchId: 'm1' })).isError).toBe(true);
    });
});
