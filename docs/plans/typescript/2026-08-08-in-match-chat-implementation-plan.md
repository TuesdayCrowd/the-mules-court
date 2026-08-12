# In-Match Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One public text channel per match — live from lobby creation, delivered whole to whoever arrives next, never persisted, gone when the room is.

**Architecture:** A new client→server message and two new server→client messages ride the WebSocket that already exists. The transcript is an in-memory array on the live `Room`, broadcast unredacted the way `LOBBY_UPDATE` already is, and delivered whole on seat claim and on every resume. The client holds it as one immutable slice of `ClientState`, and one new DOM surface renders it — an always-visible rail on a large screen, a launcher with an unread badge on a small one, with the breakpoint living in exactly one CSS media query.

**Tech Stack:** TypeScript 5.7 (strict), Bun, Vite 6. **Zero runtime dependencies** — `package.json` declares none, and this feature adds none.

**Design:** `docs/plans/typescript/2026-08-08-in-match-chat-design.md`. Read it before Task 1. Section references below (§4, §5, §7) point at it.

## Global Constraints

- **No runtime dependencies.** Not one. No date library, no sanitiser, no virtual list.
- **Message limit: 255 characters, ASCII 32–126 inclusive.** 126, not 127: `0x7F` is DEL. This makes messages single-line — `0x0A` is below 32.
- **Transcript cap: 1 MiB** (`1_048_576`) of serialized payload, oldest evicted first.
- **Chat rate limit: burst 5, refill 1/sec**, on a bucket dedicated to `SEND_CHAT`.
- **Rail: 320px (`20rem`)**, shown only by `@media (min-width: 1200px) and (min-height: 640px) and (min-aspect-ratio: 4/3)`. That breakpoint appears in **exactly one place in the codebase**, in CSS. No TypeScript constant mirrors it.
- **Never persist a chat message.** Nothing chat-related may enter `MatchRecord`, the sqlite schema, or the `actionLog`.
- **Player-facing copy lives in `src/client/content/`.** The wire carries codes, never sentences — the same rule `Notice` follows with `ErrorCode`.
- **Text reaches the DOM through `textContent`**, never `innerHTML`. There is no sanitiser in this repo and there must not need to be one.
- **Surfaces never read the store.** `update(state)` is pushed by the single subscriber in `main.ts`.
- **Commits use `but`, never `git`.** Every task commits to the branch `in-match-chat`; `but commit -b in-match-chat` creates it on the first task and reuses it after.
- **The gate order is load-bearing:** `bun run build && bunx tsc --noEmit && bun run test`. A new client file moves Vite's content-hashed bundle name, and running the suite first fails `embeddedManifest.test.ts` in a way that reads as a broken import.

## File Structure

```
src/server/
  config.ts          MODIFY  four tunables
  protocol.ts        MODIFY  ChatEntry, three message variants, parse arm, ParseLimits
  room.ts            MODIFY  chatLog + byte total, sendChat(), history delivery, rebuild note
  dispatch.ts        MODIFY  chatBucket on ConnectionState, SEND_CHAT routing
  index.ts           MODIFY  construct the chat bucket
src/client/
  content/chat.ts    CREATE  validation + every player-facing chat string
  store/types.ts     MODIFY  ClientState.chat
  store/store.ts     MODIFY  two apply cases, sendChat()
  store/socket.ts    MODIFY  two entries in SERVER_MESSAGE_TYPES
  ui/chatRail.ts     CREATE  the surface: transcript, composer, launcher, badge
  styles/ui.css      MODIFY  --chat-rail-w, the media query, the insets, rail styling
  __tests__/purity.test.ts   MODIFY  ALLOWED gains content/chat.ts
  __tests__/axe.test.ts      MODIFY  two SURFACES entries, count bumped
src/main.ts          MODIFY  construct the rail; viewport getters measure the play area
visual/gallery.ts    MODIFY  a chat specimen
visual/harness.ts    MODIFY  judgeSpecimen branch for it
CHANGELOG.md         MODIFY  an Unreleased entry
```

---

## Task 1: The wire

**Files:**
- Modify: `src/server/config.ts:7-59`
- Modify: `src/server/protocol.ts:50-110`, `:112-303`
- Modify: `src/server/dispatch.ts:98` (call-site only)
- Modify: `src/client/content/nickname.test.ts:72,104` (call-site only)
- Test: `src/server/__tests__/protocol.test.ts`

**Interfaces:**
- Produces: `ChatEntry`, `ChatNoteCode`, `ParseLimits`; `ClientMessage` variant `SEND_CHAT`; `ServerMessage` variants `CHAT_SAID`, `CHAT_HISTORY`; `parseClientMessage(raw: string, limits: ParseLimits): ParseResult`; `TransportConfig.maxChatLength | chatBurst | chatRefillPerSec | chatLogMaxBytes`.

**Why the signature changes.** `parseClientMessage` currently takes `maxNickname` positionally. Chat needs a second limit, and a second positional number is the shape that gets passed in the wrong order eventually. There are only six call sites in the repo, so a named object is cheap and self-documenting.

- [ ] **Step 1: Write the failing tests**

Append to `src/server/__tests__/protocol.test.ts`. The file already imports `parseClientMessage`; add a local limits constant near the top of your new block rather than editing existing rows.

```ts
const LIMITS = { maxNickname: 24, maxChat: 255 } as const;

describe('SEND_CHAT', () => {
    const send = (text: unknown) =>
        parseClientMessage(JSON.stringify({ type: 'SEND_CHAT', matchId: 'K7QX2', text }), LIMITS);

    it('accepts ordinary printable text', () => {
        const result = send('I have the Mule. Obviously.');
        expect(result.ok).toBe(true);
        expect(result.ok && result.msg).toEqual({
            type: 'SEND_CHAT',
            matchId: 'K7QX2',
            text: 'I have the Mule. Obviously.'
        });
    });

    it('trims, and measures length after trimming', () => {
        const result = send(`  ${'a'.repeat(255)}  `);
        expect(result.ok && result.msg.type === 'SEND_CHAT' && result.msg.text.length).toBe(255);
    });

    it('refuses an empty or whitespace-only message', () => {
        expect(send('').ok).toBe(false);
        expect(send('   ').ok).toBe(false);
    });

    it('refuses 256 characters', () => {
        expect(send('a'.repeat(256)).ok).toBe(false);
    });

    it('refuses DEL, which is 127 and not printable', () => {
        expect(send('hi').ok).toBe(false);
    });

    it('refuses a newline, so a message is always one line', () => {
        expect(send('one\ntwo').ok).toBe(false);
    });

    it('refuses non-ASCII, including an em dash and an emoji', () => {
        expect(send('an em dash — here').ok).toBe(false);
        expect(send('nice \u{1F600}').ok).toBe(false);
    });

    it('refuses a non-string text, a missing text, and an extra field', () => {
        expect(send(42).ok).toBe(false);
        expect(parseClientMessage(JSON.stringify({ type: 'SEND_CHAT', matchId: 'K7QX2' }), LIMITS).ok).toBe(false);
        expect(
            parseClientMessage(
                JSON.stringify({ type: 'SEND_CHAT', matchId: 'K7QX2', text: 'hi', playerId: 'p2' }),
                LIMITS
            ).ok
        ).toBe(false);
    });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `bun test src/server/__tests__/protocol.test.ts`
Expected: FAIL. The existing `parseClientMessage(row.raw, MAX_NICKNAME)` calls also fail to type-check once Step 3 lands — that is expected and Step 4 fixes them.

- [ ] **Step 3: Add the tunables**

In `src/server/config.ts`, add to the `TransportConfig` interface after `maxNicknameLength`:

```ts
    readonly maxChatLength: number;          // 255
    readonly chatBurst: number;              // 5 — chat's own bucket capacity
    readonly chatRefillPerSec: number;       // 1
    readonly chatLogMaxBytes: number;        // 1 MiB of serialized transcript
```

and to `DEFAULT_CONFIG` after `maxNicknameLength: 24,`:

```ts
    maxChatLength: 255,
    // Chat spends from its own bucket rather than the shared one, so a player
    // typing quickly can never rate-limit their own next PLAY_CARD. One a
    // second sustained is faster than anyone types; five in hand covers a
    // burst of short replies.
    chatBurst: 5,
    chatRefillPerSec: 1,
    // Insurance, not a working constraint: at 255 characters a message this is
    // several thousand of them. It exists because a `CHAT_HISTORY` frame is
    // sent whole to every arriving seat, and `perMessageDeflate` is off.
    chatLogMaxBytes: 1_048_576,
```

- [ ] **Step 4: Add the wire types and the parse arm**

In `src/server/protocol.ts`:

```ts
/** What a system line in the transcript says. A code, never a sentence — copy lives in the client. */
export type ChatNoteCode =
    // The process restarted and the room was rebuilt; the transcript did not survive.
    | 'RESTARTED'
    // The byte cap evicted the oldest entries, so the transcript begins partway through.
    | 'TRIMMED';

/**
 * One line of the transcript.
 *
 * `nickname` is denormalized rather than resolved from `STATE_UPDATE`'s
 * `nicknames` map at render time, and that is the point: `Room.sweep()` reopens
 * a disconnected lobby seat by clearing its name, and the next arrival claims
 * the same `p2`. A transcript keyed on `PlayerId` alone would relabel one
 * person's words as another's an hour later.
 *
 * Nullable because a seat can genuinely hold no name — the host seat is minted
 * over HTTP without one. The client renders a seat label in that case.
 */
export type ChatEntry = { readonly seq: number; readonly sentAt: number } & (
    | { readonly kind: 'said'; readonly from: PlayerId; readonly nickname: string | null; readonly text: string }
    | { readonly kind: 'note'; readonly code: ChatNoteCode }
);
```

Add to `ClientMessage`:

```ts
    // No playerId, for the reason PLAY_CARD has none: the acting seat is the
    // bound connection's. No clientMsgId either — nothing is locked while a
    // chat message flies, so nothing waits on its acknowledgement.
    | { type: 'SEND_CHAT'; matchId: MatchId; text: string }
```

Add to `ServerMessage`:

```ts
    // Broadcast, append one. The same unredacted fan-out LOBBY_UPDATE uses:
    // chat carries no hidden game state, so there is no per-seat view of it.
    | { type: 'CHAT_SAID'; matchId: MatchId; entry: ChatEntry }
    // Unicast, replace the whole slice. Sent on seat claim and on every resume.
    // Deliberately a separate type from CHAT_SAID rather than an array of one:
    // a match in which exactly one thing has been said would otherwise produce
    // a history frame indistinguishable from a live broadcast of that entry,
    // and a client that appends shows it twice.
    | { type: 'CHAT_HISTORY'; matchId: MatchId; entries: ChatEntry[] }
```

Replace the `maxNickname` parameter with a limits object. Above `parseClientMessage`:

```ts
/** The two free-text limits the parser enforces. Named rather than positional: two bare numbers get swapped. */
export interface ParseLimits {
    readonly maxNickname: number;
    readonly maxChat: number;
}

/** Printable ASCII, inclusive. 0x7F is DEL — a control character, not a printable one. */
const PRINTABLE_ASCII_MIN = 0x20;
const PRINTABLE_ASCII_MAX = 0x7e;

/**
 * Trims, then refuses empty, oversized, and anything outside printable ASCII.
 *
 * Stricter than `parseNickname`, which only bars control characters: a chat
 * message is rendered as a run of text in a transcript, and restricting it to
 * one well-understood range is what lets the client measure and lay out a line
 * without a shaping surprise. `0x0A` falls below the floor, so a message is
 * always a single line.
 *
 * Iterates code UNITS rather than code points on purpose: any astral character
 * has both surrogates outside the range, so it is refused by either reading,
 * and this needs no `Intl` and no iterator allocation per message.
 */
