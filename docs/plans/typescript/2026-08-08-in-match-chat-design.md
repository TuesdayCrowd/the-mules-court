# The Mule's Court — In-Match Chat Design

**Date:** 2026-08-08
**Status:** Decided. Every question in §12 is genuinely open; nothing above it is.
**Scope:** One public text channel per match, from lobby creation until the room dies.
**Depends on:** `docs/plans/typescript/2026-07-22-transport-design.md`, `docs/plans/typescript/2026-07-23-uix-design.md`

---

## 1. Scope

The people at this table cannot speak to one another. The transport carries
plays and the client narrates their consequences, and between those two there is
no channel for a person to say anything a card cannot say for them.

This design covers that channel: one public transcript per match, live from the
moment the host creates the lobby, delivered whole to anyone who arrives later,
and gone when the room is. It touches the wire, the room, the client store and
one new DOM surface. **It changes no rule.** Nothing here reaches the engine,
and no chat message can affect a match's outcome.

### Fixed decisions

| Decision | Choice |
| --- | --- |
| Channels | One, public, per match. No private messages, no teams |
| Who may speak | Any claimed seat, in lobby and while the match runs |
| Eliminated players | Speak freely. Elimination is a game state, not a social one |
| Computer opponents | Silent. A bot seat holds no socket and cannot receive a frame |
| MCP seats | Neither read nor write. No tool exposes the transcript |
| Persistence | None. In memory on the `Room`, never in `MatchRecord` |
| Lifetime | Dies with the `Room` object, on the existing reapers |
| Message limit | 255 characters, ASCII 32–126 |
| Transcript bound | 1 MiB of serialized payload, oldest evicted first |
| Rate limit | A dedicated bucket: burst 5, refill 1/sec |
| Moderation | None. No filter, no mute, no report |

---

## 2. The problem worth solving

Three of the four decisions above look like restrictions and are not. They are
the shape the existing system already has, and writing chat against a different
shape is how it would break something that currently works.

**The transcript is a fourth kind of message.** `STATE_UPDATE` is unicast and
redacted per seat, because it carries hidden information. `LOBBY_UPDATE`,
`MATCH_STARTED` and `MATCH_ENDED` are broadcast, because they provably carry
none. Chat is the first message that is broadcast-identical *by requirement*
rather than by luck — every seat must see the same words in the same order, and
a redaction step applied to it would be both wasted work and a lie about what
the message is.

**Nobody joins a match in progress.** `Room.claimSeat` answers `ROOM_FULL` once
`phase === 'active'` (`room.ts:440`). So the stated requirement — a player who
takes seat 3 sees what the host and seat 2 already said — is a *lobby* scenario
by construction. Its mid-match counterpart is a **reconnect**, which arrives
through `RESUME_SEAT` and already receives a full repaint rather than a diff.
One delivery mechanism serves both, and a design that treated them as two
problems would have built the second one twice.

**A seat is a slot, not a person.** `Room.sweep()`'s lobby branch reopens a
disconnected seat after `lobbyDisconnectGraceMs` by clearing its `tokenHash`
*and its `nickname`*, and the next arrival claims the same `p2`. Attribution by
`PlayerId` alone is therefore not attribution at all: it is a promise the room
withdraws sixty seconds after somebody's connection drops. §5 is mostly about
this.

---

## 3. Architecture

```
browser (human seat)                     Bun server :3000                  Room
      |                                        |                             |
      |  SEND_CHAT { text }                    |                             |
      |--------------------------------------->|  parse -> chat bucket ----->| sendChat()
      |                                        |                             |  append + evict
      |  <---------- CHAT_SAID { entry } ------|<--- broadcast() ------------|
      |                                        |                             |
      |  RESUME_SEAT / CLAIM_SEAT              |                             |
      |--------------------------------------->|---------------------------->| resumeSeat()
      |  <-------- CHAT_HISTORY { entries } ---|<--- unicast, whole log -----|
```

