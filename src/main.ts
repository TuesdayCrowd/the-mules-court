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

import type { CardInstanceId, CardTypeId, PlayerId, RedactedView } from './game/engine';
import { cardTypeOf } from './game/engine';
import type { PresentationEvent } from './client/store/diff';
import { announcementFor } from './client/content/announce';
import { cardCopyFor, cardLabel } from './client/content/cardCopy';
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
import { sheetTargetsFor, unplayableReason } from './client/store/targets';
import type { ClientState } from './client/store/types';
import { createA11yTwin } from './client/ui/a11yTwin';
import { createActionSheet } from './client/ui/actionSheet';
import type { SheetRequest, SheetTarget } from './client/ui/actionSheet';
import { createClipboard } from './client/ui/clipboard';
import { createCardHint } from './client/ui/cardHint';
import { createConnectionDot } from './client/ui/connectionDot';
import { createFatalScreen } from './client/ui/fatalScreen';
import { createJoinScreen } from './client/ui/joinScreen';
import { createLobbyScreen } from './client/ui/lobbyScreen';
import { createMenuScreen } from './client/ui/menuScreen';
import { createOverlays } from './client/ui/overlays';
import { createReferenceDock } from './client/ui/referenceDock';
import { createSeatDossier } from './client/ui/seatDossier';
import { REAL_TIMERS } from './client/ui/surface';
import { createToasts } from './client/ui/toasts';
import { createUiRoot } from './client/ui/uiRoot';
import { CARD_HINTED, CARD_HINT_CLEARED, CARD_SELECTED, SEAT_SELECTED, TOKENS_SELECTED } from './game/scenes/Court';
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

/**
 * The card showing on top of a seat's discard pile, if any.
 *
 * `eliminate()` pushes the whole hand there before it logs the elimination, so
 * for a seat that has just gone out this is what they held.
 */