function parseChatText(value: unknown, maxChat: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > maxChat) return undefined;
    for (let i = 0; i < trimmed.length; i++) {
        const code = trimmed.charCodeAt(i);
        if (code < PRINTABLE_ASCII_MIN || code > PRINTABLE_ASCII_MAX) return undefined;
    }
    return trimmed;
}
```

Change the signature to `export function parseClientMessage(raw: string, limits: ParseLimits): ParseResult`, replace the two `maxNickname` uses inside with `limits.maxNickname`, and add the arm before `case 'PING'`:

```ts
        case 'SEND_CHAT': {
            if (!hasExactKeys(obj, ['type', 'matchId', 'text'])) return { ok: false };
            if (typeof obj.matchId !== 'string') return { ok: false };
            const text = parseChatText(obj.text, limits.maxChat);
            if (text === undefined) return { ok: false };
            return { ok: true, msg: { type: 'SEND_CHAT', matchId: obj.matchId, text } };
        }
```

- [ ] **Step 5: Fix the six call sites**

`src/server/dispatch.ts:98`:

```ts
    const parsed = parseClientMessage(raw, { maxNickname: config.maxNicknameLength, maxChat: config.maxChatLength });
```

`src/server/__tests__/protocol.test.ts` — the three existing `parseClientMessage(…, MAX_NICKNAME)` calls at lines 316, 325 and 337 become `parseClientMessage(…, LIMITS)`.

`src/client/content/nickname.test.ts` — the two calls at lines 72 and 104 become `{ maxNickname: MAX_NICKNAME_LENGTH, maxChat: 255 }`.

- [ ] **Step 6: Run the tests and the type check**

Run: `bun test src/server/__tests__/protocol.test.ts && bunx vitest run src/client/content/nickname.test.ts && bunx tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
but commit -b in-match-chat -m 'feat(chat): put chat on the wire

SEND_CHAT in; CHAT_SAID and CHAT_HISTORY out. Two outbound types rather than
one array, so a match with exactly one message cannot produce a history frame
indistinguishable from a live broadcast.

parseClientMessage takes a named limits object: two bare positional numbers
get swapped eventually, and there were only six call sites.'
```

---

## Task 2: Client-side validation and copy

**Files:**
- Create: `src/client/content/chat.ts`
- Create: `src/client/content/chat.test.ts`
- Modify: `src/client/__tests__/purity.test.ts:70`

**Interfaces:**
- Consumes: `TransportConfig.maxChatLength` (Task 1), `ChatEntry`, `ChatNoteCode` (Task 1).
- Produces: `MAX_CHAT_LENGTH`, `ChatProblem`, `ChatResult`, `validateChatText(raw: string): ChatResult`, `chatProblemMessage(problem: ChatProblem): string`, `chatNoteMessage(code: ChatNoteCode): string`, `chatSenderLabel(entry: ChatEntry & { kind: 'said' }): string`, `CHAT_PLACEHOLDER`, `CHAT_EMPTY_STATE`, `CHAT_PANEL_TITLE`, `chatLauncherLabel(unread: number): string`.

- [ ] **Step 1: Write the failing test**

Create `src/client/content/chat.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseClientMessage } from '../../server/protocol';
import {
    MAX_CHAT_LENGTH,
    chatLauncherLabel,
    chatNoteMessage,
    chatProblemMessage,
    chatSenderLabel,
    validateChatText
} from './chat';

/** The same candidate through both halves, so agreement is proven rather than asserted. */
function serverAccepts(text: string): boolean {
    return parseClientMessage(
        JSON.stringify({ type: 'SEND_CHAT', matchId: 'K7QX2', text }),
        { maxNickname: 24, maxChat: MAX_CHAT_LENGTH }
    ).ok;
}

describe('validateChatText', () => {
    const CANDIDATES: readonly string[] = [
        'hello',
        '  padded  ',
        '',
        '    ',
        'a'.repeat(MAX_CHAT_LENGTH),
        'a'.repeat(MAX_CHAT_LENGTH + 1),
        'one\ntwo',
        'del',
        'em — dash',
        'emoji \u{1F600}',
        '!@#$%^&*()_+-=[]{}|;:\'",.<>/?`~'
    ];

    it.each(CANDIDATES)('agrees with the server about %j', candidate => {
        expect(validateChatText(candidate).ok).toBe(serverAccepts(candidate));
    });

    it('returns the trimmed value', () => {
        const result = validateChatText('  hi  ');
        expect(result.ok && result.value).toBe('hi');
    });

    it('names why it refused', () => {
        expect(validateChatText('').ok === false && validateChatText('').problem).toBe('empty');
        expect(validateChatText('a'.repeat(MAX_CHAT_LENGTH + 1)).problem).toBe('too-long');
        expect(validateChatText('hi \u{1F600}').problem).toBe('unsupported-char');
    });
});

describe('copy', () => {
    it('interpolates the limit rather than writing it out', () => {
        expect(chatProblemMessage('too-long')).toContain(String(MAX_CHAT_LENGTH));
    });

    it('has a sentence for every note code', () => {
        expect(chatNoteMessage('RESTARTED')).not.toBe('');
        expect(chatNoteMessage('TRIMMED')).not.toBe('');
    });

    it('falls back to a seat label when a speaker has no nickname', () => {
        expect(chatSenderLabel({ kind: 'said', seq: 1, sentAt: 0, from: 'p1', nickname: null, text: 'hi' })).toBe('Seat 1');
        expect(chatSenderLabel({ kind: 'said', seq: 1, sentAt: 0, from: 'p3', nickname: 'Ana', text: 'hi' })).toBe('Ana');
    });

    it('counts unread in the launcher name, and says none when there are none', () => {
        expect(chatLauncherLabel(0)).toBe('Chat');
        expect(chatLauncherLabel(1)).toBe('Chat, 1 unread message');
        expect(chatLauncherLabel(4)).toBe('Chat, 4 unread messages');
    });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bunx vitest run src/client/content/chat.test.ts`
Expected: FAIL — `Cannot find module './chat'`.

- [ ] **Step 3: Write the module**

Create `src/client/content/chat.ts`:

```ts
/**
 * Chat validation and every string a player reads in the transcript.
 *
 * Shaped after `content/nickname.ts` for the same reason it exists: the server
 * refuses a bad message by failing the whole frame, so a client that did not
 * check first would spend a `MALFORMED` to learn what it could have known in
 * the field. This is the client's single source for the rule — the surface and
 * the store both come here.
 */

import { DEFAULT_CONFIG } from '../../server/config';
import type { ChatEntry, ChatNoteCode } from '../../server/protocol';

/**
 * The server's own limit, imported rather than retyped.
 *
 * The second deliberate exception to "types only, never server runtime", and
 * argued exactly as `nickname.ts`'s is: `config.ts` has zero imports and
 * touches neither Bun nor `process`, so it is a plain literal that bundles to a
 * few bytes — and the alternative is a second number that drifts into the
 * client sending precisely what the server refuses.
 */
export const MAX_CHAT_LENGTH = DEFAULT_CONFIG.maxChatLength;

export type ChatProblem = 'empty' | 'too-long' | 'unsupported-char';

export type ChatResult = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly problem: ChatProblem };

/** Printable ASCII, mirroring `protocol.ts`'s `parseChatText` bound for bound. */
const PRINTABLE_MIN = 0x20;
const PRINTABLE_MAX = 0x7e;

function isPrintableAscii(value: string): boolean {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code < PRINTABLE_MIN || code > PRINTABLE_MAX) return false;
    }
    return true;
}

/** Trim, then the same three refusals the server makes, in the same order. */
export function validateChatText(raw: string): ChatResult {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return { ok: false, problem: 'empty' };
    if (trimmed.length > MAX_CHAT_LENGTH) return { ok: false, problem: 'too-long' };
    if (!isPrintableAscii(trimmed)) return { ok: false, problem: 'unsupported-char' };
    return { ok: true, value: trimmed };
}

const PROBLEMS: Readonly<Record<ChatProblem, string>> = {
    empty: 'Type something first.',
    // Interpolated, never written out: the number is the server's and it moves.
    'too-long': `Keep it to ${MAX_CHAT_LENGTH} characters or fewer.`,
    'unsupported-char': 'Plain letters, numbers and symbols only — no emoji or accents.'
};

/** Guidance for the composer, phrased as what to do rather than what went wrong. */
export function chatProblemMessage(problem: ChatProblem): string {
    return PROBLEMS[problem];
}

const NOTES: Readonly<Record<ChatNoteCode, string>> = {
    // States the restart, not the loss: a rebuilt room cannot know whether
    // there was anything to lose, and claiming otherwise would be a guess.
    RESTARTED: 'The court restarted. Anything said before this point is gone.',
    TRIMMED: 'Older messages were dropped to keep this conversation a manageable size.'
};

export function chatNoteMessage(code: ChatNoteCode): string {
    return NOTES[code];
}

/**
 * Who said it.
 *
 * The nickname travels on the entry, so this never consults the live seat
 * table — the whole point being that the live table may since have handed that
 * seat to somebody else. `null` still has to render as something, because the
 * host seat is minted with no name at all.
 */
export function chatSenderLabel(entry: ChatEntry & { readonly kind: 'said' }): string {
    if (entry.nickname !== null) return entry.nickname;
    return `Seat ${Number(entry.from.slice(1))}`;
}

export const CHAT_PANEL_TITLE = 'Table talk';
export const CHAT_PLACEHOLDER = 'Say something';
export const CHAT_EMPTY_STATE = 'Nothing said yet.';

/**
 * The launcher's accessible name, carrying the count in words.
 *
 * The badge is a number in a circle, which a screen reader announces as a bare
 * digit beside a button called "Chat" — two facts a sighted player reads as one.
 * Saying it in the name is what makes them one fact for everybody.
 */
export function chatLauncherLabel(unread: number): string {
    if (unread === 0) return 'Chat';
    return `Chat, ${unread} unread message${unread === 1 ? '' : 's'}`;
}
```

- [ ] **Step 4: Add the purity exception**

In `src/client/__tests__/purity.test.ts`, replace the `ALLOWED` line (line 70) and extend the comment above it:

```ts
        // `content/chat.ts` is the second, on the identical argument: the chat
        // length limit is the server's rule, and a client holding its own copy
        // sends exactly what the server refuses.
        const ALLOWED = new Set(['src/client/content/nickname.ts', 'src/client/content/chat.ts']);
```

- [ ] **Step 5: Run the tests**

Run: `bunx vitest run src/client/content/chat.test.ts src/client/__tests__/purity.test.ts`
Expected: PASS. If purity fails with "imports server runtime", the `ALLOWED` edit did not land.

- [ ] **Step 6: Commit**

```bash
but commit -b in-match-chat -m 'feat(chat): validate a message where the player can see it

content/chat.ts mirrors content/nickname.ts: trim, empty, too long, outside
printable ASCII — the same four answers in the same order the server gives, and
proven against parseClientMessage with a shared candidate list rather than
restated.

It imports the limit from server/config.ts, which makes it the second entry in
purity.test.ts ALLOWED set, on the same argument nickname.ts already carries.'
```

---

## Task 3: The transcript on the Room

**Files:**
- Modify: `src/server/room.ts` — new private fields, `sendChat`, `appendChat`, `Room.rebuild`
- Test: `src/server/__tests__/chat.test.ts` (create)

**Interfaces:**
- Consumes: `ChatEntry`, `ChatNoteCode`, `ServerMessage` (Task 1); `TransportConfig.chatLogMaxBytes` (Task 1).
- Produces: `Room.sendChat(conn: SeatConnection, text: string): void`; the private `chatLog`/`chatBytes`/`chatSeq` fields; a `CHAT_HISTORY` builder used by Task 4.

**Reading first.** Open `src/server/room.ts` and find: the private field block near `private phase: MatchPhase` (~line 257), the `Room.rebuild` static (~line 378), `private broadcast` (~line 1271), and `private send` (~line 1256). Chat adds one field group, one public method, two private helpers.

- [ ] **Step 1: Write the failing test**

Create `src/server/__tests__/chat.test.ts`. Copy `RecordingConn` and `makeConnectedLobby` from `room.test.ts:27-87` — this repo's test files each carry their own harness rather than sharing one, and following that is cheaper than extracting a fixture nothing else asks for.

```ts
import { describe, expect, it } from 'bun:test';
import { makeConfig } from '../config';
import type { TransportConfig } from '../config';
import { MatchStore } from '../persistence';
import type { ChatEntry, ServerMessage } from '../protocol';
import { Room } from '../room';
import type { RoomDeps, SeatConnection } from '../room';

