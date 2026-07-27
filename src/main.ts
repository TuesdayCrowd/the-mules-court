/**
 * The composition root.
 *
 * Every ambient dependency in the client is injected, which is what made the
 * whole thing testable — and this is the one file that supplies the real ones:
 * `window.localStorage`, `WebSocket`, `Date.now`, `crypto.randomUUID`,
 * `navigator.clipboard`, `location`. Nothing below `src/client/` reaches for any
 * of them.
 *
 * Order matters here. The store and the socket need each other — the store sends
 * through the socket, the socket applies into the store — so the socket is held
 * in a `let` the store's `send` closes over, rather than one of them being
 * constructed half-built.
 */

// Imported here rather than linked from index.html so Vite bundles and
// fingerprints them; fonts and tokens first, since ui.css reads their values.
import './client/styles/fonts.css';
import './client/styles/tokens.css';
import './client/styles/ui.css';

import type { CardInstanceId, PlayerId } from './game/engine';
import { cardTypeOf } from './game/engine';
import type { PresentationEvent } from './client/store/diff';
import { announcementFor } from './client/content/announce';
import { cardCopyFor } from './client/content/cardCopy';
import { failureCopy } from './client/content/failureCopy';
import { diffSnapshots } from './client/store/diff';
import { beatForEvent } from './client/store/motion';
import { createPresentationQueue } from './client/store/presentationQueue';
import { browserIdMinter } from './client/store/ids';
import { createRoomApi } from './client/store/roomApi';
import { parseRoute } from './client/store/routes';
import { createSeatTokenStore } from './client/store/seatTokenStore';
import { createSocket, socketUrl } from './client/store/socket';
import type { WebSocketLike } from './client/store/socket';
import { createStore } from './client/store/store';
import type { ClientState } from './client/store/types';
import { createA11yTwin } from './client/ui/a11yTwin';
import { createActionSheet } from './client/ui/actionSheet';
import type { SheetTarget } from './client/ui/actionSheet';
import { createClipboard } from './client/ui/clipboard';
import { createConnectionDot } from './client/ui/connectionDot';
import { createFatalScreen } from './client/ui/fatalScreen';
import { createJoinScreen } from './client/ui/joinScreen';
import { createLobbyScreen } from './client/ui/lobbyScreen';
import { createMenuScreen } from './client/ui/menuScreen';
import { createOverlays } from './client/ui/overlays';
import { createQuickReference } from './client/ui/quickReference';
import { createSeatDossier } from './client/ui/seatDossier';
import { REAL_TIMERS } from './client/ui/surface';
import { createToasts } from './client/ui/toasts';
import { createUiRoot } from './client/ui/uiRoot';
import { CARD_SELECTED } from './game/scenes/Court';
import type { Court } from './game/scenes/Court';
import StartGame from './game/main';

/**
 * The real `WebSocket`, adapted to the shape the client tests against.
 *
 * Not a cast. The browser's handlers take an event argument and the injected
 * interface's take none, which is a genuine contravariance mismatch rather than
 * a technicality — and adapting rather than widening buys one real correctness
 * fix: `MessageEvent.data` is typed `any` and can arrive as a Blob or an
 * ArrayBuffer. Anything that is not a string is dropped here, so
 * `parseServerMessage` never has to reason about `"[object Blob]"`.
 */
function browserSocket(url: string): WebSocketLike {
    const ws = new WebSocket(url);
    const like: WebSocketLike = {
        send: data => ws.send(data),
        close: () => ws.close(),
        onopen: null,
        onclose: null,
        onmessage: null,
        onerror: null
    };

    ws.onopen = () => like.onopen?.();
    ws.onclose = () => like.onclose?.();
    ws.onerror = () => like.onerror?.();
    ws.onmessage = event => {
        if (typeof event.data === 'string') like.onmessage?.({ data: event.data });
    };

    return like;
}

