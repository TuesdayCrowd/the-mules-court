import { describe, expect, it } from 'bun:test';
import { CARD_CATALOG, createMatch, view } from '../game/engine';
import type { PlayerId, RedactedView } from '../game/engine';
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

describe('callTool trims what it ships', () => {
    /** A view carrying one finished round whose log is long. */
    const viewWithHistory = {
        turnNumber: 3,
        deckCount: 9,
        publicLog: [{ kind: 'PLAY', turn: 1, actorId: 'p1', cardId: 'informant' }],
        roundHistory: [
            {
                roundNumber: 1,
                reason: 'deck-out',
                winnerIds: ['p2'],
                publicLog: [
                    { kind: 'PLAY', turn: 1, actorId: 'p1', cardId: 'mayor-indbur' },
                    { kind: 'PLAY', turn: 2, actorId: 'p2', cardId: 'first-speaker' }
                ]
            }
        ],
        own: { playerId: 'p2', hand: ['informant#0'], legalPlays: [], legalTargets: {} }
    } as unknown as RedactedView;

    function surfaceWithHistory(): ToolSurface {
        return stubSurface({
            getView: () => ({ ok: true, view: viewWithHistory, nicknames: {} })
        }).surface;
    }

    it('keeps each past round\'s outcome', async () => {
        const text = textOf(await callTool(surfaceWithHistory(), 'get_view', { handle: 'h2' }));
        expect(text).toContain('roundNumber');
        expect(text).toContain('deck-out');
        expect(text).toContain('p2');
    });

    it('drops past rounds\' public logs, which cannot inform the current round', async () => {
        // Every card returns to the deck between rounds, so a finished round's
        // log has no deduction value — and it grows without bound, making
        // get_view more expensive every round of the match it exists to play.
        const text = textOf(await callTool(surfaceWithHistory(), 'get_view', { handle: 'h2' }));
        expect(text).not.toContain('mayor-indbur');
        expect(text).not.toContain('first-speaker');
    });

    it('keeps the CURRENT round\'s log, which is the whole basis for deduction', async () => {
        const text = textOf(await callTool(surfaceWithHistory(), 'get_view', { handle: 'h2' }));
        expect(text).toContain('informant');
    });

    it('leaves the rest of the view alone', async () => {
        const text = textOf(await callTool(surfaceWithHistory(), 'get_view', { handle: 'h2' }));
        expect(text).toContain('deckCount');
        expect(text).toContain('informant#0');
    });
});

describe('callTool names cards for a client with no portrait', () => {
    // Mule + Informant + Shielded Mind cover: the one self-eliminating card,
    // a card that requires a target, and a card that does not.
    const viewWithCards = {
        turnNumber: 3,
        deckCount: 9,
        publicLog: [],
        roundHistory: [],
        own: {
            playerId: 'p2',
            hand: ['mule#0', 'informant#0'],
            legalPlays: ['mule#0', 'shielded-mind#0', 'informant#0'],
            legalTargets: { 'mule#0': [], 'shielded-mind#0': [], 'informant#0': ['p1'] }
        }
    } as unknown as RedactedView;

    function surfaceWithCards(): ToolSurface {
        return stubSurface({ getView: () => ({ ok: true, view: viewWithCards, nicknames: {} }) }).surface;
    }

    interface DescribedOwn {
        readonly hand: { cardInstanceId: string; cardId: string; value: number; displayName: string }[];
        readonly legalPlays: {
            cardInstanceId: string;
            cardId: string;
            value: number;
            displayName: string;
            requiresTarget: boolean;
            warning?: string;
        }[];
    }

    async function ownOf(surface: ToolSurface): Promise<DescribedOwn> {
        const payload = JSON.parse(textOf(await callTool(surface, 'get_view', { handle: 'h2' }))) as { view: { own: DescribedOwn } };
        return payload.view.own;
    }

    it('gives each hand card its value and display name, matching CARD_CATALOG', async () => {
        const own = await ownOf(surfaceWithCards());
        expect(own.hand).toEqual([
            { cardInstanceId: 'mule#0', cardId: 'mule', value: CARD_CATALOG.mule.value, displayName: CARD_CATALOG.mule.displayName },
            {
                cardInstanceId: 'informant#0',
                cardId: 'informant',
                value: CARD_CATALOG.informant.value,
                displayName: CARD_CATALOG.informant.displayName
            }
        ]);
    });

    it('carries the self-elimination warning on the Mule\'s legalPlays entry, and no other', async () => {
        const own = await ownOf(surfaceWithCards());
        const mule = own.legalPlays.find(p => p.cardInstanceId === 'mule#0')!;
        const shieldedMind = own.legalPlays.find(p => p.cardInstanceId === 'shielded-mind#0')!;
        expect(mule.warning).toBe('Discard The Mule — you are eliminated.');
        expect(shieldedMind.warning).toBeUndefined();
    });

    it('marks requiresTarget true for the Informant (GUARD) and false for Shielded Mind (HANDMAID)', async () => {
        const own = await ownOf(surfaceWithCards());
        const informant = own.legalPlays.find(p => p.cardInstanceId === 'informant#0')!;
        const shieldedMind = own.legalPlays.find(p => p.cardInstanceId === 'shielded-mind#0')!;
        expect(informant.requiresTarget).toBe(true);
        expect(shieldedMind.requiresTarget).toBe(false);
    });
});