class RecordingConn implements SeatConnection {
    sent: ServerMessage[] = [];
    closed = false;
    send(json: string): void {
        this.sent.push(JSON.parse(json));
    }
    close(): void {
        this.closed = true;
    }
}

function makeConnectedLobby(
    seatCount: 2 | 3 | 4,
    deps: RoomDeps = {},
    configOverrides: Partial<TransportConfig> = {}
): { room: Room; store: MatchStore; config: TransportConfig; conns: RecordingConn[]; tokens: string[] } {
    const config = makeConfig({ dbPath: ':memory:', ...configOverrides });
    const store = new MatchStore(':memory:');
    const { room, hostSeatToken } = Room.create(config, store, deps);

    const conns: RecordingConn[] = [];
    const tokens: string[] = [hostSeatToken];

    const hostConn = new RecordingConn();
    room.resumeSeat(hostConn, hostSeatToken, 'Host');
    conns.push(hostConn);

    for (let i = 1; i < seatCount; i++) {
        const conn = new RecordingConn();
        room.claimSeat(conn, `Player${i}`);
        const claimed = conn.sent.find(m => m.type === 'SEAT_CLAIMED') as Extract<ServerMessage, { type: 'SEAT_CLAIMED' }>;
        tokens.push(claimed.seatToken);
        conns.push(conn);
    }

    return { room, store, config, conns, tokens };
}

function saidTo(conn: RecordingConn): Extract<ServerMessage, { type: 'CHAT_SAID' }>[] {
    return conn.sent.filter((m): m is Extract<ServerMessage, { type: 'CHAT_SAID' }> => m.type === 'CHAT_SAID');
}

function historyTo(conn: RecordingConn): Extract<ServerMessage, { type: 'CHAT_HISTORY' }>[] {
    return conn.sent.filter((m): m is Extract<ServerMessage, { type: 'CHAT_HISTORY' }> => m.type === 'CHAT_HISTORY');
}

describe('Room.sendChat', () => {
    it('broadcasts to every connected seat, the speaker included', () => {
        const { room, conns } = makeConnectedLobby(3);
        room.sendChat(conns[1], 'hello');

        for (const conn of conns) {
            const said = saidTo(conn);
            expect(said).toHaveLength(1);
            expect(said[0].entry).toMatchObject({ kind: 'said', from: 'p2', nickname: 'Player1', text: 'hello' });
        }
    });

    it('numbers entries from 1, monotonically', () => {
        const { room, conns } = makeConnectedLobby(2);
        room.sendChat(conns[0], 'one');
        room.sendChat(conns[1], 'two');

        const seqs = saidTo(conns[0]).map(m => m.entry.seq);
        expect(seqs).toEqual([1, 2]);
    });

    it('refuses once the match has ended, and says why', () => {
        const { room, conns } = makeConnectedLobby(2);
        room.endMatch(conns[0]);
        conns[0].sent = [];

        room.sendChat(conns[0], 'gg');

        expect(saidTo(conns[0])).toHaveLength(0);
        expect(conns[0].sent).toContainEqual({ type: 'ERROR', code: 'MATCH_OVER' });
    });

    it('refuses a connection holding no seat', () => {
        const { room } = makeConnectedLobby(2);
        const stranger = new RecordingConn();

        room.sendChat(stranger, 'let me in');

        expect(saidTo(stranger)).toHaveLength(0);
        expect(stranger.sent).toContainEqual({ type: 'ERROR', code: 'NOT_YOUR_SEAT' });
    });

    it('carries the speaker name as it was, after the seat is handed to someone else', () => {
        // The failure this exists to prevent: a reopened seat relabelling the
        // words of whoever held it before.
        let now = 1_000_000;
        const { room, conns, config } = makeConnectedLobby(2, { now: () => now });
        room.sendChat(conns[1], 'brb');

        // Player1 drops, and the lobby reaper reopens the seat past its grace.
        room.handleClose(conns[1]);
        now += config.lobbyDisconnectGraceMs + 1;
        room.sweep();

        const replacement = new RecordingConn();
        room.claimSeat(replacement, 'Somebody Else');

        const history = historyTo(replacement);
        expect(history).toHaveLength(1);
        expect(history[0].entries).toEqual([
            expect.objectContaining({ kind: 'said', from: 'p2', nickname: 'Player1', text: 'brb' })
        ]);
    });
});

describe('the byte cap', () => {
    /** Small enough that a handful of ordinary messages overruns it. */
    const TINY = 400;

    it('evicts the oldest entries and leads the log with one TRIMMED note', () => {
        const { room, conns } = makeConnectedLobby(2, {}, { chatLogMaxBytes: TINY });
        for (let i = 0; i < 12; i++) room.sendChat(conns[0], `message number ${i}`);

        const joiner = new RecordingConn();
        room.claimSeat(joiner, 'Late');
        const entries = historyTo(joiner)[0].entries;

        expect(entries[0]).toMatchObject({ kind: 'note', code: 'TRIMMED' });
        expect(entries.filter(e => e.kind === 'note')).toHaveLength(1);
        // The newest survived and the oldest did not.
        const texts = entries.filter((e): e is ChatEntry & { kind: 'said' } => e.kind === 'said').map(e => e.text);
        expect(texts).toContain('message number 11');
        expect(texts).not.toContain('message number 0');
    });

    it('keeps the serialized history inside the cap', () => {
        const { room, conns } = makeConnectedLobby(2, {}, { chatLogMaxBytes: TINY });
        for (let i = 0; i < 40; i++) room.sendChat(conns[0], 'x'.repeat(60));

        const joiner = new RecordingConn();
        room.claimSeat(joiner, 'Late');
        const entries = historyTo(joiner)[0].entries;

        const bytes = entries.reduce((total, entry) => total + JSON.stringify(entry).length, 0);
        expect(bytes).toBeLessThanOrEqual(TINY);
    });
});

describe('history delivery', () => {
    it('reaches a seat on its SECOND reconnect, not only its first', () => {
        // The trap this exists for: `resumeSeat`'s nickname adoption right
        // above the history send is gated one-time-only, and copying that guard
        // would silently stop re-delivering the transcript.
        const { room, conns, tokens } = makeConnectedLobby(2);
        room.sendChat(conns[0], 'said once');

        for (const attempt of [1, 2]) {
            room.handleClose(conns[1]);
            const returning = new RecordingConn();
            room.resumeSeat(returning, tokens[1]);

            expect(historyTo(returning), `resume ${attempt}`).toHaveLength(1);
            expect(historyTo(returning)[0].entries).toHaveLength(1);
            conns[1] = returning;
        }
    });

    it('reaches a seat claimed after the conversation started', () => {
        const { room, conns } = makeConnectedLobby(2);
        room.sendChat(conns[0], 'before you arrived');

        const joiner = new RecordingConn();
        room.claimSeat(joiner, 'Third');

        expect(historyTo(joiner)[0].entries).toEqual([
            expect.objectContaining({ text: 'before you arrived' })
        ]);
    });
});

