#!/usr/bin/env bun
/**
 * Stands up a table and sits in the host seat, so an MCP client can take the
 * other three.
 *
 * Companion to `mcpPlay.ts`, minus the driving: this one owns the game server
 * and seat p1 only. Everything else — claiming seats, reading views, playing
 * cards — is expected to arrive over MCP from a client that is not this
 * process. That is the whole point: it makes the MCP path the real one rather
 * than a subprocess a test happens to be steering.
 *
 * Writes the match id to `<dir>/match.json` the moment the room exists, so a
 * caller can pick it up without parsing logs, and starts the match on its own
 * once enough seats are claimed.
 *
 *   bun scripts/hostSeat.ts --dir <scratch> [--port 3000] [--seats 3]
 */

import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { CARD_CATALOG, cardTypeOf } from '../src/game/engine';
import type { CardInstanceId, PlayerId } from '../src/game/engine';
import { makeConfig } from '../src/server/config';
import { serveStatic, startServer } from '../src/server/index';
import type { ClientMessage, ServerMessage } from '../src/server/protocol';
import { chooseFallbackPlay } from '../src/mcp/fallbackPlay';

function flag(name: string, fallback: string): string {
    const at = process.argv.indexOf(`--${name}`);
    return at !== -1 && process.argv[at + 1] !== undefined ? process.argv[at + 1]! : fallback;
}

const DIR = flag('dir', '/tmp/mules-host');
const PORT = Number(flag('port', '3000'));
const WANT_SEATS = Number(flag('seats', '3'));

if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
const path = (name: string) => join(DIR, name);

const log = (line: string): void => {
    appendFileSync(path('host.log'), `${line}\n`);
    console.log(line);
};

const nameOf = (card: CardInstanceId): string => {
    const def = CARD_CATALOG[cardTypeOf(card)];
    return `${def.value} ${def.displayName}`;
};

const running = startServer(
    makeConfig({
        port: PORT,
        dbPath: join(DIR, 'live.sqlite'),
        publicBaseUrl: `http://localhost:${PORT}`,
        staticRoot: 'dist'
    }),
    pathname => serveStatic('dist', pathname)
);

const base = `http://localhost:${running.server.port}`;
const created = (await (await fetch(`${base}/api/rooms`, { method: 'POST' })).json()) as {
    matchId: string;
    joinUrl: string;
    hostSeat: PlayerId;
    hostSeatToken: string;
};

writeFileSync(path('match.json'), JSON.stringify({ ...created, serverUrl: `ws://localhost:${running.server.port}`, watch: created.joinUrl }, null, 2));
log(`match   ${created.matchId}`);
log(`watch   ${created.joinUrl}`);

const ws = new WebSocket(`ws://localhost:${running.server.port}`);
let lastState: Extract<ServerMessage, { type: 'STATE_UPDATE' }> | null = null;
let claimed = 0;
let started = false;
let ended = false;

const send = (msg: ClientMessage): void => ws.send(JSON.stringify(msg));

ws.onopen = () => send({ type: 'RESUME_SEAT', matchId: created.matchId, seatToken: created.hostSeatToken, nickname: 'Human' });

ws.onmessage = event => {
    const msg = JSON.parse(String(event.data)) as ServerMessage;

    if (msg.type === 'LOBBY_UPDATE') {
        claimed = msg.seats.filter(s => s.status === 'occupied' && s.playerId !== created.hostSeat).length;
        if (!started && claimed >= WANT_SEATS && msg.canStart) {
            started = true;
            log(`seats claimed (${claimed}); starting`);
            send({ type: 'START_MATCH', matchId: created.matchId });
        }
        return;
    }

    if (msg.type === 'MATCH_ENDED') {
        ended = true;
        log(`\n--- match over --- reason ${msg.reason} winner ${msg.winnerSeat ?? 'none'}`);
        writeFileSync(path('result.json'), JSON.stringify(msg, null, 2));
        return;
    }

    if (msg.type !== 'STATE_UPDATE') return;
    lastState = msg;

    // Play seat p1 whenever it is up. The opponents are somebody else's problem
    // — which is exactly what this script exists to arrange.
    const view = msg.view;
    if (msg.phase !== 'active' || msg.paused) return;
    if (view.currentPlayerId !== created.hostSeat) return;
    if (view.own.legalPlays.length === 0) return;

    const move = chooseFallbackPlay(view);
    if (move === null) return;
    send({ type: 'PLAY_CARD', matchId: created.matchId, ...move });
    log(`t${view.turnNumber} Human plays ${nameOf(move.cardInstanceId)}${move.target ? ` at ${move.target}` : ''}${move.guess ? ` guessing ${move.guess}` : ''}`);
};

log(`host seated, waiting for ${WANT_SEATS} seats over MCP...`);

// Stay resident. The MCP client drives everything else.
while (!ended) await Bun.sleep(500);
await Bun.sleep(1500);
running.stop();
