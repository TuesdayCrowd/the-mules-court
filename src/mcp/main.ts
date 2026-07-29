#!/usr/bin/env bun
/**
 * The MCP server, over stdio. Stage 3b, and deliberately the thinnest file in
 * the package: every decision is in `session.ts`, every tool shape is in
 * `tools.ts`, and every protocol rule is in `rpc.ts`.
 *
 * **stdout carries protocol frames and nothing else.** A stray `console.log`
 * here is not a cosmetic problem — it lands in the middle of the JSON-RPC
 * stream and desynchronises the client, usually presenting as a server whose
 * tools silently stop working. Diagnostics go to stderr, which is why the one
 * log below is `console.error` despite not being an error.
 *
 * Run directly (`bun src/mcp/main.ts`) or through `.mcp.json`. It needs the
 * game server reachable at `MULES_MCP_SERVER_URL`, default `ws://localhost:3000`.
 */

import { handleLine, type MethodHandlers } from './rpc';
import { MatchSession } from './session';
import { callTool, DEFAULT_SERVER_URL, TOOL_DEFS } from './tools';

const SERVER_INFO = { name: 'mules-court-seats', version: '1.0.0' } as const;

/**
 * Newest first. The handshake echoes the client's version when we speak it and
 * answers with our newest when we do not, which is what the spec asks for and
 * what lets an older client connect instead of failing opaquely.
 */
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

const session = new MatchSession();

const methods: MethodHandlers = {
    initialize: params => {
        const requested = (params as { protocolVersion?: unknown } | null)?.protocolVersion;
        const agreed =
            typeof requested === 'string' && (SUPPORTED_PROTOCOLS as readonly string[]).includes(requested)
                ? requested
                : SUPPORTED_PROTOCOLS[0];

        return { protocolVersion: agreed, capabilities: { tools: {} }, serverInfo: SERVER_INFO };
    },

    ping: () => ({}),

    'tools/list': () => ({ tools: TOOL_DEFS }),

    'tools/call': async params => {
        const call = (params ?? {}) as { name?: unknown; arguments?: unknown };
        if (typeof call.name !== 'string') throw new Error('tools/call requires a string `name`');
        return callTool(session, call.name, call.arguments);
    }
};

/**
 * Splits the stdin byte stream into lines.
 *
 * A frame can arrive split across chunks, or several frames can arrive in one,
 * so the buffer is carried between chunks and `decode` is called in streaming
 * mode — a multi-byte character straddling a chunk boundary would otherwise be
 * mangled into a parse error.
 */
async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    let buffer = '';

    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        for (;;) {
            const newline = buffer.indexOf('\n');
            if (newline === -1) break;
            yield buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
        }
    }

    if (buffer.trim().length > 0) yield buffer;
}

console.error(`mules-court-seats: MCP server on stdio, game server ${DEFAULT_SERVER_URL}`);

for await (const line of readLines(Bun.stdin.stream())) {
    const response = await handleLine(line, methods);
    if (response !== null) await Bun.write(Bun.stdout, `${response}\n`);
}

session.close();