describe('a rebuilt room', () => {
    it('opens with a RESTARTED note, because the transcript did not survive', () => {
        const { room, store, config, tokens } = makeConnectedLobby(2);
        room.sendChat(new RecordingConn(), 'never mind');

        const record = store.load(room.matchId);
        if (record === null) throw new Error('the room was not persisted');
        const rebuilt = Room.rebuild(config, store, record, {});

        const conn = new RecordingConn();
        rebuilt.resumeSeat(conn, tokens[0]);

        expect(historyTo(conn)[0].entries).toEqual([
            expect.objectContaining({ kind: 'note', code: 'RESTARTED' })
        ]);
    });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/server/__tests__/chat.test.ts`
Expected: FAIL — `room.sendChat is not a function`. The history assertions also fail; Task 4 delivers history, and these two tasks are verified together at the end of Task 4.

- [ ] **Step 3: Add the fields**

In `src/server/room.ts`, beside the other private fields:

```ts
    /**
     * The match transcript, in memory and nowhere else.
     *
     * Deliberately in the same category as `revealTimer` and `advancing`:
     * transport-only state that a rebuild does not restore. Nothing here
     * reaches `MatchRecord`, the sqlite schema, or the `actionLog` — a chat
     * message is not a game action and replaying one would mean nothing.
     *
     * A restart therefore wipes it, and that is documented behaviour rather
     * than a gap: `dev:server` runs under `bun --watch`, so during development
     * this happens every time an engine file is saved. `Room.rebuild` seeds a
     * RESTARTED note so the loss explains itself.
     */
    private chatLog: ChatEntry[] = [];
    /** Running total of `JSON.stringify(entry).length` across `chatLog`, kept so eviction never re-serializes. */
    private chatBytes = 0;
    /** Monotonic within a room; the client's stable list key and the basis of its unread count. */
    private chatSeq = 0;
```

Add `ChatEntry` to the existing `import type { … } from './protocol'` line.

- [ ] **Step 4: Add append-with-eviction**

```ts
    /**
     * Appends one entry and evicts from the front until the log fits.
     *
     * Enforced on append rather than when a history frame is built: trimming
     * lazily would leave `chatLog` growing without bound between reads and make
     * the cap cosmetic. Each entry's size is measured once, here, and carried
     * beside it — the number that matters is what a `CHAT_HISTORY` frame costs,
     * and `perMessageDeflate` is off, so it is also what crosses the wire.
     *
     * At most one TRIMMED note ever leads the log. Without it a transcript that
     * begins partway through is indistinguishable from a short one.
     */
    private appendChat(entry: ChatEntry): void {
        this.pushChat(entry);
        if (this.chatBytes <= this.config.chatLogMaxBytes) return;

        // Drop the existing note first, so it is re-added at the front rather
        // than one accumulating per eviction round.
        const head = this.chatLog[0];
        if (head !== undefined && head.kind === 'note' && head.code === 'TRIMMED') this.dropOldestChat();

        const note: ChatEntry = { seq: ++this.chatSeq, sentAt: this.deps.now(), kind: 'note', code: 'TRIMMED' };
        const noteBytes = JSON.stringify(note).length;

        // `> 1`, not `> 0`: an entry larger than the whole cap would otherwise
        // evict itself, and losing the message somebody just sent is a worse
        // answer than briefly exceeding a bound that exists as insurance.
        while (this.chatLog.length > 1 && this.chatBytes + noteBytes > this.config.chatLogMaxBytes) {
            this.dropOldestChat();
        }

        this.chatLog.unshift(note);
        this.chatSizes.set(note.seq, noteBytes);
        this.chatBytes += noteBytes;
    }

    /** Append and account for one entry. The only place `chatBytes` grows. */
    private pushChat(entry: ChatEntry): void {
        const size = JSON.stringify(entry).length;
        this.chatLog.push(entry);
        this.chatSizes.set(entry.seq, size);
        this.chatBytes += size;
    }

    private dropOldestChat(): void {
        const dropped = this.chatLog.shift();
        if (dropped === undefined) return;
        this.chatBytes -= this.chatSizes.get(dropped.seq) ?? 0;
        this.chatSizes.delete(dropped.seq);
    }
```

and add the companion field beside `chatSeq`:

```ts
    /** Each live entry's serialized size, keyed by seq, so eviction never re-serializes. */
    private readonly chatSizes = new Map<number, number>();
```

- [ ] **Step 5: Add `sendChat`**

Place it beside `playCard`, and note it takes the *already validated* text — the parse boundary owns the rule, exactly as it does for a nickname.

```ts
    /**
     * Appends one line to the transcript and broadcasts it.
     *
     * `text` has already passed `parseChatText`, so this re-derives no rule
     * about what a message may contain. What it does own is who may speak:
     * the seat is looked up from the connection rather than trusted from a
     * payload — the same conn-keyed lookup `playCard` uses, and the reason
     * `SEND_CHAT` carries no `playerId`.
     *
     * `broadcast`, not `pushStateToConnectedSeats`: chat holds no hidden state,
     * so there is nothing to redact and every seat receives identical bytes.
     */
    sendChat(conn: SeatConnection, text: string): void {
        if (this.phase === 'ended') {
            this.sendError(conn, 'MATCH_OVER');
            return;
        }

        const seat = this.seats.find(s => s.conn === conn);
        if (!seat) {
            this.sendError(conn, 'NOT_YOUR_SEAT');
            return;
        }

        const entry: ChatEntry = {
            seq: ++this.chatSeq,
            sentAt: this.deps.now(),
            kind: 'said',
            from: seat.playerId,
            // Denormalized on purpose — see the comment on `ChatEntry`.
            nickname: seat.nickname,
            text
        };

        this.appendChat(entry);
        this.broadcast({ type: 'CHAT_SAID', matchId: this.matchId, entry });
        // No persist: nothing about a chat message belongs in `MatchRecord`.
    }
```

- [ ] **Step 6: Seed the note on rebuild**

In `Room.rebuild`, after each `new Room(...)` is constructed and before it is returned, call a shared helper. The static has three return points (`lobby`, `active`, `ended`), so route them through one:

```ts
    /**
     * A rebuilt room has no transcript, and cannot know whether it had one.
     *
     * So the note states the restart rather than the loss. `Room.rebuild` runs
     * only on a genuine cold miss of the registry's map — live rooms are never
     * evicted except on deletion — which in practice means the process was
     * restarted.
     */
    private static withRestartNote(room: Room): Room {
        room.pushChat({ seq: ++room.chatSeq, sentAt: room.deps.now(), kind: 'note', code: 'RESTARTED' });
        return room;
    }
```

and wrap each of the three returns: `return Room.withRestartNote(new Room(...));`

- [ ] **Step 7: Run the tests**

Run: `bun test src/server/__tests__/chat.test.ts`
Expected: the three `Room.sendChat` broadcast/seq/refusal tests PASS. The history-dependent tests still FAIL — Task 4 supplies them.

- [ ] **Step 8: Commit**

```bash
but commit -b in-match-chat -m 'feat(chat): hold the transcript on the live room

An in-memory array beside revealTimer and advancing, never in MatchRecord and
never in the actionLog. Eviction runs on append against a running byte total,
so the cap bounds memory rather than only bounding a frame, and one TRIMMED
note leads a log that starts partway through.

The speaker name is copied onto the entry. The lobby reaper clears a
disconnected seat name and the next arrival claims the same p2, so resolving a
name at render time would put one persons words in anothers mouth.'
```

---

## Task 4: Delivering the history

**Files:**
- Modify: `src/server/room.ts` — `claimSeat`, `resumeSeat`
- Test: `src/server/__tests__/chat.test.ts` (the tests written in Task 3)

**Interfaces:**
- Consumes: `chatLog` (Task 3).
- Produces: a `CHAT_HISTORY` unicast on every successful `claimSeat` and every successful `resumeSeat`.

**The trap.** `resumeSeat` contains a one-time-only nickname adoption gated on `seat.nickname === null && this.phase === 'lobby'`. History delivery has **no such gate** — it must fire on every successful resume, including the fifth. Copy the *placement* of that block, never its condition.

- [ ] **Step 1: Add the builder**

In `src/server/room.ts`, beside `buildLobbyUpdate`:

```ts
    private buildChatHistory(): ServerMessage {
        // A copy, not the live array: the message is serialized immediately by
        // `send`, but handing out the field would let a future caller hold a
        // reference that eviction mutates underneath them.
        return { type: 'CHAT_HISTORY', matchId: this.matchId, entries: [...this.chatLog] };
    }
```

- [ ] **Step 2: Send it on claim**

In `claimSeat`, after the `SEAT_CLAIMED` unicast and before `this.broadcastLobbyUpdate()`:

```ts
        // After SEAT_CLAIMED so the seat exists before anything is attributed
        // to it, and before the lobby broadcast so the arriving player has the
        // conversation in hand by the time they are shown the table of seats.
        this.send(conn, this.buildChatHistory());
```

- [ ] **Step 3: Send it on resume**

In `resumeSeat`, immediately after `seat.conn = conn; seat.disconnectedAt = null;` and **before** the `if (this.phase === 'lobby')` early return — so both the lobby path and the active path get it, once each:

```ts
        // Every resume, not merely the first. The nickname adoption above is
        // one-time by design; this is not, and copying its guard would silently
        // stop re-delivering the transcript on a second reconnect.
        this.send(conn, this.buildChatHistory());
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/server/__tests__/chat.test.ts`
Expected: PASS, all of them, including the attribution test and both byte-cap tests.

- [ ] **Step 5: Prove nothing else regressed**

Run: `bun run test:server`
Expected: PASS. `reconnect.test.ts` and `integration.test.ts` assert on message sequences; if either fails because an extra frame now appears, the fix is to make that test tolerant of `CHAT_HISTORY`, never to move the send.

- [ ] **Step 6: Commit**

```bash
but commit -b in-match-chat -m 'feat(chat): hand the whole transcript to whoever arrives

One CHAT_HISTORY unicast on seat claim and on every resume. Nobody can claim a
seat once a match is active, so a genuinely new arrival is always a lobby
arrival and the mid-match case is a reconnect — one mechanism serves both.

Placed like resumeSeat one-time nickname adoption and deliberately unlike it:
that block is gated on the name being absent, and copying the gate would stop
re-delivering the transcript on a second reconnect.'
```

---

## Task 5: Routing and the chat bucket

**Files:**
- Modify: `src/server/dispatch.ts:61-70`, `:73-81`, `:105-115`, `:156-194`
- Modify: `src/server/index.ts:100-108`
- Test: `src/server/__tests__/dispatch.test.ts`

**Interfaces:**
- Consumes: `Room.sendChat` (Task 3); `TransportConfig.chatBurst | chatRefillPerSec` (Task 1).
- Produces: `ConnectionState.chatBucket: TokenBucket`; `SEND_CHAT` reaching `Room.sendChat`.

**The point of the second bucket.** `dispatch.ts:105-109` spends from `state.bucket` **unconditionally, before any branch on type** — its own comment says *every message type spends a token, PING included*. A chat check bolted on after that leaves chat still drawing down the shared pool of 10, so a player typing quickly rate-limits their own next `PLAY_CARD`. `SEND_CHAT` must therefore spend from its own bucket **instead of**, not in addition to, the shared one.

- [ ] **Step 1: Write the failing tests**

Append to `src/server/__tests__/dispatch.test.ts`, following that file's existing harness for building a `ConnectionState` and a registry.

The file already has everything needed: `freshRegistry(deps)` returns `{ registry, store, config }`, `makeState(overrides)` builds a `ConnectionState` with a generous bucket, and `RecordingConn` records `ServerMessage`s. Add one local helper for a connection that actually holds a seat, then the four cases.

```ts
/** A registry, a room, and a ConnectionState already bound to the host seat. */
async function seated(): Promise<{
    registry: RoomRegistry;
    config: ReturnType<typeof makeConfig>;
    state: ConnectionState;
    matchId: string;
}> {
    const { registry, config } = freshRegistry();
    const created = registry.createRoom();
    const state = makeState({ conn: new RecordingConn() });

    // Bound through the real pipeline, so `state.seat`/`state.matchId` are set
    // by the one function allowed to set them.
    await dispatchMessage(
        registry,
        config,
        state,
        JSON.stringify({ type: 'RESUME_SEAT', matchId: created.matchId, seatToken: created.hostSeatToken, nickname: 'Host' })
    );

    return { registry, config, state, matchId: created.matchId };
}

describe('dispatchMessage — SEND_CHAT', () => {
    it('reaches the room', async () => {
        const { registry, config, state, matchId } = await seated();
        await dispatchMessage(registry, config, state, JSON.stringify({ type: 'SEND_CHAT', matchId, text: 'hi' }));

        expect((state.conn as RecordingConn).sent.filter(m => m.type === 'CHAT_SAID')).toHaveLength(1);
    });

    it('is refused from a connection with no bound seat', async () => {
        const { registry, config } = freshRegistry();
        const created = registry.createRoom();
        const stranger = makeState(); // seat: null

        await dispatchMessage(
            registry,
            config,
            stranger,
            JSON.stringify({ type: 'SEND_CHAT', matchId: created.matchId, text: 'let me in' })
        );

        expect((stranger.conn as RecordingConn).sent).toEqual([{ type: 'ERROR', code: 'NOT_YOUR_SEAT' }]);
    });

    it('does not spend the shared bucket, so a burst of chat cannot block a play', async () => {
        const { registry, config, state, matchId } = await seated();
        // A shared bucket small enough that any chat spend would empty it, and
        // a chat bucket large enough not to be the thing that refuses.
        const tight = makeState({
            conn: state.conn,
            seat: state.seat,
            matchId: state.matchId,
            bucket: new TokenBucket(3, 0, () => 1_000_000),
            chatBucket: new TokenBucket(1000, 1000, () => 1_000_000)
        });
        const chat = JSON.stringify({ type: 'SEND_CHAT', matchId, text: 'hi' });

        for (let i = 0; i < 10; i++) await dispatchMessage(registry, config, tight, chat);

        (tight.conn as RecordingConn).sent = [];
        await dispatchMessage(registry, config, tight, JSON.stringify({ type: 'PING' }));

        // PING draws on the shared bucket, which still has all three tokens.
        // If chat had been spending it too, this would be RATE_LIMITED.
        expect(last((tight.conn as RecordingConn).sent)).toEqual({ type: 'PONG' });
    });

    it('is itself rate limited once its own bucket empties', async () => {
        const { registry, config, state, matchId } = await seated();
        // Fixed clock, for the reason the existing step-4 test states: a real
        // one refills between two awaited calls and the refusal goes flaky.
        const limited = makeState({
            conn: state.conn,
            seat: state.seat,
            matchId: state.matchId,
            chatBucket: new TokenBucket(1, 1000, () => 1_000_000)
        });
        const chat = JSON.stringify({ type: 'SEND_CHAT', matchId, text: 'hi' });

        await dispatchMessage(registry, config, limited, chat);
        await dispatchMessage(registry, config, limited, chat);

        expect(last((limited.conn as RecordingConn).sent)).toEqual({ type: 'ERROR', code: 'RATE_LIMITED' });
    });
});
```

`makeState` must also gain the new field in its defaults, or every existing test in the file fails to type-check:

```ts
        bucket: new TokenBucket(1000, 1000),
        chatBucket: new TokenBucket(1000, 1000),
```

- [ ] **Step 2: Run and watch fail**

Run: `bun test src/server/__tests__/dispatch.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the bucket to the connection**

In `src/server/dispatch.ts`, in `ConnectionState`:

```ts
    /**
     * Chat's own allowance, spent INSTEAD of `bucket` rather than beside it.
     *
     * The shared bucket is spent before any branch on type, so chat drawing
     * from it too would let a player typing quickly rate-limit their own next
     * PLAY_CARD. This one is strictly tighter than the shared bucket, so
     * routing around it loosens nothing.
     */
    readonly chatBucket: TokenBucket;
```

In `src/server/index.ts`, in the `const data: ConnectionState = { … }` literal:

```ts
                    chatBucket: new TokenBucket(config.chatBurst, config.chatRefillPerSec),
```

- [ ] **Step 4: Route it**

In `dispatchMessage`, replace the step-4 block so chat takes its own path. The order matters: parse has already happened, so `msg.type` is trustworthy here.

```ts
    // Step 4 — every message type spends a token, PING included. Chat spends
    // from its own bucket instead of the shared one, so a burst of typing can
    // never leave the sender's next PLAY_CARD without an allowance.
    const bucket = msg.type === 'SEND_CHAT' ? state.chatBucket : state.bucket;
    if (!bucket.take()) {
        sendError(state.conn, 'RATE_LIMITED');
        return;
    }
```

Add `'SEND_CHAT'` to `requiresBoundSeat`:

```ts
        type === 'REQUEST_RESYNC' ||
        type === 'SEND_CHAT'
```

Add the room command inside the `switch (msg.type)` in the `room.enqueue` block:

```ts
                case 'SEND_CHAT':
                    room.sendChat(state.conn, msg.text);
                    break;
```

- [ ] **Step 5: Run the tests**

Run: `bun test src/server && bunx tsc --noEmit`
Expected: PASS, no type errors. The whole server transport suite must be green here — this is the last task that touches it.

- [ ] **Step 6: Commit**

```bash
but commit -b in-match-chat -m 'feat(chat): give chat its own rate limit rather than a share of the plays

SEND_CHAT spends from a dedicated bucket instead of the shared one. Dispatch
step 4 spends the shared bucket before any branch on type, so a second check
bolted on afterwards would still let a burst of typing rate-limit the senders
own next PLAY_CARD — which is the failure the bucket exists to prevent.

Burst 5, refill 1/sec: strictly tighter than the shared bucket, so nothing is
loosened by routing around it.'
```

---

## Task 6: The client store

**Files:**
- Modify: `src/client/store/types.ts:74-86`
- Modify: `src/client/store/store.ts:70-87`, `:153-233`, `:235-…`
- Modify: `src/client/store/socket.ts:95-104`
- Test: `src/client/store/store.test.ts`, `src/client/store/socket.test.ts`

**Interfaces:**
- Consumes: `ChatEntry`, `CHAT_SAID`, `CHAT_HISTORY` (Task 1); `validateChatText` (Task 2).
- Produces: `ClientState.chat: readonly ChatEntry[]`; `Store.sendChat(text: string): boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `src/client/store/store.test.ts`, using that file's existing `makeStore`-style setup:

```ts
describe('chat', () => {
    const entry = (seq: number, text: string): ChatEntry => ({
        seq,
        sentAt: 1_000 + seq,
        kind: 'said',
        from: 'p2',
        nickname: 'Ana',
        text
    });

    it('starts empty', () => {
        expect(makeStore().store.getState().chat).toEqual([]);
    });

    it('appends on CHAT_SAID', () => {
        const { store } = makeStore();
        store.apply({ type: 'CHAT_SAID', matchId: 'K7QX2', entry: entry(1, 'one') });
        store.apply({ type: 'CHAT_SAID', matchId: 'K7QX2', entry: entry(2, 'two') });

        expect(store.getState().chat.map(e => e.seq)).toEqual([1, 2]);
    });

    it('replaces wholesale on CHAT_HISTORY, so a reconnect never doubles a line', () => {
        const { store } = makeStore();
        store.apply({ type: 'CHAT_SAID', matchId: 'K7QX2', entry: entry(1, 'one') });
        // The reconnect case: a one-entry history over a client that already
        // holds that entry.
        store.apply({ type: 'CHAT_HISTORY', matchId: 'K7QX2', entries: [entry(1, 'one')] });

        expect(store.getState().chat).toHaveLength(1);
    });

    it('replaces the array rather than mutating it', () => {
        const { store } = makeStore();
        const before = store.getState().chat;
        store.apply({ type: 'CHAT_SAID', matchId: 'K7QX2', entry: entry(1, 'one') });

        expect(store.getState().chat).not.toBe(before);
        expect(before).toEqual([]);
    });

    it('sends a valid message and reports that the frame left', () => {
        const { store, sent } = makeStore();
        expect(store.sendChat('  hello  ')).toBe(true);
        expect(sent).toContainEqual({ type: 'SEND_CHAT', matchId: 'K7QX2', text: 'hello' });
    });

    it('refuses to send what the server would refuse, without spending a frame', () => {
        const { store, sent } = makeStore();
        expect(store.sendChat('   ')).toBe(false);
        expect(store.sendChat('a'.repeat(256))).toBe(false);
        expect(store.sendChat('nope \u{1F600}')).toBe(false);
        expect(sent.filter(m => m.type === 'SEND_CHAT')).toHaveLength(0);
    });
});
```

Append to `src/client/store/socket.test.ts`:

```ts
it('accepts the two chat frame types', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'CHAT_SAID', matchId: 'K7QX2', entry: {} }))).not.toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'CHAT_HISTORY', matchId: 'K7QX2', entries: [] }))).not.toBeNull();
});
```

- [ ] **Step 2: Run and watch fail**

Run: `bunx vitest run src/client/store`
Expected: FAIL.

- [ ] **Step 3: Add the state slice**

In `src/client/store/types.ts`, import `ChatEntry` alongside the existing protocol imports and add to `ClientState`:

```ts
    /**
     * The match transcript, newest last.
     *
     * Held as the server sent it and nothing more: no unread count, no
     * grouping, no formatting. Those are presentation questions, and the
     * surface that asks them is the one that can answer them — the same reason
     * this store derives no game rule.
     */
    readonly chat: readonly ChatEntry[];