describe('callTool labels a claimed seat the way the browser lobby does', () => {
    it('returns seatLabel one greater than the wire\'s 0-based seat index', async () => {
        const { surface } = stubSurface();
        const result = await callTool(surface, 'join_match', { matchId: 'm1', nicknames: ['A', 'B'] });
        const seats = JSON.parse(textOf(result)) as { seat: number; handle: string; nickname: string; playerId: string; seatLabel: string }[];
        expect(seats).toEqual([
            { seat: 1, handle: 'h2', nickname: 'A', playerId: 'p2', seatLabel: 'Seat 2' },
            { seat: 2, handle: 'h3', nickname: 'B', playerId: 'p3', seatLabel: 'Seat 3' }
        ]);
    });
});

describe('TOOL_DEFS say what the enriched fields mean', () => {
    it('tells the agent that a legal play can still be self-destructive', () => {
        const description = TOOL_DEFS.find(d => d.name === 'play_card')!.description;
        expect(description).toMatch(/eliminat/i);
        expect(description).toMatch(/warning/i);
    });

    it('tells the agent what an empty legalTargets array means, via requiresTarget', () => {
        const description = TOOL_DEFS.find(d => d.name === 'get_view')!.description;
        expect(description).toMatch(/value/i);
        expect(description).toMatch(/requiresTarget/);
        expect(description).toMatch(/fizzle|no legal target/i);
    });

    it('tells the agent which of seat and seatLabel matches the browser lobby', () => {
        const description = TOOL_DEFS.find(d => d.name === 'join_match')!.description;
        expect(description).toMatch(/seatLabel/);
    });
});

describe('the engine boundary this enrichment must not move', () => {
    it('still hands own.hand and own.legalPlays as bare instance ids straight from view.ts', () => {
        // Enrichment lives in tools.ts's compactView only. This calls the
        // engine's own `view()` directly — nowhere near tools.ts — so a
        // regression that moved the enrichment into view.ts, or that widened
        // RedactedView itself, fails here even though nothing above touches
        // this code path.
        const match = createMatch(['p0', 'p1', 'p2'], 'enrichment-boundary-seed');
        const starter = match.round.seatOrder[0]!;
        const projection = view(match, starter);

        expect(projection.own.hand.length).toBeGreaterThan(0);
        for (const entry of projection.own.hand) {
            expect(typeof entry).toBe('string');
        }
        for (const entry of projection.own.legalPlays) {
            expect(typeof entry).toBe('string');
        }
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
