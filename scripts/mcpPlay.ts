#!/usr/bin/env bun
/**
 * Play a live match through the real MCP server, with a human (or a model) in
 * the loop for the three MCP-held seats.
 *
 * This is not a test — it is the thing the tests are about. It boots a real
 * game server, spawns `src/mcp/main.ts` as a subprocess, and drives a whole
 * four-player match using nothing but `tools/call`, exactly as Claude Code
 * would. Seat p1 is played by a simple built-in policy (the "human"); seats
 * p2/p3/p4 are played by whoever is answering the prompts.
 *
 * The handshake with the decider is deliberately file-based, so an agent that
 * can only run shell commands can still play: when a held seat is up, the
 * script writes `turn.json` and waits for `move.json` to appear, then consumes
 * it. Nothing is shared between seats — `turn.json` only ever contains the
 * view of the seat whose turn it is, which is the same boundary the design
 * enforces in code.
 *
 *   bun scripts/mcpPlay.ts --dir <scratch> [--hand N] [--port 3000]
 *
 * `--hand N` hand-plays the first N held-seat decisions and then finishes the
 * match on the built-in policy, so a session with a limited number of turns can
 * still see a match end.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { CARD_CATALOG, cardTypeOf } from '../src/game/engine';
import type { CardInstanceId, PlayerId, RedactedView } from '../src/game/engine';
import { makeConfig } from '../src/server/config';
import { serveStatic, startServer } from '../src/server/index';
import type { ClientMessage, ServerMessage } from '../src/server/protocol';
import { chooseFallbackPlay } from '../src/mcp/fallbackPlay';

// ------------------------------------------------------------------ arguments

function flag(name: string, fallback: string): string {
    const at = process.argv.indexOf(`--${name}`);
    return at !== -1 && process.argv[at + 1] !== undefined ? process.argv[at + 1]! : fallback;
}

const DIR = flag('dir', '/tmp/mules-mcp-play');
const HAND_PLAYS = Number(flag('hand', '0'));
const PORT = Number(flag('port', '3000'));

/**
 * The reveal window between rounds, in ms.
 *
 * Production is ten seconds, and a match runs eight or nine rounds — so an
 * unattended match spends about a minute and a half asleep and a few seconds
 * playing. That is right when a human needs to read the table and wrong for a
 * driver, so this defaults low. Pass `--reveal 10000` to watch one at real
 * speed in the browser.
 */
const REVEAL_MS = Number(flag('reveal', '25'));

if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
const path = (name: string) => join(DIR, name);
for (const stale of ['turn.json', 'move.json', 'result.json', 'transcript.log']) {
    if (existsSync(path(stale))) rmSync(path(stale));
}

const log = (line: string): void => {
    appendFileSync(path('transcript.log'), `${line}\n`);
    console.log(line);
};

const nameOf = (card: CardInstanceId): string => {
    const def = CARD_CATALOG[cardTypeOf(card)];
    return `${def.value} ${def.displayName}`;
};

// ------------------------------------------------------- minimal host client

/** Seat p1's socket. Needs RESUME_SEAT and START_MATCH, which SeatClient has no business knowing. */
class HostClient {
    private readonly ws: WebSocket;
    lastState: Extract<ServerMessage, { type: 'STATE_UPDATE' }> | null = null;
    ended: Extract<ServerMessage, { type: 'MATCH_ENDED' }> | null = null;
    canStart = false;

    private constructor(ws: WebSocket) {
        this.ws = ws;
        ws.onmessage = event => {
            const msg = JSON.parse(String(event.data)) as ServerMessage;
            if (msg.type === 'STATE_UPDATE') this.lastState = msg;
            else if (msg.type === 'LOBBY_UPDATE') this.canStart = msg.canStart;
            else if (msg.type === 'MATCH_ENDED') this.ended = msg;
        };
    }

    static async connect(url: string): Promise<HostClient> {
        const ws = new WebSocket(url);
        await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => reject(new Error(`host socket to ${url} failed`));
        });
        return new HostClient(ws);
    }

    send(msg: ClientMessage): void {
        this.ws.send(JSON.stringify(msg));
    }
}

// ------------------------------------------------------------- MCP stdio client