```

- [ ] **Step 4: Handle the two frames**

In `src/client/store/store.ts`, add `chat: []` to `initialState`, then two cases to `next(msg)`:

```ts
            case 'CHAT_SAID':
                return { ...state, chat: [...state.chat, msg.entry] };

            // Replaced whole, never merged. The server sends this on claim and
            // on every resume, and it is authoritative by construction — a
            // merge would have to invent a dedupe rule the wire never asked for.
            case 'CHAT_HISTORY':
                return { ...state, chat: msg.entries };
```

and the sender, beside `playCard`:

```ts
        sendChat(text) {
            if (state.matchId === null) return false;

            // Checked here so a message the server would refuse never costs a
            // frame — and, more to the point, never costs the MALFORMED that
            // would follow it.
            const validated = validateChatText(text);
            if (!validated.ok) return false;

            return deps.send({ type: 'SEND_CHAT', matchId: state.matchId, text: validated.value });
        },
```

Add `sendChat(text: string): boolean;` to the `Store` interface with a short doc comment, and import `validateChatText` from `../content/chat`.

- [ ] **Step 5: Add both types to the socket allowlist**

In `src/client/store/socket.ts`, add to `SERVER_MESSAGE_TYPES`:

```ts
    'CHAT_SAID',
    'CHAT_HISTORY',
```

This is a **runtime** allowlist, not a type. Omitting it does not fail a build — frames are dropped silently and chat simply never appears.

- [ ] **Step 6: Run the tests**

Run: `bunx vitest run src/client && bunx tsc --noEmit`
Expected: PASS. If `store.test.ts`'s initial-state assertion fails, add `chat: []` to its expected object.

- [ ] **Step 7: Commit**

```bash
but commit -b in-match-chat -m 'feat(chat): hold the transcript in client state

One immutable slice, appended on CHAT_SAID and replaced whole on CHAT_HISTORY.
The store derives nothing from it — no unread count, no formatting — for the
same reason it derives no game rule.

Both types are added to socket.ts SERVER_MESSAGE_TYPES, which is a runtime
allowlist rather than a type: omitting them fails no build and simply drops
every chat frame on the floor.'
```

---

## Task 7: The chat surface

**Files:**
- Create: `src/client/ui/chatRail.ts`
- Create: `src/client/ui/chatRail.test.ts`

**Interfaces:**
- Consumes: `ClientState.chat` (Task 6); `validateChatText`, `chatProblemMessage`, `chatNoteMessage`, `chatSenderLabel`, `chatLauncherLabel`, `CHAT_PANEL_TITLE`, `CHAT_PLACEHOLDER`, `CHAT_EMPTY_STATE`, `MAX_CHAT_LENGTH` (Task 2); `anchorOf`, `applyAnchor`, `FOLLOWING` (`ui/scrollFollow.ts`, unchanged).
- Produces: `createChatRail(deps: ChatRailDeps): Surface`, `ChatRailDeps`.

**Two rules this surface must obey, and one it must break.** It mounts exactly one element into `#ui-root` (`Surface`'s contract, and `#ui-root > *` is what restores pointer events). It never reads the store. And unlike `referenceDock`, it must **not** rebuild its body on update — the composer holds half-typed text, and a state push arrives on every `STATE_UPDATE`.

- [ ] **Step 1: Write the failing test**

Create `src/client/ui/chatRail.test.ts`:

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEntry } from '../../server/protocol';
import { makeState, makeUiRootElement } from './__fixtures__/dom';
import { createChatRail } from './chatRail';

const said = (seq: number, text: string, nickname: string | null = 'Ana'): ChatEntry => ({
    seq,
    sentAt: 1_000 + seq,
    kind: 'said',
    from: 'p2',
    nickname,
    text
});

function mount(onSend: (text: string) => boolean = () => true, railVisible = () => false) {
    const root = makeUiRootElement();
    const rail = createChatRail({ onSend, railVisible });
    rail.mount(root);
    return { root, rail };
}

const lines = (root: HTMLElement) => [...root.querySelectorAll('[data-role="chat-line"]')].map(el => el.textContent ?? '');
const launcher = (root: HTMLElement) => root.querySelector('[data-action="chat"]') as HTMLButtonElement;
const input = (root: HTMLElement) => root.querySelector('[data-role="chat-input"]') as HTMLInputElement;
const badge = (root: HTMLElement) => root.querySelector('[data-role="chat-badge"]') as HTMLElement;

describe('the transcript', () => {
    it('renders a line per entry, named by its speaker', () => {
        const { root, rail } = mount();
        rail.update(makeState({ screen: 'lobby', chat: [said(1, 'hello'), said(2, 'again')] }));

        expect(lines(root)).toHaveLength(2);
        expect(lines(root)[0]).toContain('Ana');
        expect(lines(root)[0]).toContain('hello');
    });

    it('falls back to a seat label when a speaker has no nickname', () => {
        const { root, rail } = mount();
        rail.update(makeState({ screen: 'lobby', chat: [said(1, 'hi', null)] }));

        expect(lines(root)[0]).toContain('Seat 2');
    });

    it('renders a note as copy rather than as a code', () => {
        const { root, rail } = mount();
        rail.update(makeState({ screen: 'lobby', chat: [{ seq: 1, sentAt: 1, kind: 'note', code: 'RESTARTED' }] }));

        expect(lines(root)[0]).toContain('restarted');
        expect(lines(root)[0]).not.toContain('RESTARTED');
    });

    it('appends rather than rebuilding, so an existing line keeps its element', () => {
        const { root, rail } = mount();
        rail.update(makeState({ screen: 'lobby', chat: [said(1, 'one')] }));
        const first = root.querySelector('[data-role="chat-line"]');

        rail.update(makeState({ screen: 'lobby', chat: [said(1, 'one'), said(2, 'two')] }));

        expect(root.querySelector('[data-role="chat-line"]')).toBe(first);
        expect(lines(root)).toHaveLength(2);
    });

    it('rebuilds when history replaces the slice', () => {
        const { root, rail } = mount();
        rail.update(makeState({ screen: 'lobby', chat: [said(9, 'stale')] }));
        rail.update(makeState({ screen: 'lobby', chat: [said(1, 'fresh')] }));

        expect(lines(root)).toHaveLength(1);
        expect(lines(root)[0]).toContain('fresh');
    });

    it('writes text through textContent, so markup is never parsed', () => {
        const { root, rail } = mount();
        rail.update(makeState({ screen: 'lobby', chat: [said(1, '<b>bold</b>')] }));

        expect(root.querySelector('[data-role="chat-line"] b')).toBeNull();
        expect(lines(root)[0]).toContain('<b>bold</b>');
    });
});

describe('the composer', () => {
    it('survives an update with its text intact', () => {
        const { root, rail } = mount();
        rail.update(makeState({ screen: 'lobby', chat: [] }));
        input(root).value = 'half a th';

        rail.update(makeState({ screen: 'lobby', chat: [said(1, 'someone else')] }));

        expect(input(root).value).toBe('half a th');
    });

    it('sends on submit and clears', () => {
        const onSend = vi.fn(() => true);
        const { root, rail } = mount(onSend);
        rail.update(makeState({ screen: 'lobby', chat: [] }));

        input(root).value = 'hello';
        (root.querySelector('[data-role="chat-form"]') as HTMLFormElement).requestSubmit();

        expect(onSend).toHaveBeenCalledWith('hello');
        expect(input(root).value).toBe('');
    });

    it('keeps the text when the send is refused', () => {
        const { root, rail } = mount(() => false);
        rail.update(makeState({ screen: 'lobby', chat: [] }));

        input(root).value = 'hello';
        (root.querySelector('[data-role="chat-form"]') as HTMLFormElement).requestSubmit();

        expect(input(root).value).toBe('hello');
    });

    it('explains a refusal it can make itself, and sends nothing', () => {
        const onSend = vi.fn(() => true);
        const { root, rail } = mount(onSend);
        rail.update(makeState({ screen: 'lobby', chat: [] }));

        input(root).value = 'nope \u{1F600}';
        (root.querySelector('[data-role="chat-form"]') as HTMLFormElement).requestSubmit();

        expect(onSend).not.toHaveBeenCalled();
        expect((root.querySelector('[data-role="chat-problem"]') as HTMLElement).textContent).toContain('emoji');
    });
});

