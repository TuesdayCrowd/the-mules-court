/**
 * The whole stack, end to end, through the actual MCP server process.
 *
 * `main.ts` is spawned as a real subprocess and driven over stdin/stdout with
 * real JSON-RPC. Nothing here reaches into the session directly: every move is
 * a `tools/call`, exactly as Claude Code would make it. If this passes, the
 * thing works — handshake, tool listing, capability handles, and a match played
 * to a winner across three sockets.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { PlayerId, RedactedView } from '../game/engine';
import { makeConfig } from '../server/config';
import { startServer, type RunningServer } from '../server/index';
import type { ServerMessage } from '../server/protocol';
import { chooseMove, TestClient } from '../server/__tests__/testClient';
import { chooseFallbackPlay } from './fallbackPlay';

type LobbyUpdate = Extract<ServerMessage, { type: 'LOBBY_UPDATE' }>;

interface RoomCreated {
    matchId: string;
    hostSeat: PlayerId;
    hostSeatToken: string;
}

interface ToolResult {
    content: { type: string; text: string }[];
    isError?: boolean;
}

/** A minimal JSON-RPC client over a spawned process's stdio. */
class StdioClient {
    private readonly proc: Bun.Subprocess<'pipe', 'pipe', 'inherit'>;
    private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    private nextId = 1;
    private buffer = '';

    constructor(serverUrl: string) {
        this.proc = Bun.spawn(['bun', 'src/mcp/main.ts'], {
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'inherit',
            env: { ...process.env, MULES_MCP_SERVER_URL: serverUrl }
        });
        void this.pump();
    }

    private async pump(): Promise<void> {
        const decoder = new TextDecoder();
        for await (const chunk of this.proc.stdout as unknown as AsyncIterable<Uint8Array>) {
            this.buffer += decoder.decode(chunk, { stream: true });
            for (;;) {
                const newline = this.buffer.indexOf('\n');
                if (newline === -1) break;
                const line = this.buffer.slice(0, newline);
                this.buffer = this.buffer.slice(newline + 1);
                if (line.trim().length === 0) continue;

                const frame = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
                const waiter = typeof frame.id === 'number' ? this.pending.get(frame.id) : undefined;
                if (waiter === undefined) continue;
                this.pending.delete(frame.id!);
                if (frame.error !== undefined) waiter.reject(new Error(frame.error.message));
                else waiter.resolve(frame.result);
            }
        }
    }

    request(method: string, params?: unknown, timeoutMs = 15_000): Promise<unknown> {
        const id = this.nextId++;
        const frame = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} (id ${id}) got no response within ${timeoutMs}ms`));
            }, timeoutMs);

            this.pending.set(id, {
                resolve: value => {
                    clearTimeout(timer);
                    resolve(value);
                },
                reject: err => {
                    clearTimeout(timer);
                    reject(err);
                }
            });

            this.proc.stdin.write(`${frame}\n`);
            this.proc.stdin.flush();
        });
    }

    notify(method: string, params?: unknown): void {
        this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`);
        this.proc.stdin.flush();
    }

    async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
        return (await this.request('tools/call', { name, arguments: args })) as ToolResult;
    }

    /** Tool results are JSON in a text block; this is the un-wrapping every caller needs. */
    async callJson<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
        const result = await this.callTool(name, args);
        if (result.isError === true) throw new Error(`${name}: ${result.content.map(c => c.text).join('')}`);
        return JSON.parse(result.content.map(c => c.text).join('')) as T;
    }

    kill(): void {
        this.proc.kill();
    }
}

