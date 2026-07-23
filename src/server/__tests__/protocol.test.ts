import { describe, expect, it } from 'bun:test';
import { parseClientMessage } from '../protocol';
import type { ClientMessage } from '../protocol';

const MAX_NICKNAME = 24;

/**
 * Table-driven per Design §12.1: every variant's happy path, every variant
 * with one extra field, closed-enum boundaries for target/guess, the
 * nickname rules, and the non-object JSON shapes. `raw` is the literal wire
 * payload; parseClientMessage owns JSON.parse, so rows pass strings, not
 * pre-parsed objects.
 *
 * `expectedMsg`, where present, pins the exact parsed shape — not merely
 * `ok: true` — so a field transposed with another (e.g. `clientMsgId` fed
 * from `matchId`) fails the row instead of passing it.
 */
const rows: { name: string; raw: string; ok: boolean; expectedMsg?: ClientMessage }[] = [
    // --- happy paths, one per variant ---
    {
        name: 'CLAIM_SEAT — happy path',
        raw: JSON.stringify({ type: 'CLAIM_SEAT', matchId: 'm1', nickname: 'Bayta' }),
        ok: true
    },
    {
        name: 'RESUME_SEAT — happy path',
        raw: JSON.stringify({ type: 'RESUME_SEAT', matchId: 'm1', seatToken: 'tok' }),
        ok: true,
        expectedMsg: { type: 'RESUME_SEAT', matchId: 'm1', seatToken: 'tok' }
    },
    {
        name: 'START_MATCH — happy path',
        raw: JSON.stringify({ type: 'START_MATCH', matchId: 'm1' }),
        ok: true
    },
    {
        name: 'PLAY_CARD — happy path, no target/guess',
        raw: JSON.stringify({ type: 'PLAY_CARD', matchId: 'm1', cardInstanceId: 'shielded-mind#0' }),
        ok: true
    },
    {
        name: 'PLAY_CARD — happy path with target, guess, clientMsgId',
        raw: JSON.stringify({
            type: 'PLAY_CARD',
            matchId: 'm1',
            cardInstanceId: 'informant#0',
            target: 'p2',
            guess: 8,
            clientMsgId: 'abc123'
        }),
        ok: true,
        expectedMsg: {
            type: 'PLAY_CARD',
            matchId: 'm1',
            cardInstanceId: 'informant#0',
            target: 'p2',
            guess: 8,
            clientMsgId: 'abc123'
        }
    },
    {
        name: 'END_MATCH — happy path',
        raw: JSON.stringify({ type: 'END_MATCH', matchId: 'm1' }),
        ok: true
    },
    {
        name: 'REQUEST_RESYNC — happy path',
        raw: JSON.stringify({ type: 'REQUEST_RESYNC', matchId: 'm1' }),
        ok: true
    },
    {
        name: 'PING — happy path',
        raw: JSON.stringify({ type: 'PING' }),
        ok: true
    },

    // --- one extra field per variant ---
    {
        name: 'CLAIM_SEAT — rejects an extra field',
        raw: JSON.stringify({ type: 'CLAIM_SEAT', matchId: 'm1', nickname: 'Bayta', seat: 1 }),
        ok: false
    },
    {
        name: 'RESUME_SEAT — rejects an extra field',
        raw: JSON.stringify({ type: 'RESUME_SEAT', matchId: 'm1', seatToken: 'tok', extra: true }),
        ok: false
    },
    {
        name: 'START_MATCH — rejects an extra field',
        raw: JSON.stringify({ type: 'START_MATCH', matchId: 'm1', extra: true }),
        ok: false
    },
    {
        // The named case from Design §12.1: PLAY_CARD must never accept a client-supplied playerId.
        name: 'PLAY_CARD — rejects a playerId field',
        raw: JSON.stringify({
            type: 'PLAY_CARD',
            matchId: 'm1',
            cardInstanceId: 'informant#0',
            playerId: 'p1'
        }),
        ok: false
    },
    {
        name: 'END_MATCH — rejects an extra field',
        raw: JSON.stringify({ type: 'END_MATCH', matchId: 'm1', extra: true }),
        ok: false
    },
    {
        name: 'REQUEST_RESYNC — rejects an extra field',
        raw: JSON.stringify({ type: 'REQUEST_RESYNC', matchId: 'm1', extra: true }),
        ok: false
    },
    {
        name: 'PING — rejects an extra field',
        raw: JSON.stringify({ type: 'PING', extra: true }),
        ok: false
    },

    // --- missing required fields ---
    {
        name: 'CLAIM_SEAT — rejects a missing matchId',
        raw: JSON.stringify({ type: 'CLAIM_SEAT', nickname: 'Bayta' }),
        ok: false
    },
    {
        name: 'PLAY_CARD — rejects a missing cardInstanceId',
        raw: JSON.stringify({ type: 'PLAY_CARD', matchId: 'm1' }),
        ok: false
    },

    // --- wrong-typed fields ---
    {
        name: 'START_MATCH — rejects a numeric matchId',
        raw: JSON.stringify({ type: 'START_MATCH', matchId: 42 }),
        ok: false
    },
    {
        // Pins parseMatchIdOnly's shared behavior for this variant, not just START_MATCH's.
        name: 'END_MATCH — rejects a numeric matchId',
        raw: JSON.stringify({ type: 'END_MATCH', matchId: 42 }),
        ok: false
    },
    {
        // Pins parseMatchIdOnly's shared behavior for this variant, not just START_MATCH's.
        name: 'REQUEST_RESYNC — rejects a numeric matchId',
        raw: JSON.stringify({ type: 'REQUEST_RESYNC', matchId: 42 }),
        ok: false
    },
    {
        name: 'PLAY_CARD — rejects a malformed cardInstanceId',
        raw: JSON.stringify({ type: 'PLAY_CARD', matchId: 'm1', cardInstanceId: 'informant' }),
        ok: false
    },

    // --- unknown type ---
    {
        name: 'rejects an unknown message type',
        raw: JSON.stringify({ type: 'NOT_A_REAL_TYPE', matchId: 'm1' }),
        ok: false
    },

    // --- target closed enum ---
    {
        name: 'target — rejects out-of-range seat p5',
        raw: JSON.stringify({ type: 'PLAY_CARD', matchId: 'm1', cardInstanceId: 'informant#0', target: 'p5', guess: 8 }),
        ok: false
    },
    {
        name: 'target — rejects wrong case P1',
        raw: JSON.stringify({ type: 'PLAY_CARD', matchId: 'm1', cardInstanceId: 'informant#0', target: 'P1', guess: 8 }),
        ok: false
    },
    {
        name: 'target — rejects a prototype-pollution string',
        raw: JSON.stringify({
            type: 'PLAY_CARD',
            matchId: 'm1',
            cardInstanceId: 'informant#0',
            target: '__proto__',
            guess: 8
        }),
        ok: false
    },
    {
        name: 'target — rejects an object value',
        raw: JSON.stringify({ type: 'PLAY_CARD', matchId: 'm1', cardInstanceId: 'informant#0', target: {}, guess: 8 }),
        ok: false
    },
    {
        name: 'target — accepts a valid seat',
        raw: JSON.stringify({ type: 'PLAY_CARD', matchId: 'm1', cardInstanceId: 'informant#0', target: 'p4', guess: 8 }),
        ok: true
    },

    // --- guess closed range ---
    {
        name: 'guess — rejects 1 (the Informant itself)',
        raw: JSON.stringify({ type: 'PLAY_CARD', matchId: 'm1', cardInstanceId: 'informant#0', target: 'p2', guess: 1 }),
        ok: false
    },
    {
        name: 'guess — rejects 9 (above the deck range)',
        raw: JSON.stringify({ type: 'PLAY_CARD', matchId: 'm1', cardInstanceId: 'informant#0', target: 'p2', guess: 9 }),
        ok: false
    },
    {
        name: 'guess — rejects a string "2"',
        raw: JSON.stringify({ type: 'PLAY_CARD', matchId: 'm1', cardInstanceId: 'informant#0', target: 'p2', guess: '2' }),
        ok: false
    },
    {
        name: 'guess — rejects a non-integer 2.5',
        raw: JSON.stringify({ type: 'PLAY_CARD', matchId: 'm1', cardInstanceId: 'informant#0', target: 'p2', guess: 2.5 }),
        ok: false
    },
    {
        name: 'guess — accepts an integer in range',
        raw: JSON.stringify({ type: 'PLAY_CARD', matchId: 'm1', cardInstanceId: 'informant#0', target: 'p2', guess: 8 }),
        ok: true
    },

    // --- nickname rules ---
    {
        name: 'nickname — rejects empty after trim',
        raw: JSON.stringify({ type: 'CLAIM_SEAT', matchId: 'm1', nickname: '   ' }),
        ok: false
    },
    {
        name: 'nickname — rejects a nickname longer than the max (25 chars)',
        raw: JSON.stringify({ type: 'CLAIM_SEAT', matchId: 'm1', nickname: 'a'.repeat(25) }),
        ok: false
    },
    {
        name: 'nickname — rejects a control character',
        raw: JSON.stringify({ type: 'CLAIM_SEAT', matchId: 'm1', nickname: `ok${String.fromCharCode(0)}ok` }),
        ok: false
    },
    {
        name: 'nickname — trims surrounding whitespace and accepts',
        raw: JSON.stringify({ type: 'CLAIM_SEAT', matchId: 'm1', nickname: '  ok  ' }),
        ok: true
    },

    // --- non-object JSON ---
    { name: 'rejects JSON null', raw: JSON.stringify(null), ok: false },
    { name: 'rejects a JSON array', raw: JSON.stringify([]), ok: false },
    { name: 'rejects a bare JSON number', raw: JSON.stringify(42), ok: false },
    { name: 'rejects a bare JSON string (not an object)', raw: JSON.stringify('PING'), ok: false },

    // --- unparseable payloads ---
    { name: 'rejects unparseable JSON', raw: '{not json', ok: false },
    { name: 'rejects an empty string', raw: '', ok: false }
];

describe('parseClientMessage', () => {
    for (const row of rows) {
        it(`${row.name} (${row.ok ? 'ok' : 'rejected'})`, () => {
            const result = parseClientMessage(row.raw, MAX_NICKNAME);
            expect(result.ok).toBe(row.ok);
            if (row.expectedMsg !== undefined && result.ok) {
                expect(result.msg).toEqual(row.expectedMsg);
            }
        });
    }

    it('accepts a nickname the design shows accepted-and-trimmed, returning "ok"', () => {
        const result = parseClientMessage(
            JSON.stringify({ type: 'CLAIM_SEAT', matchId: 'm1', nickname: '  ok  ' }),
            MAX_NICKNAME
        );
        expect(result.ok).toBe(true);
        if (result.ok && result.msg.type === 'CLAIM_SEAT') {
            expect(result.msg.nickname).toBe('ok');
        }
    });

    it('never throws on any malformed row', () => {
        for (const row of rows.filter(r => !r.ok)) {
            expect(() => parseClientMessage(row.raw, MAX_NICKNAME)).not.toThrow();
        }
    });
});