class Mcp {
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
                const nl = this.buffer.indexOf('\n');
                if (nl === -1) break;
                const line = this.buffer.slice(0, nl).trim();
                this.buffer = this.buffer.slice(nl + 1);
                if (line.length === 0) continue;
                const frame = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
                const waiter = typeof frame.id === 'number' ? this.pending.get(frame.id) : undefined;
                if (waiter === undefined) continue;
                this.pending.delete(frame.id!);
                if (frame.error) waiter.reject(new Error(frame.error.message));
                else waiter.resolve(frame.result);
            }
        }
    }

    request(method: string, params?: unknown, timeoutMs = 130_000): Promise<unknown> {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} timed out`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: v => (clearTimeout(timer), resolve(v)),
                reject: e => (clearTimeout(timer), reject(e))
            });
            this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
            this.proc.stdin.flush();
        });
    }

    async tool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
        const result = (await this.request('tools/call', { name, arguments: args })) as {
            content: { text: string }[];
            isError?: boolean;
        };
        const text = result.content.map(c => c.text).join('');
        if (result.isError === true) throw new Error(`${name}: ${text}`);
        return JSON.parse(text) as T;
    }

    kill(): void {
        this.proc.kill();
    }
}

// --------------------------------------------------------------------- setup

const running = startServer(
    makeConfig({
        port: PORT,
        dbPath: join(DIR, 'match.sqlite'),
        publicBaseUrl: `http://localhost:${PORT}`,
        revealWindowMs: REVEAL_MS,
        staticRoot: 'dist'
    }),
    pathname => serveStatic('dist', pathname)
);

const httpBase = `http://localhost:${running.server.port}`;
const wsBase = `ws://localhost:${running.server.port}`;

const created = (await (await fetch(`${httpBase}/api/rooms`, { method: 'POST' })).json()) as {
    matchId: string;
    joinUrl: string;
    hostSeat: PlayerId;
    hostSeatToken: string;
};

log(`server  ${httpBase}`);
log(`watch   ${created.joinUrl}`);
log(`match   ${created.matchId}`);

const host = await HostClient.connect(wsBase);
host.send({ type: 'RESUME_SEAT', matchId: created.matchId, seatToken: created.hostSeatToken, nickname: 'Human' });

const mcp = new Mcp(wsBase);
await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcpPlay', version: '1' } });

const seats = await mcp.tool<{ seat: number; handle: string; nickname: string; playerId: PlayerId }[]>('join_match', {
    matchId: created.matchId,
    nicknames: ['Bayta', 'Toran', 'Magnifico']
});
const handleOf = new Map(seats.map(s => [s.playerId, s.handle]));
const nickOf = new Map<PlayerId, string>([[created.hostSeat, 'Human'], ...seats.map(s => [s.playerId, s.nickname] as const)]);
log(`seats   ${seats.map(s => `${s.playerId}=${s.nickname}`).join('  ')}`);

for (let i = 0; i < 200 && !host.canStart; i++) await Bun.sleep(25);
host.send({ type: 'START_MATCH', matchId: created.matchId });
for (let i = 0; i < 200 && host.lastState === null; i++) await Bun.sleep(25);
log('--- match started ---\n');

// ---------------------------------------------------------------- turn helpers

/** Writes the deciding seat's view out, then blocks until a move file appears. */
async function askDecider(seat: PlayerId, view: RedactedView, notes: string): Promise<Record<string, unknown>> {
    const plays = view.own.legalPlays.map(card => ({
        cardInstanceId: card,
        card: nameOf(card),
        legalTargets: (view.own.legalTargets[card] ?? []).map(id => `${id} (${nickOf.get(id) ?? id})`)
    }));

    writeFileSync(
        path('turn.json'),
        JSON.stringify(
            {
                youAre: `${seat} (${nickOf.get(seat)})`,
                turnNumber: view.turnNumber,
                yourHand: view.own.hand.map(nameOf),
                yourLegalPlays: plays,
                yourNotebook: notes,
                yourPeeks: view.revealed.map(r => `${r.subjectId} holds ${CARD_CATALOG[r.cardTypeId].displayName}`),
                deckRemaining: view.deckCount,
                table: view.players.map(p => ({
                    id: p.id,
                    who: nickOf.get(p.id) ?? p.id,
                    tokens: p.tokens,
                    alive: p.alive,
                    protected: p.protected,
                    discarded: p.discardPile.map(d => `${d.value} ${CARD_CATALOG[d.cardId].displayName}`)
                })),
                recentLog: view.publicLog.slice(-6),
                howToAnswer: `write ${path('move.json')} as {"cardInstanceId":"...","target":"p1","guess":5,"notes":"..."} — target and guess only when legal`
            },
            null,
            2
        )
    );

    for (;;) {
        if (existsSync(path('move.json'))) {
            const raw = readFileSync(path('move.json'), 'utf8');
            rmSync(path('move.json'));
            rmSync(path('turn.json'));
            return JSON.parse(raw) as Record<string, unknown>;
        }
        await Bun.sleep(200);
    }
}