function topOfPile(seat: RedactedView['players'][number] | undefined): CardTypeId | null {
    const pile = seat?.discardPile ?? [];
    return pile.length === 0 ? null : pile[pile.length - 1].cardId;
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
    // The dock remembers whether it was up and which tab was showing, so it
    // needs the same storage the seat token uses — injected, never reached for.
    const referenceDock = createReferenceDock({ storage: window.localStorage });
    const cardHint = createCardHint({ viewport: () => ({ w: window.innerWidth, h: window.innerHeight }) });

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
            onEndMatch: () => socket?.send({ type: 'END_MATCH', matchId: matchId as string }),
            // A whole navigation rather than a state change: the seat, the
            // socket and the stored token all belong to this match, and the
            // menu is a different route (UIX §2.6). Reloading at `/` is the
            // honest way to leave, and matches what the fatal screen does.
            onBackToMenu: () => location.assign('/')
        })
    );
    uiRoot.add(referenceDock);
    uiRoot.add(cardHint);
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
        // Hover on a pointer device, long-press on touch. Both are enhancements
        // — UIX §349 keeps hover out of the critical path — so the hint is a
        // DOM surface the scene only signals, never a state it holds. draw()
        // destroys every interactive object on each STATE_UPDATE.
        court.events.on(CARD_HINTED, (cardId: CardTypeId, at: { x: number; y: number }) =>
            cardHint.show(cardId, at)
        );
        court.events.on(CARD_HINT_CLEARED, () => cardHint.hide());
        // UIX §6.2. The dossier is supplementary detail — every value it holds
        // is already legible on the chip — but it is the only place the pile
        // appears in play order with card names, and the match log with it.
        court.events.on(SEAT_SELECTED, (id: PlayerId) => seatDossier.open(id));
        // A devotion token IS a round won, so tapping one opens the log at that
        // round — the most recent the seat took, which is the token that just
        // landed. Without this the round's narration is gone the moment the next
        // is dealt, which is what the engine's roundHistory now prevents.
        court.events.on(TOKENS_SELECTED, (id: PlayerId) => {
            const history = store.getState().table?.view.roundHistory ?? [];
            const won = history.filter(round => round.winnerIds.includes(id));
            const latest = won[won.length - 1];
            referenceDock.open('log', ...(latest === undefined ? [] : [{ round: latest.roundNumber }]));
        });
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
                // The caption sits under the portrait, so it labels a card face
                // and takes the value-first form the faces use. Without it the
                // reveal is art alone — the one moment the table shows a card
                // only you may see, and it would not say which card.
                label: `Only you see this — ${nameOf(event.subjectId)} holds ${cardLabel(event.cardTypeId)}`
            };
        }

        // UIX §9.1: the medallion drifts onto the winner's seat. The viewer's
        // own award lands on the own-status row, which is where their tokens
        // actually are — a shimmer over an empty rect would say nothing.
        if (event.kind === 'round-over' && table !== null && spec !== null) {
            const winner = event.result.winnerIds[0];
            if (winner === undefined) return {};
            if (winner === table.view.own.playerId) return { rect: spec.ownStatus };

            const opponents = table.view.players.filter(p => p.id !== table.view.own.playerId);
            const index = opponents.findIndex(p => p.id === winner);
            return index >= 0 ? { rect: spec.opponents[index] } : {};
        }

        if (event.kind === 'log' && table !== null && spec !== null) {
            // Bound to a local: narrowing `event.entry.kind` inside a compound
            // condition does not survive repeated access to a union member.
            const entry = event.entry;
            if (entry.kind !== 'ELIMINATED') return {};

            const opponents = table.view.players.filter(p => p.id !== table.view.own.playerId);
            const index = opponents.findIndex(p => p.id === entry.playerId);
            const rect = index >= 0 ? spec.opponents[index] : undefined;

            // The flip IS the information (UIX §8.2), so it has to have a card.
            // `revealedHands` cannot supply one: it is populated on deck-out
            // alone, and a deck-out eliminates nobody — so reading it here gave
            // every elimination beat an undefined portrait and `flip()` returned
            // without drawing. The card is on the victim's own discard pile,
            // pushed there by `eliminate()` before this entry was ever logged.
            const held = topOfPile(table.view.players.find(p => p.id === entry.playerId));

            // The Mule's loom is the one beat whose face is a rule rather than
            // a lookup: `cause` already says which card did this.
            const mule = entry.cause === 'mule-voluntary' || entry.cause === 'mule-forced';
            const portraitKey = mule ? cardCopyFor('mule').portraitKey : held === null ? undefined : cardCopyFor(held).portraitKey;

            return {
                ...(rect === undefined ? {} : { rect }),
                ...(portraitKey === undefined ? {} : { portraitKey }),
                label: `${nameOf(entry.playerId)} is out`
            };
        }

        return {};
    }

    /**
     * Assembled by `sheetTargetsFor`. The sheet renders what it is handed and
     * evaluates nothing.
     *
     * Wrapped, because this handler is the ONLY way into the action sheet and a
     * throw inside it is completely silent: the tap lands, nothing opens, and no
     * card on the table can be opened afterwards either. That is precisely how a
     * one-field version skew presented — as "cards stopped being clickable".
     * Whatever goes wrong here, say so.
     */
    function openSheetFor(cardInstanceId: CardInstanceId): void {
        try {
            openSheetOrThrow(cardInstanceId);
        } catch (error) {
            console.error('[court] could not open the action sheet', error);
            toasts.show('Could not open that card. Reload if it keeps happening.');
        }
    }

    /**
     * The sheet's whole input, from the current table.
     *
     * Assembled here rather than inside the sheet because the sheet evaluates no
     * rule about the game — and assembled fresh on every state push rather than
     * once at open, because a card opened while waiting has to become playable
     * the moment the turn arrives.
     *
     * `null` means the view could not answer.
     */
    function sheetRequestFor(cardInstanceId: CardInstanceId): SheetRequest | null {
        const table = store.getState().table;
        if (table === null) return null;

        const targets: SheetTarget[] | null = sheetTargetsFor(
            table.view,
            cardInstanceId,
            id => table.nicknames[id] ?? id
        );
        if (targets === null) return null;

        // Spread rather than assigned, because `exactOptionalPropertyTypes` and
        // an absent reason are the same fact: the card plays.
        const reason = unplayableReason(table.view, cardInstanceId);

        return {
            cardId: cardTypeOf(cardInstanceId),
            cardInstanceId,
            targets,
            ...(reason === undefined ? {} : { unplayable: reason }),
            available: { w: window.innerWidth, h: window.innerHeight }
        };
    }

    function openSheetOrThrow(cardInstanceId: CardInstanceId): void {
        // The sheet states this card's effect itself, so a hint over it would be
        // the same sentence twice in two places.
        cardHint.hide();

        // No table is not a version skew, and must not be reported as one. Two
        // meanings behind one `null` is the mistake `sheetTargetsFor` exists to
        // stop the client making about targeting; it is no better here.
        if (store.getState().table === null) return;

        const request = sheetRequestFor(cardInstanceId);

        // The view could not say who is targetable. Refusing to open is the only
        // honest option: the sheet's other branch would announce "every other
        // player is protected or eliminated", which is a rule of the game and
        // would be a lie. Say what is actually wrong instead.
        if (request === null) {
            toasts.show('The court is running an older version of the game. Reload the page.');
            return;
        }

        actionSheet.open(request);
    }

    /**
     * Hand an open sheet the state it is now in.
     *
     * The sheet decides whether anything actually changed; this only has to
     * offer. A sheet whose card has left the hand — played, traded, redrawn —
     * gets closed rather than refreshed, because there is no longer a play to
     * compose.
     */
    function resyncOpenSheet(state: ClientState): void {
        const showing = actionSheet.showing();
        if (showing === null) return;

        if (state.table === null || !state.table.view.own.hand.includes(showing)) {
            actionSheet.close();
            return;
        }

        const request = sheetRequestFor(showing);
        if (request !== null) actionSheet.refresh(request);
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

        // After uiRoot, which is what tells the sheet about the connection and
        // the screen. This adds the half uiRoot cannot: the sheet's request is
        // assembled here, so only here can it be reassembled.
        resyncOpenSheet(state);

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