Chat rides the connection that already exists and the queue that already
serializes it. `Room.enqueue` orders every command against every other, so a
history unicast and a live broadcast cannot interleave: either the message was
appended before the resume ran, and it is *in* the history, or it was appended
after, and it arrives as an ordinary broadcast behind it. There is no third
case, and therefore no dedupe rule to get wrong.

The transcript never touches the engine, `reduce()`, the `actionLog` or
`MatchRecord`. It is a field on the live `Room` object, in the same category as
`revealTimer` and `advancing`: transport-only state that a rebuild does not
restore.

---

## 4. Message protocol

### Client to server

```ts
| { type: 'SEND_CHAT'; matchId: MatchId; text: string }
```

No `playerId`, for the reason `PLAY_CARD` has none: the acting seat is the bound
connection's, never a payload field. No `clientMsgId` either — a chat message
needs no optimistic echo, because nothing is locked while it flies and nothing
in the client waits on its acknowledgement.

### Server to client

```ts
| { type: 'CHAT_SAID';    matchId: MatchId; entry: ChatEntry }      // broadcast, append one
| { type: 'CHAT_HISTORY'; matchId: MatchId; entries: ChatEntry[] }  // unicast, replace whole

type ChatEntry = { seq: number; sentAt: number } & (
    | { kind: 'said'; from: PlayerId; nickname: string | null; text: string }
    | { kind: 'note'; code: ChatNoteCode }
);

type ChatNoteCode = 'RESTARTED' | 'TRIMMED';
```

### Why two outbound types rather than one

One type carrying an array, with "length of one means a new message", is a
value-based heuristic standing in for an intent field, and it fails on the
commonest case there is: a match in which exactly one thing has been said.

Walk it. The log holds `msg0`. A player who watched `msg0` arrive drops their
connection and resumes. The server sends the full history — one entry — and the
frame is indistinguishable from a live broadcast of that same entry. A client
that appends shows it twice; a client that replaces is correct here and wrong
for every genuine broadcast. `seq` could rescue this, but only by making every
client implement a merge rule that the wire never asked for.

Two types state the intent on the frame. `CHAT_HISTORY` replaces the slice
whole, exactly as `TableSnapshot` is "held whole and replaced whole"; `CHAT_SAID`
appends one. Neither needs the other's rule.

### The client's own parse boundary

`socket.ts` holds `SERVER_MESSAGE_TYPES` (`socket.ts:95`), a **runtime**
allowlist of every frame type the client will accept — the union is a type and
has no runtime form. Both new types must be added there. Omitting them does not
fail a build: frames are dropped silently and chat simply never appears, which
is the worst kind of failure this file exists to prevent.

The far side of that boundary is safer. `store.ts`'s `next(msg)` switch has no
`default` arm and is typed to return `ClientState`, so an unhandled variant is a
compile error rather than a silent fall-through.

---

## 5. The transcript

### Attribution: the nickname travels with the entry

`ChatEntry` carries the sender's `nickname` alongside `from`, denormalized at
send time. This is the one place chat departs from how the rest of the transport
handles names — `STATE_UPDATE` ships `nicknames: Record<PlayerId, string>` and
rebuilds it fresh from current seat state on every push (`room.ts:1215`) — and
the departure is deliberate.

The failure it prevents: Alice claims `p2`, says "brb", and loses her
connection. Sixty seconds later `Room.sweep()` reopens the seat and clears its
name. Bob arrives, claims `p2`, and every client's `nicknames` map now resolves
`p2` to Bob. A transcript that looked the name up at render time would display
**"Bob: brb"** — words Bob never said, in a deduction game where what somebody
said is evidence. Nothing purges the log when a seat reopens, and nothing
should: the words were really spoken, by someone who is really gone.

`nickname` stays nullable because a seat can genuinely hold none. The host seat
is minted over HTTP with no name and adopts one only through `RESUME_SEAT`, only
in lobby phase, and only if that frame carried one. The client renders a seat
label in that case; the server does not refuse the send, because a refusal the
player cannot act on is worse than an unlabelled line. Note that
`buildStateUpdate` resolves the same absence to `''` — an empty string is right
for a table chip, which has a seat under it, and wrong for a transcript line,
which would have nothing.

