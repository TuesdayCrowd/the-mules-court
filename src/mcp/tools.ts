/**
 * The seven tools as MCP declares them, and the dispatch from a tool call onto
 * `MatchSession` (Design §4).
 *
 * Descriptions state **when** to reach for a tool, not only what it does. That
 * is not padding: a description naming its trigger measurably improves the rate
 * at which a caller reaches for the right tool at the right moment, and it costs
 * nothing to write once.
 *
 * Argument checking happens here, before the session is touched, so a
 * seat-scoped call with no handle is refused without the session ever seeing it.
 * A refusal is a successful MCP response carrying `isError` — a JSON-RPC error
 * would mean "your frame was malformed", which is a different and less useful
 * thing to tell an agent that simply passed the wrong argument.
 */

import type { RedactedView } from '../game/engine';
import type { SeatPlay } from './seatClient';
import type { AckResult, JoinedSeat, NotebookResult, TableStatus, ViewResult } from './session';
import type { TurnSignal } from './turnRouter';

/** The slice of `MatchSession` the tool layer uses. `MatchSession` satisfies it. */
export interface ToolSurface {
    joinMatch(input: { matchId: string; nicknames: readonly string[]; serverUrl: string }): Promise<JoinedSeat[]>;
    awaitTurn(timeoutMs?: number): Promise<TurnSignal>;
    tableStatus(): TableStatus;
    getView(handle: string): ViewResult;
    playCard(handle: string, move: SeatPlay, timeoutMs?: number): Promise<AckResult>;
    readNotebook(handle: string): NotebookResult;
    writeNotebook(handle: string, text: string): AckResult;
}

export interface ToolSchema {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, unknown>>;
    readonly required?: readonly string[];
}

export interface ToolDef {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: ToolSchema;
}

export interface ToolResult {
    readonly content: readonly { readonly type: 'text'; readonly text: string }[];
    readonly isError?: boolean;
}

/** Where the game server is, unless a call names one. */
export const DEFAULT_SERVER_URL = Bun.env.MULES_MCP_SERVER_URL ?? 'ws://localhost:3000';

const HANDLE_PROPERTY = {
    handle: { type: 'string', description: 'The opaque handle for one seat, as returned by join_match. Serves only that seat.' }
} as const;

export const TOOL_DEFS: readonly ToolDef[] = [
    {
        name: 'join_match',
        description:
            'Claim seats at an existing match and receive one opaque handle per seat. Call this once, first, with the matchId from the host\'s invite link. Each handle authorises exactly one seat: hand a handle only to the agent playing that seat, and never read one seat\'s view with another seat\'s handle.',
        inputSchema: {
            type: 'object',
            properties: {
                matchId: { type: 'string', description: 'The match to join.' },
                nicknames: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'One nickname per seat to claim, in order. Two or three is usual for a four-player table.'
                },
                serverUrl: { type: 'string', description: `WebSocket origin of the game server. Defaults to ${DEFAULT_SERVER_URL}.` }
            },
            required: ['matchId', 'nicknames']
        }
    },
    {
        name: 'await_turn',
        description:
            'Block until one of the held seats holds the turn. Call it again immediately after each play, and again after any `waiting` result — this is the referee loop. Returns `your_turn` with the seat to dispatch, `waiting` if it timed out with someone else up, `round_over` during a reveal, or `match_over` when the match has ended. Carries no cards: it is public routing information only.',
        inputSchema: {
            type: 'object',
            properties: {
                timeoutMs: { type: 'number', description: 'How long to block before reporting `waiting`. Defaults to 90000.' }
            }
        }
    },
    {
        name: 'table_status',
        description:
            'Public state of the table: seat roster, nicknames, phase, whose turn it is, and the tail of the public log. Safe for a referee to call at any time — it contains no hand. Use it to narrate the match to the human without looking at anybody\'s cards.',
        inputSchema: { type: 'object', properties: {} }
    },
    {
        name: 'get_view',
        description:
            'This seat\'s own redacted view of the table: its hand, its legal plays, its legal targets per play, what it has peeked, every discard pile, and the public log. Call it before every play, because legal plays are only populated while this seat holds the turn. Requires that seat\'s handle.',
        inputSchema: { type: 'object', properties: { ...HANDLE_PROPERTY }, required: ['handle'] }
    },
    {
        name: 'play_card',
        description:
            'Play one card for this seat and wait for the table to confirm it. Choose cardInstanceId from own.legalPlays and target from own.legalTargets for that card — both come from get_view and are already the engine\'s answers, so never compute legality yourself. guess names a card VALUE from 2 to 8 and applies only to the Informant.',
        inputSchema: {
            type: 'object',
            properties: {
                ...HANDLE_PROPERTY,
                cardInstanceId: { type: 'string', description: 'A card from own.legalPlays, e.g. "informant#2".' },
                target: { type: 'string', description: 'A player id from own.legalTargets for that card. Omit when the card takes no target.' },
                guess: { type: 'number', description: 'Informant only: a card value from 2 to 8. Never 1.' }
            },
            required: ['handle', 'cardInstanceId']
        }
    },
    {
        name: 'read_notebook',
        description:
            'Read back this seat\'s private notes. Call it at the start of each of this seat\'s turns, before deciding — it is how the seat remembers what it deduced on earlier turns. Invisible to every other seat.',
        inputSchema: { type: 'object', properties: { ...HANDLE_PROPERTY }, required: ['handle'] }
    },
    {
        name: 'write_notebook',
        description:
            'Replace this seat\'s private notes. Call it at the end of each of this seat\'s turns to record what was learned — who dodged a guess, who discarded high, what a peek revealed. Replaces the whole text, so include anything still worth keeping. Invisible to every other seat.',
        inputSchema: {
            type: 'object',
            properties: { ...HANDLE_PROPERTY, text: { type: 'string', description: 'The notes to keep, replacing what was there.' } },
            required: ['handle', 'text']
        }
    }
];