// -------------------------------------------------------------------- the loop

let handPlayed = 0;
let winner: PlayerId | null = null;

try {
    for (let guard = 0; guard < 1200; guard++) {
        const signal = await mcp.tool<{ status: string; seat?: PlayerId; turnNumber: number }>('await_turn', { timeoutMs: 300 });

        if (signal.status === 'match_over') {
            winner = host.ended?.winnerSeat ?? host.lastState?.view.matchWinnerId ?? null;
            break;
        }

        if (signal.status === 'your_turn') {
            const seat = signal.seat!;
            const handle = handleOf.get(seat)!;
            const notes = (await mcp.tool<{ text: string }>('read_notebook', { handle })).text;
            const { view } = await mcp.tool<{ view: RedactedView }>('get_view', { handle });

            let move: Record<string, unknown>;
            let source: string;
            if (handPlayed < HAND_PLAYS) {
                move = await askDecider(seat, view, notes);
                handPlayed++;
                source = 'decided';
            } else {
                const auto = chooseFallbackPlay(view);
                if (auto === null) {
                    log(`!! ${seat} had no legal play at turn ${view.turnNumber}`);
                    break;
                }
                move = { ...auto };
                source = 'auto';
            }

            const notesOut = typeof move.notes === 'string' ? move.notes : notes;
            delete move.notes;

            try {
                await mcp.tool('play_card', { handle, ...move });
            } catch (err) {
                // A refused play is expected traffic, not a crash. The round
                // can advance between await_turn and play_card — with a short
                // reveal window it does, and the move chosen a moment ago is
                // stale. Design section 6: the seat sees the code, re-reads its
                // view, and plays again. So re-enter the loop.
                log(`t${view.turnNumber} ${nickOf.get(seat)} refused: ${err instanceof Error ? err.message : String(err)}`);
                continue;
            }
            await mcp.tool('write_notebook', { handle, text: notesOut });

            const shown = nameOf(move.cardInstanceId as CardInstanceId);
            const at = move.target !== undefined ? ` at ${nickOf.get(move.target as PlayerId) ?? move.target}` : '';
            const guessed = move.guess !== undefined ? ` guessing ${move.guess}` : '';
            log(`t${view.turnNumber} ${nickOf.get(seat)} plays ${shown}${at}${guessed}  [${source}]`);
            continue;
        }

        const status = await mcp.tool<{ phase: string; paused: boolean; currentPlayerId: PlayerId | null }>('table_status');
        if (status.phase === 'active' && !status.paused && status.currentPlayerId === created.hostSeat) {
            const view = host.lastState?.view;
            if (view !== undefined && view.own.legalPlays.length > 0) {
                const auto = chooseFallbackPlay(view);
                if (auto !== null) {
                    const before = view.turnNumber;
                    host.send({ type: 'PLAY_CARD', matchId: created.matchId, ...auto });
                    for (let i = 0; i < 80 && host.lastState?.view.turnNumber === before; i++) await Bun.sleep(25);
                    log(`t${before} Human plays ${nameOf(auto.cardInstanceId)}${auto.target ? ` at ${nickOf.get(auto.target) ?? auto.target}` : ''}`);
                }
            }
        }
    }

    const tokens = host.lastState?.view.players.map(p => `${nickOf.get(p.id)}=${p.tokens}`).join('  ') ?? '';
    log(`\n--- match over --- winner ${winner} (${nickOf.get(winner ?? ('' as PlayerId)) ?? '?'})`);
    log(`tokens  ${tokens}`);
    writeFileSync(path('result.json'), JSON.stringify({ winner, tokens, handPlayed }, null, 2));
} finally {
    mcp.kill();
    running.stop();
}