describe('the MCP server over real stdio', () => {
    let running: RunningServer;
    let httpBase: string;
    let wsBase: string;
    let mcp: StdioClient;

    beforeAll(() => {
        running = startServer(
            makeConfig({ port: 0, dbPath: ':memory:', revealWindowMs: 20, messageBurst: 10_000, messageRefillPerSec: 10_000 })
        );
        httpBase = `http://localhost:${running.server.port}`;
        wsBase = `ws://localhost:${running.server.port}`;
        mcp = new StdioClient(wsBase);
    });

    afterAll(() => {
        mcp.kill();
        running.stop();
    });

    it('completes the initialize handshake and advertises the seven tools', async () => {
        const init = (await mcp.request('initialize', {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'stdio.test', version: '1.0.0' }
        })) as { protocolVersion: string; capabilities: { tools?: unknown }; serverInfo: { name: string } };

        expect(init.protocolVersion).toBe('2025-06-18');
        expect(init.capabilities.tools).toBeDefined();
        expect(init.serverInfo.name).toBe('mules-court-seats');

        mcp.notify('notifications/initialized');
        expect(await mcp.request('ping')).toEqual({});

        const listed = (await mcp.request('tools/list')) as { tools: { name: string }[] };
        expect(listed.tools.map(t => t.name).sort()).toEqual([
            'await_turn',
            'get_view',
            'join_match',
            'play_card',
            'read_notebook',
            'table_status',
            'write_notebook'
        ]);
    });

    it('answers an unknown method with method-not-found and keeps serving', async () => {
        await expect(mcp.request('no/such/method')).rejects.toThrow(/Method not found/);
        expect(await mcp.request('ping')).toEqual({});
    });

    it('refuses a seat-scoped tool with no handle', async () => {
        const refused = await mcp.callTool('get_view', {});
        expect(refused.isError).toBe(true);
        expect(refused.content.map(c => c.text).join('')).toContain('handle');
    });

    it('plays a whole match to a winner, entirely through tool calls', async () => {
        const created = (await (await fetch(`${httpBase}/api/rooms`, { method: 'POST' })).json()) as RoomCreated;

        const host = await TestClient.connect(wsBase);
        host.send({ type: 'RESUME_SEAT', matchId: created.matchId, seatToken: created.hostSeatToken });

        const seats = await mcp.callJson<{ seat: number; handle: string; nickname: string; playerId: PlayerId }[]>('join_match', {
            matchId: created.matchId,
            nicknames: ['Bayta', 'Toran', 'Magnifico']
        });
        expect(seats).toHaveLength(3);
        const handleOf = new Map(seats.map(s => [s.playerId, s.handle]));

        let lobby: LobbyUpdate | null = null;
        for (let i = 0; i < 12 && !lobby?.canStart; i++) lobby = await host.nextOfType('LOBBY_UPDATE');
        expect(lobby?.canStart).toBe(true);

        try {
            host.send({ type: 'START_MATCH', matchId: created.matchId });
            await host.nextOfType('STATE_UPDATE', 4000);

            let seatMoves = 0;
            let humanMoves = 0;
            let notebookWrites = 0;
            let winner: PlayerId | null = null;

            for (let guard = 0; guard < 800; guard++) {
                const signal = await mcp.callJson<{ status: string; seat?: PlayerId }>('await_turn', { timeoutMs: 120 });

                if (signal.status === 'match_over') {
                    const ended = await host.nextOfType('MATCH_ENDED', 4000);
                    expect(ended.reason).toBe('won');
                    winner = ended.winnerSeat ?? null;
                    break;
                }

                if (signal.status === 'your_turn') {
                    const handle = handleOf.get(signal.seat!)!;

                    // Exercise the notebook on the same path a seat agent would:
                    // read before deciding, write after acting.
                    const before = await mcp.callJson<{ text: string }>('read_notebook', { handle });
                    const seen = await mcp.callJson<{ view: RedactedView }>('get_view', { handle });
                    expect(seen.view.own.playerId).toBe(signal.seat!);

                    const move = chooseFallbackPlay(seen.view);
                    if (move === null) {
                        // A failing assertion here would only say "null". The
                        // interesting question is which of signal and view
                        // disagreed, and about what.
                        throw new Error(
                            `no legal play for ${signal.seat}: view.currentPlayerId=${seen.view.currentPlayerId} ` +
                                `turn=${seen.view.turnNumber} alive=${seen.view.players.find(p => p.id === signal.seat)?.alive} ` +
                                `hand=${JSON.stringify(seen.view.own.hand)} legalPlays=${JSON.stringify(seen.view.own.legalPlays)} ` +
                                `roundResult=${JSON.stringify(seen.view.roundResult)}`
                        );
                    }

                    await mcp.callJson('play_card', { handle, ...move });
                    seatMoves++;

                    await mcp.callJson('write_notebook', {
                        handle,
                        text: `${before.text}\nturn ${seen.view.turnNumber}: played ${move.cardInstanceId}`.trim()
                    });
                    notebookWrites++;
                    continue;
                }

                const status = await mcp.callJson<{ phase: string; paused: boolean; currentPlayerId: PlayerId | null }>('table_status');
                if (status.phase === 'active' && !status.paused && status.currentPlayerId === created.hostSeat) {
                    const humanView = host.lastState?.view;
                    if (humanView !== undefined && humanView.own.legalPlays.length > 0) {
                        host.send({ type: 'PLAY_CARD', matchId: created.matchId, ...chooseMove(humanView) });
                        await host.nextOfType('STATE_UPDATE', 4000);
                        humanMoves++;
                    }
                }
            }

            expect(winner).not.toBeNull();
            expect(seatMoves).toBeGreaterThan(5);
            expect(humanMoves).toBeGreaterThan(0);
            expect(notebookWrites).toBe(seatMoves);

            // The notebooks accumulated per seat, and stayed separate.
            for (const seat of seats) {
                const notes = await mcp.callJson<{ text: string }>('read_notebook', { handle: seat.handle });
                expect(notes.text.length).toBeGreaterThan(0);
            }
        } finally {
            host.close();
        }
    }, 90_000);
});