describe('the badge', () => {
    it('counts what arrived while the panel was shut', () => {
        const { root, rail } = mount();
        rail.update(makeState({ screen: 'table', chat: [said(1, 'one'), said(2, 'two')] }));

        expect(badge(root).textContent).toBe('2');
        expect(launcher(root).getAttribute('aria-label')).toBe('Chat, 2 unread messages');
    });

    it('clears when the player opens the panel, and stays clear', () => {
        const { root, rail } = mount();
        rail.update(makeState({ screen: 'table', chat: [said(1, 'one')] }));
        launcher(root).click();
        rail.update(makeState({ screen: 'table', chat: [said(1, 'one')] }));

        expect(badge(root).hidden).toBe(true);
        expect(launcher(root).getAttribute('aria-label')).toBe('Chat');
    });

    it('never counts while the rail is painted, because it is already being read', () => {
        const { root, rail } = mount(() => true, () => true);
        rail.update(makeState({ screen: 'table', chat: [said(1, 'one'), said(2, 'two')] }));

        expect(badge(root).hidden).toBe(true);
    });

    it('does not count the players own arrival back into an empty match', () => {
        const { root, rail } = mount();
        rail.update(makeState({ screen: 'lobby', chat: [] }));

        expect(badge(root).hidden).toBe(true);
    });
});

describe('presence', () => {
    it('shows nothing on the menu or the join screen', () => {
        const { root, rail } = mount();
        rail.update(makeState({ screen: 'menu', chat: [] }));
        expect(launcher(root)).toBeNull();

        rail.update(makeState({ screen: 'joining', chat: [] }));
        expect(launcher(root)).toBeNull();
    });

    it('appears in the lobby and stays through the table', () => {
        const { root, rail } = mount();
        rail.update(makeState({ screen: 'lobby', chat: [] }));
        expect(launcher(root)).not.toBeNull();

        rail.update(makeState({ screen: 'table', chat: [] }));
        expect(launcher(root)).not.toBeNull();
    });
});
```

`makeState` in `src/client/ui/__fixtures__/dom.ts:81` spreads overrides over a `BASE_STATE` constant. Add `chat: []` to that constant — without it every DOM test in the repo fails to type-check the moment Task 6 lands, which is the correct behaviour and a two-second fix.

- [ ] **Step 2: Run and watch fail**

Run: `bunx vitest run src/client/ui/chatRail.test.ts`
Expected: FAIL — `Cannot find module './chatRail'`.

- [ ] **Step 3: Write the surface**

Create `src/client/ui/chatRail.ts`:

```ts
/**
 * Table talk: one public transcript, and the box to add to it.
 *
 * **It is not a fourth tab in the reference dock**, though it looks like one
 * should be. The dock removes itself from the document on every screen that is
 * not the table, and chat is wanted from the lobby onward; and its `render()`
 * calls `panel.replaceChildren(...)` on every state push, which during a match
 * is every `STATE_UPDATE` — so a composer living inside it would be destroyed,
 * with whatever was half-typed in it, each time a bot played a card.
 *
 * What it does take from the dock is its shape: a labelled `region` rather than
 * a `dialog`, Escape bound to the panel rather than the document, and focus
 * left alone on open. A panel that grabs focus interrupts the game.
 *
 * The transcript **appends**. Only a `CHAT_HISTORY` replacement rebuilds it,
 * detected by the first entry's `seq` moving — which is exactly when the server
 * has replaced the slice rather than added to it.
 *
 * Whether the rail is painted or collapsed to its launcher is decided entirely
 * by a media query in `ui.css`. Nothing here asks: `railVisible` is injected by
 * `main.ts`, which reads the computed value of `--chat-rail-w` rather than
 * re-testing the query, so the breakpoint exists in exactly one place.
 */

import {
    CHAT_EMPTY_STATE,
    CHAT_PANEL_TITLE,
    CHAT_PLACEHOLDER,
    MAX_CHAT_LENGTH,
    chatLauncherLabel,
    chatNoteMessage,
    chatProblemMessage,
    chatSenderLabel,
    validateChatText
} from '../content/chat';
import type { ChatEntry } from '../../server/protocol';
import type { ClientState } from '../store/types';
import { FOLLOWING, anchorOf, applyAnchor } from './scrollFollow';
import type { Surface } from './surface';

export interface ChatRailDeps {
    /** True when the frame actually left. A refusal keeps the text in the box. */
    readonly onSend: (text: string) => boolean;
    /**
     * Whether the rail is currently painted rather than collapsed.
     *
     * Injected rather than measured here, for the same reason `beats.ts` takes
     * `reducedMotion` injected: a surface may not reach an ambient global, and
     * the answer changes with the viewport so it must be read, never cached.
     */
    readonly railVisible: () => boolean;
}

const TITLE_ID = 'chat-rail-title';

/** The screens chat exists on. Not the menu, and not the nickname prompt: you speak with a seat's name. */
function wanted(screen: ClientState['screen']): boolean {
    return screen === 'lobby' || screen === 'table';
}

export function createChatRail(deps: ChatRailDeps): Surface {
    const container = document.createElement('div');
    container.dataset.role = 'chat-rail-host';

    const launcher = document.createElement('button');
    launcher.type = 'button';
    launcher.dataset.action = 'chat';
    launcher.className = 'chat-launcher';
    launcher.setAttribute('aria-expanded', 'false');

    const launcherText = document.createElement('span');
    launcherText.textContent = 'Chat';

    const badge = document.createElement('span');
    badge.dataset.role = 'chat-badge';
    badge.className = 'chat-badge';
    // The count is already in the button's accessible name, so the glyph itself
    // is decoration — announced twice otherwise, once as a name and once as a
    // stray digit.
    badge.setAttribute('aria-hidden', 'true');
    badge.hidden = true;
    launcher.append(launcherText, badge);

    const panel = document.createElement('section');
    panel.dataset.role = 'chat-rail';
    panel.className = 'chat-rail';
    // A region, not a dialog: it sits beside the game rather than in front of
    // it, and a screen reader announcing a dialog would tell the player their
    // turn had been interrupted.
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-labelledby', TITLE_ID);

    const title = document.createElement('h2');
    title.id = TITLE_ID;
    title.textContent = CHAT_PANEL_TITLE;

    const transcript = document.createElement('ol');
    transcript.dataset.role = 'chat-transcript';
    transcript.className = 'chat-transcript';
    // The transcript announces itself as it grows; the composer below it does
    // not move, so a reader is never dragged away from what they are typing.
    transcript.setAttribute('aria-live', 'polite');

    const empty = document.createElement('p');
    empty.dataset.role = 'chat-empty';
    empty.textContent = CHAT_EMPTY_STATE;

    const form = document.createElement('form');
    form.dataset.role = 'chat-form';
    form.className = 'chat-form';

    const label = document.createElement('label');
    label.htmlFor = 'chat-input';
    label.className = 'visually-hidden';
    label.textContent = CHAT_PLACEHOLDER;

    const input = document.createElement('input');
    input.id = 'chat-input';
    input.dataset.role = 'chat-input';
    input.type = 'text';
    input.autocomplete = 'off';
    input.placeholder = CHAT_PLACEHOLDER;
    // The server refuses anything longer anyway; stopping it at the field means
    // the player is never told off for a key they already pressed.
    input.maxLength = MAX_CHAT_LENGTH;

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = 'Send';

    const problem = document.createElement('p');
    problem.dataset.role = 'chat-problem';
    problem.className = 'chat-problem';
    problem.setAttribute('role', 'status');

    form.append(label, input, submit);
    panel.append(title, transcript, empty, form, problem);

    /** The last entry drawn, so an ordinary push appends rather than rebuilds. */
    let drawnSeqs: number[] = [];
    let open = false;
    /** The newest seq the player has been shown. Everything after it is unread. */
    let seenSeq = 0;
    let onScreen = false;

    function lineFor(entry: ChatEntry): HTMLElement {
        const item = document.createElement('li');
        item.dataset.role = 'chat-line';
        item.dataset.kind = entry.kind;

        if (entry.kind === 'note') {
            // Copy, not a code: the wire carries `RESTARTED`, the player reads a
            // sentence, and only this layer knows which.
            item.textContent = chatNoteMessage(entry.code);
            return item;
        }

        const who = document.createElement('span');
        who.className = 'chat-who';
        who.textContent = chatSenderLabel(entry);

        const what = document.createElement('span');
        what.className = 'chat-what';
        // textContent, never innerHTML. There is no sanitiser in this repo and
        // there must not need to be one.
        what.textContent = entry.text;

        item.append(who, what);
        return item;
    }

    function drawTranscript(chat: readonly ChatEntry[]): void {
        const seqs = chat.map(entry => entry.seq);
        const isAppend =
            seqs.length >= drawnSeqs.length && drawnSeqs.every((seq, index) => seqs[index] === seq);

        const anchor = anchorOf(transcript);

        if (!isAppend) {
            // A CHAT_HISTORY replacement. Rebuilding is correct here and only
            // here: the slice is a different conversation, not a longer one.
            transcript.replaceChildren();
            for (const entry of chat) transcript.appendChild(lineFor(entry));
        } else {
            for (const entry of chat.slice(drawnSeqs.length)) transcript.appendChild(lineFor(entry));
        }

        drawnSeqs = seqs;
        empty.hidden = chat.length > 0;
        applyAnchor(transcript, isAppend ? anchor : FOLLOWING);
    }

    function drawBadge(chat: readonly ChatEntry[]): void {
        const newest = chat.length === 0 ? 0 : chat[chat.length - 1].seq;

        // Being able to see it IS having read it. `railVisible` and `open` are
        // the two ways that happens, and the second is the one a player chooses.
        if (deps.railVisible() || open) seenSeq = newest;

        const unread = chat.reduce((count, entry) => (entry.seq > seenSeq ? count + 1 : count), 0);
        badge.hidden = unread === 0;
        badge.textContent = String(unread);
        launcher.setAttribute('aria-label', chatLauncherLabel(unread));
    }

    function setOpen(next: boolean): void {
        open = next;
        launcher.setAttribute('aria-expanded', String(next));
        container.dataset.open = String(next);
        // Focus is deliberately left alone, exactly as the reference dock leaves
        // it: taking it on open makes a non-modal panel feel like an
        // interruption, and returning it on close yanks the player out of
        // whatever they moved on to.
    }

    launcher.addEventListener('click', () => setOpen(!open));

    // Bound to the panel rather than the document: a non-modal panel that
    // swallowed every Escape would close itself while the player was cancelling
    // an action sheet somewhere else entirely.
    panel.addEventListener('keydown', event => {
        if ((event as KeyboardEvent).key === 'Escape') setOpen(false);
    });

    form.addEventListener('submit', event => {
        event.preventDefault();

        const validated = validateChatText(input.value);
        if (!validated.ok) {
            problem.textContent = chatProblemMessage(validated.problem);
            return;
        }

        if (!deps.onSend(validated.value)) {
            // The frame did not leave. Keeping the text is the only honest
            // option: clearing it would lose a message the court never heard.
            problem.textContent = 'Not connected — that did not go out.';
            return;
        }

        problem.textContent = '';
        input.value = '';
    });

    setOpen(false);

    return {
        mount(parent) {
            parent.appendChild(container);
        },

        update(state) {
            const showing = wanted(state.screen);

            if (showing !== onScreen) {
                onScreen = showing;
                if (showing) {
                    container.append(panel, launcher);
                } else {
                    panel.remove();
                    launcher.remove();
                    return;
                }
            }

            if (!showing) return;

            drawTranscript(state.chat);
            drawBadge(state.chat);
        },

        destroy() {
            container.remove();
        }
    };
}
```

- [ ] **Step 4: Run the tests**

Run: `bunx vitest run src/client/ui/chatRail.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
but commit -b in-match-chat -m 'feat(chat): the transcript and the box to add to it

