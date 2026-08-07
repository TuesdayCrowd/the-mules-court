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

import type { FallbackInput } from './fallbackPlay';
import { CARD_CATALOG, cardTypeOf, EFFECT_DEFS } from '../game/engine';
import type { CardInstanceId, CardTypeId, RedactedView } from '../game/engine';
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
            'Claim seats at an existing match and receive one opaque handle per seat. Call this once, first, with the matchId from the host\'s invite link. Each handle authorises exactly one seat: hand a handle only to the agent playing that seat, and never read one seat\'s view with another seat\'s handle. Each returned seat carries `seat`, the 0-based index the wire itself uses (the same number ADD_BOT takes) — do not narrate this one to a human — and `seatLabel`, that same chair 1-based exactly as the browser lobby prints it ("Seat 2" for seat 1): narrate with seatLabel so an agent describing the table never contradicts what the human is looking at on their own screen.',
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
            'This seat\'s own redacted view of the table: its hand, its legal plays, its legal targets per play, what it has peeked, every discard pile, and the public log. Every entry in hand and legalPlays carries `value` and `displayName` alongside the bare cardInstanceId — every rule in this game (the Informant\'s guess, the Baron\'s compare, the deck-out showdown) is decided on a value, and there is no portrait here to read one off instead. A legalPlays entry also carries `requiresTarget`: when legalTargets for that card is an empty array, `requiresTarget: false` means the card simply takes no target, while `requiresTarget: true` means it takes one but none is legal right now — a fizzle, not a free play. Call it before every play, because legal plays are only populated while this seat holds the turn. Requires that seat\'s handle.',
        inputSchema: { type: 'object', properties: { ...HANDLE_PROPERTY }, required: ['handle'] }
    },
    {
        name: 'play_card',
        description:
            'Play one card for this seat and wait for the table to confirm it. Choose cardInstanceId from own.legalPlays and target from own.legalTargets for that card — both come from get_view and are already the engine\'s answers, so never compute legality yourself. A LEGAL play is not always a SAFE one: discarding The Mule is a legal play that eliminates this seat from the round on the spot, and own.legalPlays carries a `warning` string on that entry whenever playing it would. guess names a card VALUE from 2 to 8 and applies only to the Informant.',
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
 * Why `own.hand` and `own.legalPlays` carry more than `view.ts` puts in them.
 *
 * `src/client/content/cardCopy.ts`'s `cardLabel()` renders every card the
 * browser shows as "8 · The Mule" — value first — and its own comment gives
 * the reason: "value is what every rule in the game is written in". The
 * Informant's guess, the Baron's compare, and the deck-out showdown are all
 * decided on a number; the character is flavour on top of it. The browser was
 * changed to lean on that fact for the round-over screen. An MCP agent reading
 * a bare `own.hand: ["mule#0"]` has none of it: no portrait to recognise, no
 * value printed anywhere, just an instance id it has to resolve against an
 * eleven-identity deck table it would otherwise have to carry around in its
 * own head, every turn, for the rest of the match — while `players[].discardPile`
 * a few keys over already hands it values for cards nobody can play again.
 *
 * The Mule carries one thing more than a name. It is the one card whose
 * *legal* play self-eliminates its owner, and the browser spends a red Play
 * button and an explicit sentence on that (`playWarning`, rendered by
 * `src/client/ui/actionSheet.ts`). `own.legalPlays` is the only place an agent
 * chooses what to play, so the warning belongs on the entry itself — a fact
 * the agent must already know is not a fact an agent reliably already knows.
 *
 * None of this moves `view.ts`. What a seat may *see* stays the engine's
 * decision, and `view()` still hands `own.hand` and `own.legalPlays` as bare
 * instance ids, unchanged — see the regression guard in `tools.test.ts` that
 * calls `view()` directly and asserts exactly that. This is strictly a
 * shipping decision, layered on top of values the engine already computed
 * (`CARD_CATALOG`) and a static rule the engine already tags every effect
 * with (`EFFECT_DEFS[...].requiresTarget`, `.eliminatesOnDiscard`) — reformatted
 * for a client with no eyes.
 */
const MULE_DISCARD_WARNING = 'Discard The Mule — you are eliminated.';

interface DescribedCard {
    readonly cardInstanceId: CardInstanceId;
    readonly cardId: CardTypeId;
    readonly value: number;
    readonly displayName: string;
}

interface DescribedLegalPlay extends DescribedCard {
    readonly requiresTarget: boolean;
    /** Present for the Mule alone — see the comment above this block. */
    readonly warning?: string;
}

function describeCard(cardInstanceId: CardInstanceId): DescribedCard {
    const cardId = cardTypeOf(cardInstanceId);
    const def = CARD_CATALOG[cardId];
    return { cardInstanceId, cardId, value: def.value, displayName: def.displayName };
}

/**
 * `describeCard` plus what a seat needs to choose safely: whether the card
 * takes a target at all, and — keyed off the engine's own
 * `eliminatesOnDiscard` flag rather than the string "mule", so this reads
 * correctly if a future card ever shares the behaviour — the warning to
 * surface when playing it ends the seat's round.
 */
/**
 * The inverse of the enrichment above, for the one caller shape that needs it.
 *
 * `chooseFallbackPlay` is written against the ENGINE's `RedactedView`, where a
 * hand is bare instance ids. Anything that reads a seat's view back out of the
 * MCP *tool* — the stdio test, `scripts/mcpPlay.ts` — now gets the enriched
 * shape instead, and handing that straight to the fallback chooser throws
 * `instanceId.lastIndexOf is not a function` from inside `cardTypeOf`.
 *
 * Exported, and defined exactly once, because the failure is silent until a
 * live match reaches the fallback phase: two hand-rolled copies of this
 * conversion would drift, and the one that drifted would only be found by
 * somebody playing a real game.
 */
export function bareCardId(entry: CardInstanceId | { readonly cardInstanceId: CardInstanceId }): CardInstanceId {
    return typeof entry === 'string' ? entry : entry.cardInstanceId;
}

/** An enriched tool view, narrowed back to what `chooseFallbackPlay` reads. */
export function toFallbackInput(enriched: {
    readonly players: FallbackInput['players'];
    readonly revealed: FallbackInput['revealed'];
    readonly own: {
        readonly playerId: FallbackInput['own']['playerId'];
        readonly hand: readonly (CardInstanceId | { readonly cardInstanceId: CardInstanceId })[];
        readonly legalPlays: readonly (CardInstanceId | { readonly cardInstanceId: CardInstanceId })[];
        readonly legalTargets: FallbackInput['own']['legalTargets'];
    };
}): FallbackInput {
    return {
        players: enriched.players,
        revealed: enriched.revealed,
        own: {
            playerId: enriched.own.playerId,
            hand: enriched.own.hand.map(bareCardId),
            legalPlays: enriched.own.legalPlays.map(bareCardId),
            legalTargets: enriched.own.legalTargets
        }
    };
}

function describeLegalPlay(cardInstanceId: CardInstanceId): DescribedLegalPlay {
    const described = describeCard(cardInstanceId);
    const effect = EFFECT_DEFS[CARD_CATALOG[described.cardId].effectType];
    return {
        ...described,
        requiresTarget: effect.requiresTarget,
        ...(effect.eliminatesOnDiscard ? { warning: MULE_DISCARD_WARNING } : {})
    };
}

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
        own: {
            ...view.own,
            hand: view.own.hand.map(describeCard),
            legalPlays: view.own.legalPlays.map(describeLegalPlay)
        },
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
                // `seat` is 0-based and is the wire's own index — ADD_BOT and
                // every seat roster use it, so it is left exactly as
                // `joinMatch` returns it. The browser lobby labels chairs
                // 1-based ("Seat 2" for index 1), and an agent narrating a
                // match to the human sitting at it needs to say the word that
                // human is looking at, not the index the wire uses to route.
                // `seatLabel` carries that word; `seat` still carries the
                // number every other tool call and the transport expect.
                return ok(seats.map(seat => ({ ...seat, seatLabel: `Seat ${seat.seat + 1}` })));
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