/**
 * The view as a seat should receive it: every finished round keeps its outcome
 * and loses its log.
 *
 * Two reasons, and the first is the real one. **A finished round's log cannot
 * inform the current one** — every card goes back into the deck between rounds,
 * so nothing in it constrains anybody's hand now. It is in `RedactedView`
 * because the browser renders match history from it, which is a display need,
 * not a player's.
 *
 * The second is that it grows without bound. `roundHistory` accumulates every
 * round's full log for the life of the match, so an untrimmed `get_view` gets
 * more expensive on every round of the match it exists to play — and for an MCP
 * client, context is the scarce resource. Measured live: by round four a single
 * call was shipping three complete rounds of log.
 *
 * Trimmed here rather than in `view.ts` on purpose. What a seat may *see* is the
 * engine's decision and must not move; how much of it a tool *ships* is this
 * layer's, and `table_status` already makes the same call with `LOG_TAIL`.
 */
function compactView(view: RedactedView): unknown {
    return {
        ...view,
        roundHistory: view.roundHistory.map(round => ({
            roundNumber: round.roundNumber,
            reason: round.reason,
            winnerIds: round.winnerIds
        }))
    };
}

function ok(payload: unknown): ToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function fail(message: string): ToolResult {
    return { content: [{ type: 'text', text: message }], isError: true };
}

function stringArg(input: Record<string, unknown>, key: string): string | null {
    const value = input[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Dispatches one tool call. Never throws: a thrown error becomes an `isError` result. */
export async function callTool(surface: ToolSurface, name: string, args: unknown): Promise<ToolResult> {
    const input = (typeof args === 'object' && args !== null && !Array.isArray(args) ? args : {}) as Record<string, unknown>;

    // Checked up front for all four seat-scoped tools, so none of them can
    // reach the session without a capability.
    const seatScoped = name === 'get_view' || name === 'play_card' || name === 'read_notebook' || name === 'write_notebook';
    const handle = stringArg(input, 'handle');
    if (seatScoped && handle === null) {
        return fail(`${name} requires a handle: the string returned for this seat by join_match.`);
    }

    try {
        switch (name) {
            case 'join_match': {
                const matchId = stringArg(input, 'matchId');
                if (matchId === null) return fail('join_match requires matchId.');
                const raw = input.nicknames;
                if (!Array.isArray(raw) || raw.length === 0 || !raw.every(n => typeof n === 'string' && n.length > 0)) {
                    return fail('join_match requires nicknames: a non-empty array of strings, one per seat to claim.');
                }
                const seats = await surface.joinMatch({
                    matchId,
                    nicknames: raw as string[],
                    serverUrl: stringArg(input, 'serverUrl') ?? DEFAULT_SERVER_URL
                });
                return ok(seats);
            }

            case 'await_turn': {
                const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined;
                return ok(await surface.awaitTurn(timeoutMs));
            }

            case 'table_status':
                return ok(surface.tableStatus());

            case 'get_view': {
                const result = surface.getView(handle!);
                return result.ok ? ok({ view: compactView(result.view), nicknames: result.nicknames }) : fail(`get_view refused: ${result.error}`);
            }

            case 'play_card': {
                const cardInstanceId = stringArg(input, 'cardInstanceId');
                if (cardInstanceId === null) return fail('play_card requires cardInstanceId, chosen from own.legalPlays.');
                const move: SeatPlay = {
                    cardInstanceId: cardInstanceId as SeatPlay['cardInstanceId'],
                    ...(typeof input.target === 'string' ? { target: input.target } : {}),
                    ...(typeof input.guess === 'number' ? { guess: input.guess as SeatPlay['guess'] } : {})
                };
                const played = await surface.playCard(handle!, move);
                return played.ok ? ok({ played: move }) : fail(`play_card refused: ${played.error}`);
            }

            case 'read_notebook': {
                const notes = surface.readNotebook(handle!);
                return notes.ok ? ok({ text: notes.text }) : fail(`read_notebook refused: ${notes.error}`);
            }

            case 'write_notebook': {
                const text = input.text;
                if (typeof text !== 'string') return fail('write_notebook requires text.');
                const written = surface.writeNotebook(handle!, text);
                return written.ok ? ok({ saved: text.length }) : fail(`write_notebook refused: ${written.error}`);
            }

            default:
                return fail(`Unknown tool: ${name}`);
        }
    } catch (err) {
        return fail(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}
