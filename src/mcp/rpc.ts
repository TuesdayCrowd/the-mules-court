/**
 * JSON-RPC 2.0 over a line, which is all MCP's stdio transport is.
 *
 * Hand-written rather than taken from `@modelcontextprotocol/sdk`, and the
 * reason is the dependency's shape rather than its quality: 17 transitive
 * packages, among them express, hono, cors, express-rate-limit and jose — an
 * HTTP server stack and an OAuth implementation, none of which a stdio server
 * ever reaches. This repo has exactly one runtime dependency, and `protocol.ts`
 * already sets the precedent for writing the parser when the surface is small
 * and the alternative is large.
 *
 * The rule this file exists to get right is the one hand-rolled servers most
 * often break: **a notification is never answered.** A JSON-RPC message with no
 * `id` is a notification, and replying to one — even with an error — leaves a
 * client reconciling a response it has no request for. Every return path below
 * checks for an id before it speaks.
 *
 * Transport-level failures are JSON-RPC errors. Tool-level failures are not:
 * those are a successful response carrying `isError`, and they live in
 * `tools.ts`. Confusing the two is how a caller loses the ability to tell "your
 * request was malformed" from "the thing you asked for went wrong".
 */

export type MethodHandler = (params: unknown) => unknown | Promise<unknown>;
export type MethodHandlers = Record<string, MethodHandler>;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

type RequestId = string | number | null;

function errorFrame(id: RequestId, code: number, message: string): string {
    return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

/**
 * Handles one line and returns the line to write back, or null when the
 * protocol requires silence.
 *
 * Never throws. A malformed frame is expected traffic on a public-ish
 * transport, not an exceptional condition — the same stance
 * `parseClientMessage` takes on the game's own wire.
 */
export async function handleLine(line: string, methods: MethodHandlers): Promise<string | null> {
    const trimmed = line.trim();
    if (trimmed.length === 0) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        // No id to echo, so the spec's null id is the only honest answer.
        return errorFrame(null, PARSE_ERROR, 'Parse error: line was not valid JSON');
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return errorFrame(null, INVALID_REQUEST, 'Invalid Request: expected a JSON-RPC object');
    }

    const frame = parsed as Record<string, unknown>;
    // hasOwnProperty, not `in`: an inherited `id` is not this frame's id.
    const isRequest = Object.prototype.hasOwnProperty.call(frame, 'id') && frame.id !== null;
    const id = (isRequest ? frame.id : null) as RequestId;

    if (typeof frame.method !== 'string') {
        return isRequest ? errorFrame(id, INVALID_REQUEST, 'Invalid Request: method must be a string') : null;
    }

    // Own-property lookup, so a method named `toString` or `constructor` is a
    // miss rather than a hit on Object.prototype — the prototype-pollution row
    // of the transport's threat table, closed the same way.
    const handler = Object.prototype.hasOwnProperty.call(methods, frame.method) ? methods[frame.method] : undefined;
    if (handler === undefined) {
        return isRequest ? errorFrame(id, METHOD_NOT_FOUND, `Method not found: ${frame.method}`) : null;
    }

    try {
        const result = await handler(frame.params);
        // `result` is a required member of a success response, so an undefined
        // return becomes an empty object rather than a missing field.
        return isRequest ? JSON.stringify({ jsonrpc: '2.0', id, result: result ?? {} }) : null;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return isRequest ? errorFrame(id, INTERNAL_ERROR, message) : null;
    }
}