Its own surface rather than a fourth reference-dock tab, for two reasons that
are each disqualifying: the dock removes itself on every screen that is not the
table, and chat is wanted from the lobby; and it replaceChildren its whole body
on every state push, which during a match is every STATE_UPDATE — so a composer
inside it would be destroyed, half-typed, each time a bot played a card.

The transcript appends and only rebuilds when a CHAT_HISTORY replacement moves
the leading seq. Text reaches the DOM through textContent; there is no
sanitiser in this repo and there must not need to be one.'
```

---

## Task 8: The rail, and making room for it

**Files:**
- Modify: `src/client/styles/tokens.css` (the custom property's default)
- Modify: `src/client/styles/ui.css` — the media query, ten insets, rail and launcher styling

**Interfaces:**
- Consumes: the class names Task 7 emits (`.chat-rail`, `.chat-launcher`, `.chat-badge`, `.chat-transcript`, `.chat-form`, `.chat-problem`, `.chat-who`, `.chat-what`) and `[data-role="chat-rail-host"][data-open]`.
- Produces: `--chat-rail-w`, read by `main.ts` in Task 9.

**Why a custom property and not a narrower shell.** Insetting `#ui-root` narrows its `position: absolute` descendants — `.screen`, `.toasts`, `.connection-dot`, `.sound-toggle` — because a positioned ancestor is their containing block. It does nothing at all for the nine `position: fixed` rules in `ui.css`. A fixed element's containing block is chosen by ancestor *properties* (`transform`, `filter`, `contain`), never by ancestor *geometry*, so no amount of narrowing an ancestor moves one. All nine would sit under the rail. A custom property is immune: inheritance flows down the tree regardless of containment.

- [ ] **Step 1: Declare the property**

In `src/client/styles/tokens.css`, beside the spacing scale:

```css
    /**
     * How much of the right edge the chat rail is taking, if any.
     *
     * Zero by default and set in exactly ONE place — the media query in
     * `ui.css`. Every viewport-anchored surface subtracts it, and `main.ts`
     * reads its computed value rather than re-testing the query, so the
     * breakpoint exists once in the whole codebase.
     */
    --chat-rail-w: 0px;
```

- [ ] **Step 2: Add the media query**

In `src/client/styles/ui.css`, near the top, after the shell rules:

```css
/**
 * When the rail is worth its width.
 *
 * The aspect clause is not decoration. Without it a tall window — 1200x1000 —
 * passes any width-and-height floor, and the 880x1000 box left for the table is
 * an aspect of 0.88, under `PORTRAIT_MAX_ASPECT`, so `classifyTopology` would
 * hand a desktop window the phone composition. Capping `h <= 3w/4` makes the
 * worst admitted case (1200x900) leave 880/900 = 0.978, and it only improves as
 * the window widens. 4:3 is the ratio `topology.ts` already argues about by
 * name; 1200 rather than 1024 is for margin, since 1024x768 leaves 0.917 — under
 * two percent above the floor, and too thin to trust against browser chrome.
 */
@media (min-width: 1200px) and (min-height: 640px) and (min-aspect-ratio: 4/3) {
    :root {
        --chat-rail-w: 20rem;
    }

    /* Which one paints is decided here and nowhere else. No TypeScript asks. */
    [data-role='chat-rail-host'] .chat-launcher {
        display: none;
    }

    [data-role='chat-rail-host'] .chat-rail {
        display: flex;
    }
}
```

- [ ] **Step 3: Subtract it from every viewport-anchored surface**

Ten edits. In each case the new `right` must come **after** any `inset` shorthand in the same rule, or the shorthand overwrites it.

| Rule | Line | Change |
| --- | --- | --- |
| `#game-container` | 50 | after `inset: 0;` add `right: var(--chat-rail-w, 0px);` |
| `#ui-root` | 68 | after `inset: 0;` add `right: var(--chat-rail-w, 0px);` |
| `.fatal-dialog` | 481 | after `inset: 0;` add `right: var(--chat-rail-w, 0px);` |
| `.action-sheet[data-anchor='bottom']` | 533 | after `inset: auto 0 0 0;` add `right: var(--chat-rail-w, 0px);` |
| `.action-sheet[data-anchor='right']` | 540 | after `inset: 0 0 0 auto;` add `right: var(--chat-rail-w, 0px);` |
| `.reference-tab` | 769 | `right: calc(var(--space-3) + var(--chat-rail-w, 0px));` |
| `.reference-modal` | 813 | `right: var(--chat-rail-w, 0px);` |
| `.seat-dossier` | 1024 | after `inset: auto 0 0 0;` add `right: var(--chat-rail-w, 0px);` |
| `.elimination-notice` | 1083 | after `inset: auto 0 auto 0;` add `right: var(--chat-rail-w, 0px);` |
| `.overlay` | 1125 | after `inset: auto 0 auto 0;` add `right: var(--chat-rail-w, 0px);` |

`.card-hint` (line 745) is the one `position: fixed` rule that needs **no** change: it carries no anchor of its own and is placed by `cardHint.ts` from the injected `viewport()`, which Task 9 repoints at the play area.

Add a comment above the first of them, since the pattern is not self-explanatory:

```css
/* Every viewport-anchored surface subtracts the rail. `position: fixed` cannot
   be narrowed by an ancestor's box — its containing block comes from ancestor
   properties, not geometry — so the width has to arrive as an inherited value
   each rule reads for itself. */
```

- [ ] **Step 4: Style the rail and the launcher**

Append to `ui.css`, following the file's existing conventions (tokens for every colour, `--tap-min` for anything pressable):

```css
/**
 * The rail. Hidden until the media query above says otherwise, at which point
 * it takes the strip `--chat-rail-w` reserved for it.
 */
.chat-rail {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: var(--chat-rail-w);
    z-index: 4;
    display: none;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    padding-bottom: max(var(--space-3), env(safe-area-inset-bottom));
    background: rgb(0 0 0 / 0.86);
    border-left: 1px solid var(--color-border-subtle);
    overflow: hidden;
}

.chat-rail h2 {
    margin: 0;
    font-size: 1rem;
    color: var(--color-text-secondary);
}

/* The panel holds still; only the transcript scrolls. A composer that slid
   under the fold as the conversation grew would be unreachable exactly when
   somebody wanted to reply. */
.chat-transcript {
    flex: 1;
    margin: 0;
    padding: 0;
    list-style: none;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
}

[data-role='chat-line'] {
    display: grid;
    gap: 2px;
    /* Long unbroken runs are possible at 255 characters of ASCII, and a line
       that overflows its own column takes the scrollbar with it. */
    overflow-wrap: anywhere;
}

[data-role='chat-line'][data-kind='note'] {
    color: var(--color-text-secondary);
    font-style: italic;
}

.chat-who {
    color: var(--color-text-secondary);
    font-size: 0.85rem;
}

.chat-what {
    color: var(--color-text-primary);
}

.chat-form {
    display: flex;
    gap: var(--space-2);
}

.chat-form input {
    flex: 1;
    min-width: 0;
    min-height: var(--tap-min);
    padding: 0 var(--space-2);
}

.chat-form button {
    min-height: var(--tap-min);
    padding: 0 var(--space-3);
}

.chat-problem:empty {
    display: none;
}

.chat-problem {
    margin: 0;
    color: var(--color-state-paused);
    font-size: 0.85rem;
}

/**
 * The collapsed state: a corner button beside the reference tab.
 *
 * It sits above the dock's own tab rather than beside it, because both want the
 * bottom-right corner and one of them has to yield. Chat yields upward: the
 * reference is reached mid-decision and chat is not.
 */
.chat-launcher {
    position: fixed;
    right: var(--space-3);
    bottom: calc(var(--space-3) + var(--tap-min) + var(--space-2));
    z-index: 4;
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-height: var(--tap-min);
    padding: 0 var(--space-4);
    border-radius: var(--radius);
    border: 1px solid var(--color-border-subtle);
    background: rgb(0 0 0 / 0.86);
    color: var(--color-text-primary);
    font: inherit;
}

.chat-badge {
    display: inline-grid;
    place-content: center;
    min-width: 1.25rem;
    height: 1.25rem;
    padding: 0 4px;
    border-radius: 999px;
    background: var(--color-state-your-turn);
    color: var(--color-bg);
    font-size: 0.75rem;
}

.chat-badge[hidden] {
    display: none;
}

/**
 * Below the breakpoint the panel is what the launcher opens — and it takes the
 * TOP, never the bottom.
 *
 * The same split `.reference-modal` already argues for, and for the same
 * reason: the action sheet anchors to the bottom on narrow layouts and the hand
 * is under it, so a full-height panel on the right would cover the cards a
 * player is choosing between. The sheet and the hand own the bottom; chat and
 * the dock take the top.
 */
[data-role='chat-rail-host'][data-open='true'] .chat-rail {
    display: flex;
    top: 0;
    bottom: auto;
    width: min(100%, 22rem);
    max-height: 55dvh;
    border-radius: 0 0 0 var(--radius);
}

/**
 * When the action sheet is up, the launcher crosses to the left.
 *
 * `#ui-root[data-sheet] .reference-tab` (ui.css:793) already does exactly this,
 * for exactly this reason — the sheet owns the bottom-right corner while it is
 * open. Without the matching rule the chat launcher stays behind and sits on
 * the sheet's own buttons, which is the collision that rule was written to
 * settle in the first place.
 */
#ui-root[data-sheet] .chat-launcher {
    right: auto;
    left: var(--space-3);
}
```

Two rules there are not obvious and are both corrections to a first draft that had the launcher simply stacked above the dock's tab in the bottom-right. The dock's tab does not stay in that corner: it crosses to the left whenever the action sheet is open, and a launcher that did not follow it would be left sitting on the sheet's buttons.

Every token used above is already defined in `tokens.css`: `--color-border-subtle` (58), `--radius` (59), `--tap-min` (60), `--color-state-paused` (33). There is no `--color-border` — reaching for one would define a new token by accident, and an undefined `var()` does not fall back to the rule beneath it; the whole declaration becomes `unset`, which is exactly how the personal toast shipped with no padding at all.

- [ ] **Step 5: Confirm the shell rules still hold**

Run: `bunx vitest run src/client/ui/uiRoot.test.ts src/client/__tests__`
Expected: PASS. `uiRoot.test.ts` reads the real `ui.css` and asserts the pointer-events discipline; an edit that broke `#ui-root > *` would fail here.

- [ ] **Step 6: Commit**

```bash
but commit -b in-match-chat -m 'feat(chat): give the rail its own strip of the screen

One --chat-rail-w custom property, set by exactly one media query, subtracted
by every viewport-anchored surface. Insetting the shell would not have worked:
position: fixed takes its containing block from ancestor properties rather than
ancestor geometry, so all nine fixed surfaces in ui.css would have sat under
the rail. An inherited value reaches them all.

The breakpoint carries an aspect clause because a width-and-height floor alone
lets a 1200x1000 window squeeze the table to 0.88 and into the portrait
composition.'
```

---

## Task 9: Wiring, and the play area

**Files:**
- Modify: `src/main.ts:110-190`, `:333-380`, `:552`
- Test: manual, plus the existing suites

**Interfaces:**
- Consumes: `createChatRail`, `ChatRailDeps` (Task 7); `Store.sendChat` (Task 6); `--chat-rail-w` (Task 8).
- Produces: nothing later tasks read.

**The reorder.** `main.ts` currently looks `#game-container` up at line 333, well after the surfaces that need to measure it. Move that lookup to the top of `boot()`. It is the same element either way; only the line moves.

