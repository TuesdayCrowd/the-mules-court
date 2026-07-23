/**
 * A thin real-WebSocket test client (plan Task 13). No mocking of the
 * transport: every `TestClient` is a genuine `WebSocket` talking to a real
 * `Bun.serve` instance started by `integration.test.ts`.
 *
 * `nextOfType` keeps one FIFO queue per message type: a message that arrives
 * with no pending waiter is queued; a call that arrives with no queued
 * message registers a waiter. Either order resolves the same way, and
 * `nextOfType('STATE_UPDATE')` called twice in a row returns two DIFFERENT
 * pushes rather than the same one twice — a simple consumed-cursor per type,
 * exactly as the plan asks for, with nothing cleverer underneath.
 */

import { CARD_CATALOG, EFFECT_DEFS, cardTypeOf } from '../../game/engine';
import type { CardInstanceId, GuessValue, PlayerId, RedactedView } from '../../game/engine';
import type { ClientMessage, ServerMessage } from '../protocol';

interface Waiter {
    resolve: (msg: ServerMessage) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

type StateUpdate = Extract<ServerMessage, { type: 'STATE_UPDATE' }>;

/** One legal move for the given view (plan Task 13's `chooseMove`). */
export function chooseMove(view: RedactedView): { cardInstanceId: CardInstanceId; target?: PlayerId; guess?: GuessValue } {
    const cardInstanceId = view.own.legalPlays[0];
    const effectDef = EFFECT_DEFS[CARD_CATALOG[cardTypeOf(cardInstanceId)].effectType];
    const targets = view.players.filter(p => p.alive && !p.protected && p.id !== view.own.playerId).map(p => p.id);

    let target: PlayerId | undefined;
    if (effectDef.requiresTarget) {
        if (targets.length > 0) {
            target = targets[0];
        } else if (effectDef.canTargetSelf) {
            // PRINCE with no legal opponent: the only legal target left is self.
            target = view.own.playerId;
        }
        // Otherwise: no legal target at all. Omit `target` entirely — the fizzle rule.
    }

    // Guessed value is arbitrary (2 is always in range); the engine rejects a
    // guess on a fizzled play, so only attach one when a target was attached.
    const guess: GuessValue | undefined = effectDef.requiresGuess && target !== undefined ? 2 : undefined;

    return {
        cardInstanceId,
        ...(target !== undefined ? { target } : {}),
        ...(guess !== undefined ? { guess } : {})
    };
}

export class TestClient {
    readonly inbox: ServerMessage[] = [];
    readonly rawFrames: string[] = [];

    /** Latest STATE_UPDATE seen, or null before the match starts. */
    lastState: StateUpdate | null = null;
    /** own.hand of the latest STATE_UPDATE, tracked for the leak-fuzzer cross-check in integration.test.ts. */
    currentHand: readonly CardInstanceId[] = [];

    /**
     * Optional hook, invoked synchronously for every frame the instant it
     * arrives — after `lastState`/`currentHand` are updated, before it is
     * queued or handed to a waiter. integration.test.ts uses this to run its
     * leak-fuzzer assertions on every single push in real time, exactly as
     * Design §12 suite 6 asks for ("after EVERY received frame"), rather than
     * reconstructing an ordering after the fact from `rawFrames`.
     */
    onFrame: ((msg: ServerMessage, raw: string) => void) | null = null;

    private readonly ws: WebSocket;
    private readonly queues = new Map<string, ServerMessage[]>();
    private readonly waiters = new Map<string, Waiter[]>();

    private constructor(ws: WebSocket) {
        this.ws = ws;
    }

    static async connect(url: string): Promise<TestClient> {
        const ws = new WebSocket(url);
        await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => reject(new Error(`TestClient: connection to ${url} failed`));
        });
        const client = new TestClient(ws);
        ws.onmessage = event => client.handleFrame(String(event.data));
        return client;
    }

    send(msg: ClientMessage): void {
        this.ws.send(JSON.stringify(msg));
    }

    /** Resolves the next (or an already-received, unconsumed) message of `type`. */
    nextOfType<T extends ServerMessage['type']>(type: T, timeoutMs = 2000): Promise<Extract<ServerMessage, { type: T }>> {
        const queued = this.queues.get(type);
        if (queued && queued.length > 0) {
            return Promise.resolve(queued.shift() as Extract<ServerMessage, { type: T }>);
        }

        return new Promise((resolve, reject) => {
            const list = this.waiters.get(type) ?? [];
            const entry: Waiter = {
                resolve: msg => resolve(msg as Extract<ServerMessage, { type: T }>),
                reject,
                timer: setTimeout(() => {
                    const idx = list.indexOf(entry);
                    if (idx !== -1) list.splice(idx, 1);
                    reject(new Error(`TestClient.nextOfType('${type}') timed out after ${timeoutMs}ms`));
                }, timeoutMs)
            };
            list.push(entry);
            this.waiters.set(type, list);
        });
    }

    close(): void {
        this.ws.close();
    }

    private handleFrame(raw: string): void {
        this.rawFrames.push(raw);
        const msg = JSON.parse(raw) as ServerMessage;
        this.inbox.push(msg);

        if (msg.type === 'STATE_UPDATE') {
            this.lastState = msg;
            this.currentHand = msg.view.own.hand;
        }

        this.onFrame?.(msg, raw);

        const waiting = this.waiters.get(msg.type);
        if (waiting && waiting.length > 0) {
            const waiter = waiting.shift()!;
            clearTimeout(waiter.timer);
            waiter.resolve(msg);
            return;
        }

        const q = this.queues.get(msg.type) ?? [];
        q.push(msg);
        this.queues.set(msg.type, q);
    }
}