### Bounds and eviction

The log is capped at **1 MiB of serialized payload**, enforced **on append**: a
running byte total is incremented by each new entry's own serialized size and
decremented by each evicted one's, and entries are dropped from the front until
the total fits. An entry's size is `JSON.stringify(entry).length` — bytes,
since the text is ASCII by validation — computed once when it is appended and
kept beside it, so eviction never re-serializes. That number is the one that
matters, because it is what a `CHAT_HISTORY` frame actually costs. Trimming
lazily at read time would leave `chatLog` growing without bound in memory
between reads and make the cap cosmetic.

When eviction drops anything, a single `{ kind: 'note', code: 'TRIMMED' }` sits
at the head of the log, so a transcript that starts partway through says that it
does. A history that silently begins in the middle is indistinguishable from a
short one.

The cap is insurance rather than a working constraint. At 255 characters a
message, 1 MiB is several thousand of them, and the dedicated rate limit caps a
seat at one per second sustained. It is worth stating that
`perMessageDeflate` is **off** (`index.ts:131`, closing the compression-bomb row
of the transport design's §13), so a full history frame is its full size on the
wire, once per arriving seat. `maxPayloadLength` bounds inbound frames only.

### Lifetime

The transcript is a field on the `Room`, so it dies when the `Room` does and
nothing explicitly deletes it. The existing reapers already destroy a room once
everyone has gone: a lobby past `lobbyTtlMs`, an active match with no
connections past `zeroConnTtlMs`, then `retentionMs` in the `ended` phase before
the registry drops it and deletes the row.

**It is deliberately not dropped when the last socket closes.** A single player
refreshing their browser passes through zero connections, and a transcript keyed
on that moment would be wiped by an action the player experiences as staying put.
The cost of the choice is that the words outlive the conversation by up to the
retention window, held in a room nobody is connected to. Since they are never
written to disk and never leave the process, that is memory, not exposure.

A restart is the other half. Rooms rebuild lazily from `{seed, actionLog}`, and
a transcript has nothing to rebuild from, so `Room.rebuild` seeds the log with
one `{ kind: 'note', code: 'RESTARTED' }` and the client explains itself. The
note states the restart rather than the loss, because a rebuild cannot know
whether anything was there to lose — and under `bun --watch`, which AGENTS.md
documents as load-bearing for `dev:server`, this fires on every engine file
saved during development.

---

## 6. Validation and limits

`src/client/content/chat.ts` mirrors `content/nickname.ts` exactly: trim, reject
empty, reject over the limit, reject any character outside the allowed set, and
return a discriminated result the surface can render a reason from.

**255 characters. ASCII 32–126.** The upper bound is 126 and not 127: `0x7F` is
DEL, a control character that is not printable, and the existing
`hasControlChar` guard in `protocol.ts` already rejects it for nicknames. A
consequence worth naming: 10 is a control character too, so **messages are
single-line**. Nothing in the transcript can contain a newline, which is also
what keeps a line's rendered height predictable.

The limit constant lives in `src/server/config.ts` and is imported by
`content/chat.ts`, making that file the **second** entry in `purity.test.ts`'s
`ALLOWED` set. The argument is nickname's, unchanged: `config.ts` has no
imports and touches neither Bun nor `process`, so it is a plain literal, and the
alternative is a second copy of the limit that drifts until the client sends
exactly what the server refuses. Forgetting the allowlist entry fails the purity
gate loudly, which is the intended behaviour.

### Rate limiting

`SEND_CHAT` spends from a **second** `TokenBucket` on `ConnectionState` — burst
5, refill 1/sec — and **instead of**, not in addition to, the shared one.

The distinction is the whole point. `dispatch.ts:105-109` spends from
`state.bucket` unconditionally, before any branch on message type; its own
comment says *every message type spends a token, PING included*. A chat check
bolted on after that leaves chat still drawing down the shared pool of 10, so a
player typing quickly can rate-limit their own next `PLAY_CARD` — precisely the
starvation the second bucket exists to prevent. Step 4 of the pipeline
therefore routes `SEND_CHAT` to its own bucket before the shared spend, and the
new bucket is strictly tighter than the old one, so nothing is loosened.

### Gates on sending

`SEND_CHAT` requires a bound seat, which `dispatch.ts`'s `requiresBoundSeat`
already expresses, and is accepted in `lobby` and `active` phases. In `ended`
it is refused with `MATCH_OVER` while the transcript stays readable: the words
of a finished match are worth keeping on screen, and adding to them is not.

Someone connected but unseated — a visitor still at the nickname prompt — has no
seat, so they cannot send, and `Room.broadcast` iterates seats, so they receive
nothing either. Chat begins when a seat does.

---

## 7. Where it lives on screen

The requirement is a rail that is always visible while playing when the screen is
large enough, and a launcher with an unread badge when it is not.

### The mechanism: one custom property

```css
:root { --chat-rail-w: 0px; }

@media (min-width: 1200px) and (min-height: 640px) and (min-aspect-ratio: 4/3) {
    :root { --chat-rail-w: 20rem; }   /* 320px */
}
```

`#game-container`, `#ui-root`, and every viewport-anchored surface take
`right: var(--chat-rail-w, 0px)`. The rail occupies the strip that leaves.

**The obvious alternative does not work, and it is worth writing down why.**
Insetting `#ui-root` narrows its `position: absolute` descendants — `.screen`,
`.toasts`, `.connection-dot`, `.sound-toggle` — because a positioned ancestor is
their containing block. It does nothing whatsoever for the nine
`position: fixed` rules in `ui.css` (lines 69, 482, 519, 746, 770, 814, 1025,
1084, 1126: the shell itself, the fatal dialog, the action sheet, the card hint,
the dock's tab and panel, the seat dossier, the elimination notice, and the
overlay). A fixed element's containing block is chosen by ancestor *properties*
— `transform`, `filter`, `contain` — never by ancestor *geometry*, so no amount
of narrowing an ancestor moves it. All nine would sit under the rail.

A custom property is immune to that, because inheritance flows down the tree
regardless of containment. One variable reaches every surface, fixed and
absolute alike, at one line each.

`main.ts`'s four viewport getters — the table, the beat runner, the card hint,
and the action sheet's `available` — stop reading `window.innerWidth` and
measure `#game-container`'s own box. The pure layer never learns that a rail
exists: `computeLayout` is handed a smaller `w` and does what it always did.
Geometry stays data, and the renderer still only obeys it.

### The breakpoint, and why it carries an aspect clause

A width-and-height threshold is provably unsafe on its own. At 1200×1000 the
window passes any such floor, and the table box left over is 880×1000 — an
aspect of 0.88, under `PORTRAIT_MAX_ASPECT` of 0.9, so `classifyTopology` sends a
desktop window to the **portrait** composition. The rail would have squeezed the
table into a topology meant for a phone.

`min-aspect-ratio: 4/3` closes it, and 4:3 is not an arbitrary number: it is the
ratio `topology.ts` already argues about by name when explaining why height, not
aspect, decides the landscape split.

Within the region the query admits, `h ≤ 3w/4`, so the leftover aspect is
`(w − 320) / h ≥ 4/3 − 1280/(3w)`, which increases with `w` and is therefore
worst at the smallest admitted width:

```
w = 1200 :  (1200 − 320) / 900  =  0.978   vs  PORTRAIT_MAX_ASPECT 0.9
h ≥ 640  :                  640            vs  MIN_WIDE_HEIGHT    560
```

So `classifyTopology(w − 320, h)` returns `'wide'` at every point the rail can
be visible, with margin in both directions. 1200 rather than a rounder 1024 is
chosen for that margin: at 1024×768 — a viewport the visual harness already
photographs — the leftover aspect is 0.917, under two percent above the portrait
floor and too thin to trust against scrollbars and browser chrome.

### The collapsed state and the badge

The rail and the launcher are **both mounted, always**, by the same surface.
Which one paints is decided by the same media query and nothing else:
`display` is toggled in CSS, never in TypeScript. This is what keeps the
threshold to a single definition in a single file — the alternative is a
breakpoint constant in TypeScript that must be kept equal to one in CSS, and the
two drift silently because neither can see the other.

Where `main.ts` genuinely needs to know whether the rail is up, it reads the
computed value of `--chat-rail-w` rather than re-testing the query. CSS remains
the only place the number appears.

The badge is the surface's own state, exactly as the reference dock owns its
open flag and active tab: it holds `lastSeenSeq` and advances it when the player
opens the panel. It is rendered on the launcher, so in expanded mode there is
nothing to paint and nothing to clear. One cosmetic edge is accepted: narrowing
a wide window can surface a badge counting messages already read.

### Why this is a new surface and not a fourth dock tab

The reference dock looks like the natural home and is not, for two reasons that
are each disqualifying.

It removes itself from the document on every screen that is not the table
(`update` keys on `state.screen === 'table'`), and chat is required from the
lobby onward. And `render()` calls `panel.replaceChildren(...)` on **every**
state push, which during a match is every `STATE_UPDATE` — so a text input
living inside it would be destroyed, with whatever was half-typed in it, each
time a bot played a card.

What chat takes from the dock is its *shape*: a labelled `region` rather than a
`dialog`, Escape bound to the panel rather than the document, focus left alone
on open, and `scrollFollow.ts` for a transcript that grows from the bottom while
it is being read. Its transcript list appends rather than rebuilds, and the
composer is never torn down.

---

## 8. Client state

```ts
export interface ClientState {
    // …
    readonly chat: readonly ChatEntry[];
}
```

Appended on `CHAT_SAID`, replaced wholesale on `CHAT_HISTORY`, `[]` initially.
The store derives nothing from it — no unread count, no formatting, no grouping
— for the same reason it derives no game rule: those are presentation questions,
and the surface that asks them is the one that can answer them.

`seq` is the stable key for the rendered list and the basis of the unread count.
It is assigned by the room, monotonic within a match, and never reused.

---

## 9. File layout

```
src/server/
  protocol.ts       + SEND_CHAT, CHAT_SAID, CHAT_HISTORY, ChatEntry, the parse arm
  dispatch.ts       + chat bucket routed before the shared spend; the SEND_CHAT case
  room.ts           + chatLog, byte total, sendChat(), history on claim/resume, rebuild note
  config.ts         + maxChatLength, chatBurst, chatRefillPerSec, chatLogMaxBytes

src/client/
  content/chat.ts   validation and every player-facing string, incl. note copy
  store/types.ts    + ChatEntry, ClientState.chat
  store/store.ts    + the two cases, + sendChat()
  store/socket.ts   + both types in SERVER_MESSAGE_TYPES
  ui/chatRail.ts    the surface: transcript, composer, launcher, badge
  styles/ui.css     --chat-rail-w, the media query, right: on nine fixed rules
main.ts             construct and add the surface; viewport getters read the container box
```

---

## 10. Testing strategy

Both runners, as the split already requires: `src/server/` under `bun test`,
`src/client/` under Vitest.

1. **`protocol.test.ts`** — `SEND_CHAT` against valid, oversized, empty,
   whitespace-only, extra-field, wrong-typed and non-ASCII input, including a
   DEL at `0x7F` and an embedded newline, each asserted refused.
2. **`room.test.ts`** — append and broadcast; history on `CLAIM_SEAT` and on
   *every* `RESUME_SEAT`, not merely the first; refusal once `ended`; the note
   seeded by `rebuild`.
3. **A dedicated attribution test** — claim `p2`, speak, disconnect, expire the
   grace, reclaim `p2` under a different name, and assert the old line still
   carries the old name. This is §5's whole argument, executable.
4. **An eviction test** — drive the byte total past the cap and assert the
   oldest entries leave, the total is decremented, and exactly one `TRIMMED`
   note leads the log.
5. **A starvation test** — exhaust the chat bucket and assert the next
   `PLAY_CARD` still passes. This is the one that fails if the second bucket is
   ever added to the shared spend instead of replacing it.
6. **`store.test.ts`** — append versus replace; a reconnect delivering a
   one-entry history over a client that already holds that entry produces one
   line, not two.
7. **`chatRail.test.ts`** (jsdom) — the composer survives an `update()`; the
   badge counts from `lastSeenSeq` and clears on open; a seat with a null
   nickname renders its seat label.
8. **`axe.test.ts`** — two new `SURFACES` entries, expanded and collapsed, and
   the hard-coded length bumped to match.
9. **`visual/gallery.ts`** — a specimen holding several messages, one at the
   full 255 characters, a note line, and a null-nickname line; with a matching
   branch in `judgeSpecimen`. Adding the specimen without the branch buys a
   photograph and no assertion, and this repo has already shipped a padding bug
   that only a photograph would have caught.

The gate order is the established one and is load-bearing:
`bun run build && bunx tsc --noEmit && bun run test`. A new client file moves
the content-hashed bundle name, and running the suite first fails
`embeddedManifest.test.ts` in a way that reads as a broken import.

`CHANGELOG.md`'s `Unreleased` section gains its entry as the work is done, not
afterwards.

---

## 11. Failure modes closed

| Failure | Closed by |
| --- | --- |
| A reopened seat puts words in the new occupant's mouth | The nickname travels with the entry |
| A one-message history duplicates on reconnect | Two outbound types; intent stated on the frame |
| Chat rate-limits the sender's own next play | A dedicated bucket that replaces the shared spend |
| A new frame type silently never arrives | `SERVER_MESSAGE_TYPES` is a runtime allowlist; the store's switch is exhaustive |
| A half-typed message destroyed by a bot's turn | Its own surface; the composer is never rebuilt |
| The rail covering the action sheet, dock, or overlays | A custom property, which containment cannot block |
| A rail squeezing the table into the portrait composition | The aspect clause, proved at the worst admitted point |
| A breakpoint defined twice and drifting | The number exists only in CSS; JS reads its computed value |
| A transcript that starts mid-conversation without saying so | The `TRIMMED` note |
| Chat wiped by a player refreshing their own browser | Lifetime bound to the room, not to zero connections |
| Untrusted free text entering a model's context | No MCP tool exposes it; `seatClient.ts:223` drops the frames |
| Unbounded memory from a chatty long match | Evict-on-append against a running byte total |

---

## 12. Open questions

1. **A cue for an arriving message.** None is specified. The thirteen existing
   sounds are recorded takes, so a chat blip is a recording session, not a
   constant.
2. **Whether the rail should be collapsible on a wide screen.** It is currently
   always up above the breakpoint. A player who wants the width back has no way
   to ask for it.
3. **The tunables.** 255, 1 MiB, 5-and-1, 1200×640: each is a defensible
   starting point and none has been played against.
4. **Mid-match arrival.** If seats ever become claimable during play, the
   history path already serves it — but the phase gate in `claimSeat` is what
   would need arguing, and it is not this design's to move.
5. **MCP participation.** Deliberately absent, and the reason is a security
   judgement rather than a scoping one: every other tool returns engine-derived,
   structurally-typed data, and chat would be the first freeform text from
   another party to enter a model's context. It deserves its own decision.

---

## 13. Risks

- **Collusion is now easier, and that is the feature.** Two players can agree
  what to say about their hands. This is what talking at a table has always
  been, and no rule here prevents it; a design that tried would be policing
  the game rather than serving it.
- **The transcript outlives the conversation.** Up to the retention window, in
  a room nobody is connected to. It never reaches disk, so this is a memory
  cost and not an exposure, but it is a real one on a busy process.
- **A restart note will fire constantly in development.** `dev:server` runs
  under `--watch`, so every engine edit restarts the process and seeds the note.
  It is correct each time and will still read as noise while chat is being built.
- **The rail is the largest visual change the client has taken since the
  renderer.** Nine CSS rules gain an inset and four viewport getters change what
  they measure. jsdom cannot see any of it; the screenshot pass is the only
  thing that can, and it must actually be looked at.
- **One public channel is the only channel.** Nothing here anticipates a
  private message, and the entry shape would need a recipient to grow one.
