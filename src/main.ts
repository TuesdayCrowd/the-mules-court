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
import './client/styles/table.css';

import type { CardInstanceId, CardTypeId, PlayerId, RedactedView } from './game/engine';
import { cardTypeOf } from './game/engine';
import type { PresentationEvent } from './client/store/diff';
import { announcementForViewer } from './client/content/announce';
import { PERSONAL_NOTICE_MS } from './client/content/personalNotice';
import { cardLabel } from './client/content/cardCopy';
import { failureCopy } from './client/content/failureCopy';
import { diffSnapshots } from './client/store/diff';
import { beatForEvent } from './client/store/motion';
import { ambienceFor, soundForEvent, soundForNotice, soundForTurnStart } from './client/store/sound';
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
import { createActionSheet } from './client/ui/actionSheet';
import type { SheetRequest, SheetTarget } from './client/ui/actionSheet';
import { createClipboard } from './client/ui/clipboard';
import { createCardHint } from './client/ui/cardHint';
import { createEliminationNotice } from './client/ui/eliminationNotice';
import { createConnectionDot } from './client/ui/connectionDot';
import { createFatalScreen } from './client/ui/fatalScreen';
import { createJoinScreen } from './client/ui/joinScreen';
import { createLobbyScreen } from './client/ui/lobbyScreen';
import { createMenuScreen } from './client/ui/menuScreen';
import { createOverlays } from './client/ui/overlays';
import { createReferenceDock } from './client/ui/referenceDock';
import { createSeatDossier } from './client/ui/seatDossier';
import { playDealCues } from './client/ui/dealCues';
import { createSoundPlayer } from './client/ui/sound';
import { createSoundToggle } from './client/ui/soundToggle';
import { REAL_TIMERS } from './client/ui/surface';
import { createToasts } from './client/ui/toasts';
import { createUiRoot } from './client/ui/uiRoot';
import { assetUrl, createTable } from './client/ui/table';
import { createBeatRunner } from './client/ui/beats';
import type { BeatContext } from './client/ui/beats';
import { CARD_BACK_ASSET, portraitPath } from './client/content/portraits';
import { RESIZE_DEBOUNCE_MS, panelSafeTop } from './client/layout/tableMetrics';

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
    const referenceDock = createReferenceDock({
        storage: window.localStorage,
        /**
         * Where the dock may start without covering a seat.
         *
         * Clamped here rather than inside the surface: the clamp needs the
         * viewport height, and this file is the one that owns ambient globals.
         * Read fresh on every render, so a resize moves the panel with the seats.
         */
        safeTop: () => {
            const drawn = table.currentLayout();
            return drawn === null ? null : panelSafeTop(drawn.opponentsBottom, window.innerHeight);
        }
    });
    const cardHint = createCardHint({ viewport: () => ({ w: window.innerWidth, h: window.innerHeight }) });
    const eliminationNotice = createEliminationNotice();

    /**
     * The table's voice.
     *
     * `createContext` is a factory and is called at most once — a bare
     * `new AudioContext()` here would run at page load, which browsers answer
     * with a console warning and a context that is suspended forever. If the
     * constructor does not exist at all (an old browser, a locked-down webview)
     * the throw is caught inside the player and the game simply stays silent.
     *
     * `gestures` is the document, and it is what makes the game audible on iOS:
     * every `sound.play` below runs from a socket frame or a queued microtask,
     * never inside a tap, and WebKit resumes a context only from within a
     * gesture. The player registers its own one-shot unlock listener there.
     */
    const sound = createSoundPlayer({
        createContext: () => new AudioContext(),
        gestures: document,
        storage: window.localStorage,
        random: () => Math.random(),
        /**
         * Where the recordings come from.
         *
         * `assetUrl` for the same reason every image on the table uses it: a
         * relative path resolves against `/join/:matchId` on a real invite link,
         * which the SPA fallback answers with `index.html` and a 200 — so the
         * decoder would be handed a page instead of audio and the game would
         * fall back to synthesis on exactly the URL most players arrive by.
         *
         * A non-OK response is turned into a throw rather than passed on, so it
         * lands in the same catch as a decode failure and gets the same answer.
         */
        loadAudio: async path => {
            const response = await fetch(assetUrl(path));
            if (!response.ok) throw new Error(`sfx ${path}: ${response.status}`);
            return response.arrayBuffer();
        }
    });

    uiRoot.add(createConnectionDot());
    uiRoot.add(createSoundToggle({ sound }));
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
            onAddBot: (seat, difficulty) =>
                socket?.send({ type: 'ADD_BOT', matchId: matchId as string, seat, difficulty }),
            onRemoveBot: seat => socket?.send({ type: 'REMOVE_BOT', matchId: matchId as string, seat }),
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
    /**
     * The toast region, which for its whole life was constructed and then never
     * mounted.
     *
     * `createToasts` was wired correctly — `failureCopy` for the copy,
     * `store.dismissNotice` for the dismissal, and `main.ts` calling `show` from
     * five places — but the surface was never handed to `uiRoot`, and `uiRoot.add`
     * is the only thing that calls `mount`. So every narration line and every
     * server refusal has been written into an element detached from the document.
     *
     * That is the actual reason a player targeted by a value-5 had to open the
     * match log to find out: the sentence was being produced correctly and
     * rendered into nothing.
     *
     * `ui.css` gives the strip an explicit z-index rather than relying on the
     * position of this line, so the stacking order is stated where the rest of
     * the ladder is stated and does not depend on mount order.
     */
    uiRoot.add(toasts);
    uiRoot.add(referenceDock);
    uiRoot.add(cardHint);
    uiRoot.add(eliminationNotice);
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

    // --- the table
    //
    // DOM, not a canvas. Three modules went away with the renderer rather than
    // being ported, because each existed only to pay for one:
    //
    //  - `renderPolicy.ts`, a pump that stopped Phaser's loop when nothing
    //    moved. Its own words: "Phaser renders every frame, unconditionally …
    //    no dirty check anywhere in the path." The browser's compositor has
    //    that dirty check, so there is no loop to stop and nothing to wake.
    //  - `inputPolicy.ts`, which turned `windowEvents` off so a tap on the DOM
    //    layer stopped also hit-testing the canvas underneath. There is no
    //    second hit-test layer now; the seam it patched cannot occur.
    //  - `a11yTwin.ts`, an offscreen shadow of focusable proxies for canvas
    //    cards. The cards ARE buttons here, so the proxy and the thing it
    //    proxied are one object. Keeping both would announce every seat twice.
    //
    // Full reasoning: `docs/plans/2026-07-30-renderer-architecture-research.md`.
    const container = document.getElementById('game-container') as HTMLElement;

    const table = createTable({
        onCardSelected: id => openSheetFor(id),
        // Hover on a pointer device, long-press on touch. Both are enhancements
        // — UIX §349 keeps hover out of the critical path — so the hint stays a
        // separate surface the table only signals, never a state it holds.
        onCardHinted: (cardId, at) => cardHint.show(cardId, at),
        onCardHintCleared: () => cardHint.hide(),
        // UIX §6.2. The dossier is supplementary detail — every value it holds
        // is already legible on the chip — but it is the only place the pile
        // appears in play order with card names, and the match log with it.
        onSeatSelected: id => seatDossier.open(id),
        // A devotion token IS a round won, so tapping one opens the log at that
        // round — the most recent the seat took, which is the token that just
        // landed. Without this the round's narration is gone the moment the next
        // is dealt, which is what the engine's roundHistory now prevents.
        onTokensSelected: id => {
            const history = store.getState().table?.view.roundHistory ?? [];
            const won = history.filter(round => round.winnerIds.includes(id));
            const latest = won[won.length - 1];
            referenceDock.open('log', ...(latest === undefined ? [] : [{ round: latest.roundNumber }]));
        },
        viewport: () => ({ w: window.innerWidth, h: window.innerHeight }),
        timers
    });
    table.mount(container);

    /**
     * Where the beats draw.
     *
     * Its own element rather than the table's, so a beat can never leave a
     * stray node inside the thing `update()` rebuilds — and so `destroy()` can
     * clear every transient at once. Above the table and below `#ui-root`,
     * taking no pointer events: a beat is something you watch, never something
     * you touch.
     */
    const beatLayer = document.createElement('div');
    beatLayer.className = 'beat-layer';
    container.appendChild(beatLayer);

    const beats = createBeatRunner(beatLayer, {
        // Read per beat, never cached: a player can change the system setting
        // mid-session and the next beat has to obey it (UIX §8.5).
        reducedMotion: () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        viewport: () => ({ w: window.innerWidth, h: window.innerHeight }),
        tableRoot: () => container
    });

    // The table follows the viewport, so a resize has to redraw it. Debounced
    // by the same reasoning the scene used: long enough to ride out an iOS
    // toolbar collapse, short enough to feel immediate.
    let resizeHandle: ReturnType<typeof setTimeout> | null = null;
    window.addEventListener('resize', () => {
        if (resizeHandle !== null) clearTimeout(resizeHandle);
        resizeHandle = setTimeout(() => {
            resizeHandle = null;
            table.update(store.getState());
            // After the table, never before: the dock reads the layout the table
            // just recomputed, so refreshing it first would inset the panel to
            // the seat band's OLD position.
            referenceDock.update(store.getState());
        }, RESIZE_DEBOUNCE_MS);
    });


    /**
     * Where a beat plays and what art it shows.
     *
     * Assembled here because it needs the live layout, which only the table
     * has; the beat itself takes a rect and an image URL and knows nothing
     * about seats or cards.
     *
     * `portraitKey` keeps its name from the Phaser original but no longer means
     * a texture key — there is no atlas to look one up in. It is an `<img src>`
     * now, built through `assetUrl` so there is exactly one definition of the
     * loader root.
     *
     * The snapshot is deliberately NOT called `table`: that name belongs to the
     * surface in this scope, and shadowing it here would silently point
     * `currentLayout()` at a `ClientState` field instead.
     */
    function beatContext(event: PresentationEvent): BeatContext {
        const snapshot = store.getState().table;
        const spec = table.currentLayout();
        const nameOf = (id: PlayerId) => snapshot?.nicknames[id] ?? id;

        if (event.kind === 'peek-gained') {
            return {
                portraitKey: assetUrl(portraitPath(event.cardTypeId)),
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
        if (event.kind === 'round-over' && snapshot !== null && spec !== null) {
            const winner = event.result.winnerIds[0];
            if (winner === undefined) return {};
            if (winner === snapshot.view.own.playerId) return { rect: spec.ownStatus };

            const opponents = snapshot.view.players.filter(p => p.id !== snapshot.view.own.playerId);
            const index = opponents.findIndex(p => p.id === winner);
            return index >= 0 ? { rect: spec.opponents[index] } : {};
        }

        // A card leaving the deck for a hand (UIX §8). Two rects, not one:
        // where from and where to. The deck is where every dealt card starts;
        // the destination is the viewer own hand slot or the opponent seat chip.
        if (event.kind === 'card-drawn' && snapshot !== null && spec !== null) {
            const isOwn = event.seatId === snapshot.view.own.playerId;

            // The face for your own draw, the card BACK for anyone else
            // (interface rule 4) — which is also why `card-drawn` carries no
            // `cardTypeId` for an opponent for this to reach for.
            const portraitKey =
                event.cardTypeId === undefined ? assetUrl(CARD_BACK_ASSET) : assetUrl(portraitPath(event.cardTypeId));

            // The drawn card is the one that joins the hand, so it lands in the
            // last slot the layout reserved.
            const opponents = snapshot.view.players.filter(p => p.id !== snapshot.view.own.playerId);
            const index = opponents.findIndex(p => p.id === event.seatId);
            const destination = isOwn ? spec.hand[spec.hand.length - 1] : spec.opponents[index];
            if (destination === undefined) return {};

            return { fromRect: spec.deck, rect: destination, portraitKey };
        }

        if (event.kind === 'log' && snapshot !== null && spec !== null) {
            // Bound to a local: narrowing `event.entry.kind` inside a compound
            // condition does not survive repeated access to a union member.
            const entry = event.entry;
            if (entry.kind !== 'ELIMINATED') return {};

            const opponents = snapshot.view.players.filter(p => p.id !== snapshot.view.own.playerId);
            const index = opponents.findIndex(p => p.id === entry.playerId);
            const rect = index >= 0 ? spec.opponents[index] : undefined;

            // The flip IS the information (UIX §8.2), so it has to have a card.
            // `revealedHands` cannot supply one: it is populated on deck-out
            // alone, and a deck-out eliminates nobody — so reading it here gave
            // every elimination beat an undefined portrait and `flip()` returned
            // without drawing. The card is on the victim's own discard pile,
            // pushed there by `eliminate()` before this entry was ever logged.
            const held = topOfPile(snapshot.view.players.find(p => p.id === entry.playerId));

            // The Mule's loom is the one beat whose face is a rule rather than
            // a lookup: `cause` already says which card did this.
            const mule = entry.cause === 'mule-voluntary' || entry.cause === 'mule-forced';
            const portraitKey = mule ? assetUrl(portraitPath('mule')) : held === null ? undefined : assetUrl(portraitPath(held));

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
        // Named for what it is, and deliberately not `table`: that name belongs
        // to the table SURFACE in the enclosing scope, and shadowing it here is
        // what hid `currentLayout()` from this function.
        const snapshot = store.getState().table;
        if (snapshot === null) return null;

        const targets: SheetTarget[] | null = sheetTargetsFor(
            snapshot.view,
            cardInstanceId,
            id => snapshot.nicknames[id] ?? id
        );
        if (targets === null) return null;

        // Spread rather than assigned, because `exactOptionalPropertyTypes` and
        // an absent reason are the same fact: the card plays.
        const reason = unplayableReason(snapshot.view, cardInstanceId);
        const drawn = table.currentLayout();

        return {
            cardId: cardTypeOf(cardInstanceId),
            cardInstanceId,
            targets,
            ...(reason === undefined ? {} : { unplayable: reason }),
            available: { w: window.innerWidth, h: window.innerHeight },
            /**
             * Read off the table's own spec rather than recomputed here.
             *
             * `currentLayout()` exists for exactly this — asking the table what
             * it last drew, instead of calling `computeLayout` a second time
             * with inputs that could drift from the ones the table used and
             * insetting the sheet to a line the seats are not actually on.
             */
            ...(drawn === null ? {} : { safeTop: drawn.opponentsBottom })
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
    const queue = createPresentationQueue({
        announce: (line, kind) =>
            toasts.show(line, kind === 'personal' ? { kind, timeoutMs: PERSONAL_NOTICE_MS } : { kind })
    });
    let previous: ClientState = store.getState();

    /**
     * The staggered deal's remaining swishes, cancellable.
     *
     * Held here rather than dropped, because the deal outlives the push that
     * started it: a fatal, a walk back to the menu or the round ending mid-deal
     * used to leave timeouts firing card sounds over a screen with no table.
     */
    let stopDealCues: (() => void) | null = null;
    function cancelDealCues(): void {
        stopDealCues?.();
        stopDealCues = null;
    }

    store.subscribe(state => {
        // A FATAL means stop retrying. The server closed the socket on purpose,
        // and reconnecting into SEAT_TAKEN makes two tabs evict each other
        // forever — verified against the real server at 22 evictions in three
        // seconds. Only "Take over here" reopens it.
        if (state.fatal !== null && previous.fatal === null) socket?.close();

        /**
         * A deal in flight belongs to a table that is still there.
         *
         * The wall, the walk back to the menu and the end of a round all leave
         * the remaining swishes describing cards nobody can see any more.
         */
        const roundJustEnded =
            (state.table?.view.roundResult ?? null) !== null && (previous.table?.view.roundResult ?? null) === null;
        if (state.fatal !== null || state.table === null || roundJustEnded) cancelDealCues();

        /**
         * The bed under the table, reconciled on every push.
         *
         * Safe to call this often because `setAmbience` is idempotent by name —
         * the alternative, tracking the previous screen here, would put the
         * decision in two places and let them disagree. `ambienceFor` is the one
         * that decides; this line only reports where the player is.
         */
        sound.setAmbience(ambienceFor(state.screen, state.table?.view ?? null));

        uiRoot.update(state);

        /**
         * The table is now one update rather than two.
         *
         * It used to be the scene and then its offscreen twin, in that order,
         * and the order was load-bearing: the twin positioned its hand proxies
         * from `currentLayout()`, which only the scene's render set, so
         * updating it first handed a keyboard or screen-reader player the
         * PREVIOUS push's layout — an empty hand on the first deal, measured in
         * a browser. Real buttons cannot desynchronise from themselves, so the
         * ordering hazard is gone with the twin that created it.
         */
        table.update(state);

        // After uiRoot, which is what tells the sheet about the connection and
        // the screen. This adds the half uiRoot cannot: the sheet's request is
        // assembled here, so only here can it be reassembled.
        resyncOpenSheet(state);

        /**
         * A refusal answers the player's own input, so it is the one sound that
         * is NOT queued behind the beats.
         *
         * Everything else in this subscriber describes something that happened
         * at the table and can afford to wait its turn. "That did not happen"
         * is feedback about a tap, and feedback that arrives after a second of
         * choreography has stopped being feedback. `minIntervalMs` is what keeps
         * a burst of refusals to one chirp — see `store/sound.ts`.
         */
        const heard = new Set(previous.notices.map(notice => notice.id));
        for (const notice of state.notices) {
            if (!heard.has(notice.id)) sound.play(soundForNotice(notice.code));
        }

        // Animation derives from diffing (UIX §2.1). Each beat is queued so its
        // announcement waits for it — interface rule 8.
        const before = previous.table?.view ?? null;
        const after = state.table?.view ?? null;
        if (after !== null && before !== after) {
            const nameOf = (id: PlayerId) => state.table?.nicknames[id] ?? id;
            const viewerId = after.own.playerId;
            const events = diffSnapshots(before, after);

            // Every card dealt in the same push is ONE queued step, flown
            // together on a stagger, rather than one step each.
            //
            // The queue serialises what it holds — that is its whole job
            // (interface rule 8) — so four separate deals at the start of a
            // round would be four consecutive flights and over a second of
            // choreography before anybody can act. Staggered instead, the
            // whole deal lands inside `dealSequenceMs`: five cards read as
            // dealing, and the player waits half a second, not a second.
            const dealt = events.filter(event => event.kind === 'card-drawn');
            let dealQueued = false;

            for (const event of events) {
                // All three halves are exhaustive by construction — announce.ts,
                // beatForEvent and soundForEvent. Silence is allowed, but it has
                // to be chosen.
                /**
                 * What to say and which channel says it — second person when it
                 * happened to this viewer, painted third person when two other
                 * seats exchanged a guess, clipped third person otherwise.
                 *
                 * Both halves come back together from one pure call, and both
                 * enqueue sites below read the same pair. They were a ternary
                 * here, twice; `content/announce.ts` says why that was the wrong
                 * file for a decision.
                 */
                const announcement = announcementForViewer(event, viewerId, nameOf);
                const line = announcement?.line ?? null;
                const beat = beatForEvent(event);
                const cue = soundForEvent(event);
                if (line === null && beat === null && cue === null) continue;

                if (event.kind === 'card-drawn') {
                    // Beat and cue are independent, as the guard above just
                    // established — so the deal's sound is not nested inside the
                    // existence of its beat. A vocabulary that kept its swish
                    // after losing its flight would otherwise go silent.
                    if (!dealQueued && (beat !== null || cue !== null)) {
                        dealQueued = true;
                        queue.enqueue({
                            animate: () => {
                                // One swish per card, on the SAME offsets the
                                // cards fly on — `playDealCues` reads them from
                                // `dealDelayMs` rather than recomputing them,
                                // cap included. Fired in a synchronous loop
                                // instead they would share one context timestamp
                                // and `deal`'s minimum interval would collapse
                                // the whole deal to a single swish.
                                cancelDealCues();
                                if (cue !== null) {
                                    stopDealCues = playDealCues({
                                        count: dealt.length,
                                        cue,
                                        play: name => sound.play(name),
                                        timers
                                    });
                                }

                                if (beat === null) return undefined;
                                return Promise.all(
                                    dealt.map((card, index) =>
                                        beats.run(beat, { ...beatContext(card), staggerIndex: index })
                                    )
                                ).then(() => undefined);
                            }
                        });
                    }

                    // A dealt card is deliberately silent (announce.ts says
                    // why). If that judgement ever changes, the line still gets
                    // out rather than being swallowed by the grouping above.
                    if (announcement !== null) queue.enqueue({ announce: announcement.line, announceKind: announcement.kind });
                    continue;
                }

                // The animation is the promise the queue awaits, which is what
                // makes interface rule 8 real: the announcement is released
                // only once the table has actually shown the thing.
                queue.enqueue({
                    // The context is assembled when the beat RUNS, not when it
                    // is queued: the queue holds a beat until the one before it
                    // finishes, by which time the layout may have moved under a
                    // resize, and a rect measured at queue time would place it
                    // where the seat used to be.
                    //
                    // The sound rides the same step rather than a step of its
                    // own, and starts with it: a sound belongs WITH its beat,
                    // and one queued ahead of the beat would describe something
                    // the table has not drawn yet.
                    ...(beat === null && cue === null
                        ? {}
                        : {
                              animate: () => {
                                  if (cue !== null) sound.play(cue);
                                  return beat === null ? undefined : beats.run(beat, beatContext(event));
                              }
                          }),
                    ...(announcement === null ? {} : { announce: announcement.line, announceKind: announcement.kind })
                });
            }

            /**
             * "It is your turn", last.
             *
             * Not a `PresentationEvent` — `soundForTurnStart` explains why — and
             * queued behind the beats rather than played from here, so a player
             * hears what just happened to the table before being told it is on
             * them. It has no beat and no announcement: the table's own current-
             * seat ring is the visible half, and the `aria-live` channel already
             * carries the play that ended the last turn.
             */
            const turnCue = soundForTurnStart(before, after);
            if (turnCue !== null) queue.enqueue({ animate: () => sound.play(turnCue) });
        }

        previous = state;
    });

    // UIX §5: coming back to a backgrounded tab, ask rather than trust a stale view.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || matchId === null) return;
        socket?.send({ type: 'REQUEST_RESYNC', matchId });
    });

    uiRoot.update(store.getState());
    table.update(store.getState());
}

document.addEventListener('DOMContentLoaded', boot);