function boot(): void {
    const route = parseRoute(location.pathname);
    const matchId = route.kind === 'join' ? route.matchId : null;

    const tokens = createSeatTokenStore(window.localStorage);
    const timers = REAL_TIMERS;

    // --- store and socket, mutually dependent
    let socket: ReturnType<typeof createSocket> | null = null;

    const store = createStore({
        matchId,
        tokens,
        send: msg => socket?.send(msg) ?? false,
        now: () => Date.now(),
        // Never `crypto.randomUUID()` bare: it is secure-context only, so over
        // http:// on a LAN address it is undefined and calling it threw inside
        // the Play handler — which looked exactly like the button doing nothing.
        mintId: browserIdMinter(typeof crypto === 'undefined' ? undefined : crypto)
    });

    if (matchId !== null) {
        socket = createSocket({
            url: socketUrl(location.origin),
            matchId,
            open: browserSocket,
            storedSeat: () => tokens.load(matchId),
            nickname: () => tokens.load(matchId)?.nickname,
            onMessage: msg => store.apply(msg),
            onStatus: status => store.setConnection(status),
            timers,
            random: () => Math.random()
        });
        socket.connect();
    }

    // --- DOM layer
    const uiRoot = createUiRoot(document.getElementById('ui-root') as HTMLElement);

    const toasts = createToasts({
        timers,
        copyFor: code => failureCopy(code).message,
        onDismiss: id => store.dismissNotice(id)
    });

    const actionSheet = createActionSheet({
        onPlay: choice => {
            if (store.playCard(choice)) return true;

            // The sheet already disables Play while the socket is down, so
            // reaching here means something rarer — a play still in flight. Say
            // so rather than leaving the press unexplained; a refusal nobody can
            // see is how the last several bugs stayed hidden.
            toasts.show(
                store.getState().connection === 'open'
                    ? 'Still waiting on your last play.'
                    : 'Not connected — trying to reach the court.'
            );
            return false;
        },
        onCancel: () => {}
    });

    const seatDossier = createSeatDossier();

    uiRoot.add(createConnectionDot());
    uiRoot.add(
        createMenuScreen({
            roomApi: createRoomApi({ fetch: (url, init) => fetch(url, init), timers, random: () => Math.random() }),
            tokens,
            navigate: path => location.assign(path)
        })
    );
    uiRoot.add(createJoinScreen({ onSubmit: nickname => void store.claimSeat(nickname) }));
    uiRoot.add(
        createLobbyScreen({
            onStart: () => socket?.send({ type: 'START_MATCH', matchId: matchId as string }),
            onDissolve: () => socket?.send({ type: 'END_MATCH', matchId: matchId as string }),
            // `navigator.clipboard` is secure-context only and absent over
            // http on a LAN address — which is exactly where the invite link
            // most needs copying, since that is when there is a second device
            // to send it to. `createClipboard` falls back to a selection copy
            // there rather than giving up.
            clipboard: createClipboard({
                ...(navigator.clipboard === undefined ? {} : { clipboard: navigator.clipboard }),
                exec: command => document.execCommand(command)
            }),
            joinUrlFor: id => `${location.origin}/join/${id}`
        })
    );
    uiRoot.add(
        createOverlays({
            timers,
            now: () => Date.now(),
            isHost: () => store.getState().seat?.playerId === store.getState().lobby?.hostSeat,
            // D4: the client is never told when activeGraceMs has elapsed, so
            // this stays false until the server sends the answer.
            canEndMatch: () => false,
            onEndMatch: () => socket?.send({ type: 'END_MATCH', matchId: matchId as string })
        })
    );
    uiRoot.add(createQuickReference());
    uiRoot.add(seatDossier);
    uiRoot.add(actionSheet);
    uiRoot.add(
        createFatalScreen({
            onAction: kind => {
                if (kind === 'menu') {
                    location.assign('/');
                    return;
                }
                // "Take over here" (UIX §5). Clearing the wall first is what
                // lets the reconnect's frames land; the socket was stopped when
                // the FATAL arrived, so this is the deliberate reopen.
                store.retryAfterFatal();
                socket?.connect();
            }
        })
    );

    // --- the canvas, and the accessibility twin that shadows it
    const game = StartGame('game-container');
    let court: Court | null = null;

    const twin = createA11yTwin({
        layout: () => court?.currentLayout() ?? null,
        onSelect: id => openSheetFor(id)
    });
    twin.mount(document.getElementById('a11y-twin') as HTMLElement);

    game.events.once('court-ready', () => {
        court = game.scene.getScene('Court') as Court;
        // Tapping a card on the canvas and activating its accessibility proxy
        // are the same intent, so both land here.
        court.events.on(CARD_SELECTED, (id: CardInstanceId) => openSheetFor(id));
        court.renderView(store.getState());
    });

    /**
     * Where a beat plays and what art it shows.
     *
     * Assembled here because it needs the live layout, which only the scene
     * has; the beat itself takes a rect and a texture key and knows nothing
     * about seats or cards.
     */
    function beatContext(event: PresentationEvent): Parameters<Court['playBeat']>[1] {
        const table = store.getState().table;
        const spec = court?.currentLayout() ?? null;
        const nameOf = (id: PlayerId) => table?.nicknames[id] ?? id;

        if (event.kind === 'peek-gained') {
            return {
                portraitKey: cardCopyFor(event.cardTypeId).portraitKey,
                label: `Only you see this — ${nameOf(event.subjectId)}`
            };
        }

        if (event.kind === 'log' && table !== null && spec !== null) {
            // Bound to a local: narrowing `event.entry.kind` inside a compound
            // condition does not survive repeated access to a union member.
            const entry = event.entry;
            if (entry.kind !== 'ELIMINATED') return {};

            const opponents = table.view.players.filter(p => p.id !== table.view.own.playerId);
            const index = opponents.findIndex(p => p.id === entry.playerId);
            const rect = index >= 0 ? spec.opponents[index] : undefined;
            const held = table.view.roundResult?.revealedHands?.[entry.playerId] ?? null;
            return {
                ...(rect === undefined ? {} : { rect }),
                ...(held === null ? {} : { portraitKey: cardCopyFor(held).portraitKey }),
                label: `${nameOf(entry.playerId)} is out`
            };
        }

        return {};
    }

    /** Assembled here, from the view. The sheet renders what it is handed and evaluates nothing. */
    function openSheetFor(cardInstanceId: CardInstanceId): void {
        const table = store.getState().table;
        if (table === null) return;

        const own = table.view.own.playerId;
        const targets: SheetTarget[] = table.view.players
            .filter(player => player.id !== own)
            .map(player => ({
                playerId: player.id as PlayerId,
                nickname: table.nicknames[player.id] ?? player.id,
                eligible: player.alive && !player.protected,
                ...(!player.alive ? { reason: 'eliminated' as const } : player.protected ? { reason: 'protected' as const } : {})
            }));

        actionSheet.open({
            cardId: cardTypeOf(cardInstanceId),
            cardInstanceId,
            targets,
            playable: table.view.own.legalPlays.includes(cardInstanceId),
            available: { w: window.innerWidth, h: window.innerHeight }
        });
    }

    // --- the single subscriber (interface rule 6)
    const queue = createPresentationQueue({ announce: line => toasts.show(line) });
    let previous: ClientState = store.getState();

    store.subscribe(state => {
        // A FATAL means stop retrying. The server closed the socket on purpose,
        // and reconnecting into SEAT_TAKEN makes two tabs evict each other
        // forever — verified against the real server at 22 evictions in three
        // seconds. Only "Take over here" reopens it.
        if (state.fatal !== null && previous.fatal === null) socket?.close();

        uiRoot.update(state);
        twin.update(state);
        court?.renderView(state);

        // Animation derives from diffing (UIX §2.1). Each beat is queued so its
        // announcement waits for it — interface rule 8.
        const before = previous.table?.view ?? null;
        const after = state.table?.view ?? null;
        if (after !== null && before !== after) {
            const nameOf = (id: PlayerId) => state.table?.nicknames[id] ?? id;
            for (const event of diffSnapshots(before, after)) {
                // Both halves are exhaustive by construction — announce.ts and
                // beatForEvent. Silence is allowed, but it has to be chosen.
                const line = announcementFor(event, nameOf);
                const beat = beatForEvent(event);
                if (line === null && beat === null) continue;

                // The animation is the promise the queue awaits, which is what
                // makes interface rule 8 real: the announcement is released
                // only once the table has actually shown the thing.
                queue.enqueue({
                    ...(beat === null
                        ? {}
                        : { animate: () => court?.playBeat(beat, beatContext(event)) ?? Promise.resolve() }),
                    ...(line === null ? {} : { announce: line })
                });
            }
        }

        previous = state;
    });

    // UIX §5: coming back to a backgrounded tab, ask rather than trust a stale view.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || matchId === null) return;
        socket?.send({ type: 'REQUEST_RESYNC', matchId });
    });

    uiRoot.update(store.getState());
    twin.update(store.getState());
}

document.addEventListener('DOMContentLoaded', boot);