- [ ] **Step 1: Move the container lookup and add the two helpers**

Immediately after `const timers = REAL_TIMERS;` near the top of `boot()`:

```ts
    // Looked up here rather than beside the table, because four surfaces
    // measure it and three of them are constructed before the table is.
    const container = document.getElementById('game-container') as HTMLElement;

    /**
     * The box the game actually has, which is the viewport minus the chat rail.
     *
     * Measured off `#game-container` rather than computed from
     * `window.innerWidth`: `ui.css` already insets that element by
     * `--chat-rail-w`, so asking the element is the same question as asking the
     * stylesheet, and it cannot drift from it. The pure layer never learns a
     * rail exists — `computeLayout` is handed a smaller `w` and does what it
     * always did.
     */
    function playArea(): { w: number; h: number } {
        const box = container.getBoundingClientRect();
        return { w: Math.round(box.width), h: Math.round(box.height) };
    }

    /**
     * Whether the rail is painted rather than collapsed.
     *
     * Reads the value CSS resolved instead of re-testing the media query, so
     * the breakpoint is defined once, in `ui.css`, and this cannot disagree
     * with it.
     */
    function railVisible(): boolean {
        const raw = getComputedStyle(document.documentElement).getPropertyValue('--chat-rail-w');
        return Number.parseFloat(raw) > 0;
    }
```

Delete the later `const container = document.getElementById('game-container') as HTMLElement;` at line 333.

- [ ] **Step 2: Repoint the four viewport getters**

- `createCardHint({ viewport: playArea })` (was line 190)
- `createTable({ …, viewport: playArea, timers })` (was line 356)
- `createBeatRunner(beatLayer, { …, viewport: playArea, tableRoot: () => container })` (was line 378)
- in `sheetRequestFor`, `available: playArea()` (was line 552)

Leave `referenceDock`'s `safeTop` alone: it reads `window.innerHeight`, and a right-edge rail does not move a height.

- [ ] **Step 3: Construct and mount the surface**

Beside the other `uiRoot.add(...)` calls, after `referenceDock` so the dock's corner is claimed first:

```ts
    uiRoot.add(
        createChatRail({
            onSend: text => store.sendChat(text),
            railVisible
        })
    );
```

and import `createChatRail` from `./client/ui/chatRail`.

- [ ] **Step 4: Type-check and run everything**

Run: `bun run build && bunx tsc --noEmit && bun run test`
Expected: PASS. Build first — the new client files move Vite's content-hashed bundle name, and `embeddedManifest.test.ts`/`standalone.test.ts` read the committed manifest.

- [ ] **Step 5: See it work**

Two terminals:

```bash
bun run dev:server
bun run dev
```

Open `http://localhost:8080`, host a game, open the invite link in a second window, and check:

1. Chat appears in the lobby for both, before the match starts.
2. A message from one appears in the other.
3. A third window joining sees everything already said.
4. Reloading a window brings the whole transcript back.
5. Widening past 1200px replaces the launcher with the rail — and the table, the action sheet and the reference dock all stop at the rail's edge rather than passing under it.
6. Restarting `dev:server` puts the restart note at the top of the transcript.

- [ ] **Step 6: Commit**

```bash
but commit -b in-match-chat -m 'feat(chat): wire the rail into the composition root

The four viewport getters measure #game-container rather than the window. CSS
already insets that element by --chat-rail-w, so asking the element is asking
the stylesheet, and the two cannot drift. The pure layer never learns a rail
exists: computeLayout is handed a smaller w and does what it always did.

The container lookup moves to the top of boot() because three of the four
surfaces that measure it are constructed before the table is.'
```

---

## Task 10: The gates

**Files:**
- Modify: `src/client/__tests__/axe.test.ts:65-419`, `:452`
- Modify: `visual/gallery.ts:99-153`
- Modify: `visual/harness.ts:236`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `createChatRail` (Task 7).
- Produces: nothing.

- [ ] **Step 1: Add both states to the accessibility gate**

In `src/client/__tests__/axe.test.ts`, import `createChatRail` and append two `SURFACES` entries. Two, not one: the rail and the launcher are different markup, and checking only whichever the media query happens to select would leave the other unchecked — the same reason the reference dock appears twice.

```ts
    [
        'chat rail — expanded, with a conversation',
        root => {
            const rail = createChatRail({ onSend: () => true, railVisible: () => true });
            drive(
                rail,
                root,
                makeState({
                    screen: 'table',
                    table: makeTable(),
                    chat: [
                        { seq: 1, sentAt: 1, kind: 'note', code: 'RESTARTED' },
                        { seq: 2, sentAt: 2, kind: 'said', from: 'p1', nickname: 'Cornelius', text: 'Anyone seen the Mule?' },
                        { seq: 3, sentAt: 3, kind: 'said', from: 'p2', nickname: null, text: 'Not saying.' }
                    ]
                })
            );
        }
    ],
    [
        'chat rail — collapsed, with unread',
        root => {
            const rail = createChatRail({ onSend: () => true, railVisible: () => false });
            drive(
                rail,
                root,
                makeState({
                    screen: 'table',
                    table: makeTable(),
                    chat: [{ seq: 1, sentAt: 1, kind: 'said', from: 'p2', nickname: 'Ana', text: 'your turn' }]
                })
            );
        }
    ]
```

Bump the count at line 452 from `20` to `22`, and extend the comment above it to say why chat appears twice.

- [ ] **Step 2: Run the gate**

Run: `bunx vitest run src/client/__tests__/axe.test.ts`
Expected: PASS. A failure naming `label` means the composer's `<label for>` is not resolving; one naming `aria-live` means the transcript's region is nested inside another.

- [ ] **Step 3: Add a specimen**

In `visual/gallery.ts`, import `createChatRail` and append to `SPECIMENS`:

```ts
    {
        name: 'chat',
        about: 'the rail with a full-length message, a nameless speaker and a note — none may overflow its column',
        mount(root) {
            const rail = createChatRail({ onSend: () => true, railVisible: () => true });
            rail.mount(root);
            rail.update({
                ...BASE_STATE,
                screen: 'table',
                chat: [
                    { seq: 1, sentAt: 1, kind: 'note', code: 'RESTARTED' },
                    { seq: 2, sentAt: 2, kind: 'said', from: 'p1', nickname: 'Cornelius', text: 'Short one.' },
                    // The full limit, unbroken: 255 characters of ASCII with no
                    // space in them is the widest thing this column can ever be
                    // asked to hold, and `overflow-wrap` is the only reason it
                    // fits. A jsdom test cannot measure that.
                    { seq: 3, sentAt: 3, kind: 'said', from: 'p2', nickname: 'Ana', text: 'x'.repeat(255) },
                    { seq: 4, sentAt: 4, kind: 'said', from: 'p3', nickname: null, text: 'No name here.' },
                    { seq: 5, sentAt: 5, kind: 'note', code: 'TRIMMED' }
                ]
            });
        }
    }
```

- [ ] **Step 4: Give it assertions**

In `visual/harness.ts`, inside `judgeSpecimen`, beside the `toasts` branch:

```ts
    if (specimen === 'chat') {
        const rail = await page.evaluate(() => {
            const panel = document.querySelector('[data-role="chat-rail"]') as HTMLElement | null;
            if (panel === null) return null;
            const lines = [...panel.querySelectorAll('[data-role="chat-line"]')].map(el => ({
                kind: (el as HTMLElement).dataset.kind ?? '',
                overflow: el.scrollWidth - el.clientWidth,
                color: getComputedStyle(el).color
            }));
            const form = panel.querySelector('[data-role="chat-form"]') as HTMLElement | null;
            return {
                width: Math.round(panel.getBoundingClientRect().width),
                lines,
                // The composer must be inside the panel's box. If the transcript
                // ever grows the panel instead of scrolling, this goes negative.
                composerBottomGap:
                    form === null
                        ? -1
                        : Math.round(panel.getBoundingClientRect().bottom - form.getBoundingClientRect().bottom)
            };
        });

        if (rail === null) {
            fail(viewport, 'gallery/chat: no rail mounted');
            return;
        }

        if (rail.lines.length === 0) fail(viewport, 'gallery/chat: the transcript drew no lines');

        // The bug this specimen exists to catch: 255 unbroken characters
        // widening the column and taking the scrollbar with them.
        for (const line of rail.lines) {
            if (line.overflow > 1) {
                fail(viewport, `gallery/chat: a ${line.kind} line clips its own text by ${line.overflow}px`);
            }
        }

        // A note that resolves to the same colour as speech is a system message
        // wearing a player's voice.
        const note = rail.lines.find(line => line.kind === 'note');
        const said = rail.lines.find(line => line.kind === 'said');
        if (note !== undefined && said !== undefined && note.color === said.color) {
            fail(viewport, `gallery/chat: a note and a message share a colour (${note.color}) — indistinguishable`);
        }

        if (rail.composerBottomGap < 0) {
            fail(viewport, 'gallery/chat: the composer has been pushed outside the panel by the transcript');
        }
    }
```

- [ ] **Step 5: Run the visual pass and look at it**

Two terminals for `bun run dev:server` and `bun run dev`, then:

```bash
bun run test:visual
```

Expected: PASS, and **open the written PNGs**. This harness fails only on what a machine can judge; two layout bugs have shipped past a fully green suite here and were obvious in a screenshot.

- [ ] **Step 6: Write the changelog entry**

Under `## [Unreleased]` in `CHANGELOG.md`, matching the surrounding voice — the player-facing effect first, then the mechanism, then why an obvious alternative was not taken:

```markdown
### Added

- **The people at the table can talk to each other.** One public channel per
  match, live from the moment the host creates the lobby, and whoever joins next
  is handed everything already said — so arriving third does not mean arriving
  into a conversation you cannot follow. On a wide screen it is a rail beside
  the table; on anything smaller it is a button with a count on it, and the
  count stays until you open it. Messages are 255 characters of plain ASCII,
  which is also what keeps every one of them a single line.

  Nothing is written down. The transcript lives in the room's memory and dies
  with the room, so a finished match leaves nothing behind — and a server
  restart takes it too, which is why a restarted court says so in the
  transcript rather than quietly presenting an empty one.

  The speaker's name travels with each message rather than being looked up when
  it is drawn. A seat whose player disconnects is reopened after a minute and
  handed to whoever arrives next, so the second reading would have put one
  person's words in another person's mouth an hour later.
```

- [ ] **Step 7: Run every gate, in order**

Run: `bun run build && bunx tsc --noEmit && bun run test`
Expected: PASS.

- [ ] **Step 8: Commit and open a pull request**

```bash
but commit -b in-match-chat -m 'test(chat): put the rail in front of both gates that can see it

Two axe entries, because the rail and the launcher are different markup and the
media query only ever selects one of them. A gallery specimen carrying 255
unbroken characters, a nameless speaker and both note kinds, with assertions in
judgeSpecimen for the two things only a real cascade can answer: whether a line
clips itself, and whether a note is distinguishable from speech.'
but push in-match-chat
but pr new in-match-chat -t
```

---

## Verification checklist

Before calling this done:

- [ ] `bun run build && bunx tsc --noEmit && bun run test` passes, **in that order**.
- [ ] `bun run test:visual` passes and the screenshots have been **looked at**.
- [ ] Two browsers on one match: both see each other's messages; a third sees the history.
- [ ] `bun run dev:host` on a phone: the launcher appears, the badge counts, sending works. Chat introduces no new `crypto.*` or `navigator.*` call, but the field is exactly the kind of surface that tempts one, and none of it exists in a non-secure context.
- [ ] Restart `dev:server` mid-conversation: the note appears, nothing throws.
- [ ] `grep -rn "chat" src/server/persistence.ts` returns nothing.
- [ ] A wide window: the action sheet, the reference dock, the seat dossier, the round-over overlay and the elimination notice all stop at the rail.

## What this plan deliberately does not build

Named so a reviewer does not read them as omissions: no sound for an arriving message; no way to collapse the rail on a wide screen; no moderation, mute, or report; no private messages; no MCP participation. Each is argued in §12 of the design.
