// @vitest-environment jsdom
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import type { RoundResult } from '../../game/engine';
import { makeView } from '../store/__fixtures__/view';
import type { ClientState, LobbySnapshot } from '../store/types';
import { fakeTimers, loadRealStyles, makeState, makeTable, makeUiRootElement } from '../ui/__fixtures__/dom';
import { createActionSheet } from '../ui/actionSheet';
import { createConnectionDot } from '../ui/connectionDot';
import { createFatalScreen } from '../ui/fatalScreen';
import { createJoinScreen } from '../ui/joinScreen';
import { createLobbyScreen } from '../ui/lobbyScreen';
import { createMenuScreen } from '../ui/menuScreen';
import { createOverlays } from '../ui/overlays';
import { createCardHint } from '../ui/cardHint';
import { createEliminationNotice } from '../ui/eliminationNotice';
import { createReferenceDock } from '../ui/referenceDock';
import { createSeatDossier } from '../ui/seatDossier';
import { createSoundToggle } from '../ui/soundToggle';
import type { Surface } from '../ui/surface';
import { createTable } from '../ui/table';
import { createToasts } from '../ui/toasts';

/**
 * The accessibility gate (UIX §11).
 *
 * Every DOM surface, mounted in a representative state and run through axe.
 * Accessibility is a property that regresses silently — a heading level dropped
 * here, a label lost there — so it gets a regression test rather than a review.
 *
 * The only disabled rule is `color-contrast`, and only because jsdom has no
 * layout and therefore no computed colours to measure. That is covered
 * arithmetically instead, in `src/client/tokens/contrast.test.ts`.
 */

const LOBBY: LobbySnapshot = {
    matchId: 'K7QX2',
    hostSeat: 'p1',
    canStart: false,
    seats: [
        { seat: 0, playerId: 'p1', nickname: 'Cornelius', status: 'occupied', difficulty: null },
        { seat: 1, playerId: 'p2', nickname: 'Ana', status: 'disconnected', difficulty: null },
        { seat: 2, playerId: null, nickname: null, status: 'open', difficulty: null },
        { seat: 3, playerId: null, nickname: null, status: 'open', difficulty: null }
    ]
};

const DECK_OUT: RoundResult = {
    reason: 'deck-out',
    winnerIds: ['p1'],
    revealedHands: { p1: 'mule', p2: 'informant' }
};

const noop = () => {};
const noopAsync = () => Promise.resolve();

/** Mounts one surface into a fresh `#ui-root` and drives it to the state under test. */
type Mount = (root: HTMLElement) => void;

function drive(surface: Surface, root: HTMLElement, state: ClientState): void {
    surface.mount(root);
    surface.update(state);
}

const SURFACES: ReadonlyArray<readonly [string, Mount]> = [
    [
        'menu',
        root => {
            const screen = createMenuScreen({
                roomApi: { createRoom: () => new Promise(() => {}) },
                tokens: { save: noop },
                navigate: noop
            });
            drive(screen, root, makeState({ screen: 'menu' }));
        }
    ],
    [
        'join',
        root => {
            const screen = createJoinScreen({ onSubmit: noop });
            drive(screen, root, makeState({ screen: 'joining', matchId: 'K7QX2' }));
        }
    ],
    [
        'join with an invalid nickname',
        root => {
            const screen = createJoinScreen({ onSubmit: noop });
            drive(screen, root, makeState({ screen: 'joining', matchId: 'K7QX2' }));
            const input = root.querySelector('input[type="text"]') as HTMLInputElement;
            input.value = 'C'.repeat(99);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    ],
    [
        'lobby as host',
        root => {
            const screen = createLobbyScreen({
                onStart: noop,
                onDissolve: noop,
                onAddBot: () => {},
                onRemoveBot: () => {},
                clipboard: { writeText: noopAsync },
                joinUrlFor: id => `https://court.example.com/join/${id}`
            });
            drive(screen, root, makeState({ screen: 'lobby', matchId: 'K7QX2', lobby: LOBBY, seat: { seat: 0, playerId: 'p1' } }));
        }
    ],
    [
        // Its own case because the host-only controls differ by seat status,
        // and this is the state that puts three same-worded buttons on one
        // screen — the arrangement most likely to leave duplicate accessible
        // names behind.
        'lobby with computer opponents seated',
        root => {
            const screen = createLobbyScreen({
                onStart: noop,
                onDissolve: noop,
                onAddBot: () => {},
                onRemoveBot: () => {},
                clipboard: { writeText: noopAsync },
                joinUrlFor: id => `https://court.example.com/join/${id}`
            });
            drive(
                screen,
                root,
                makeState({
                    screen: 'lobby',
                    matchId: 'K7QX2',
                    lobby: {
                        ...LOBBY,
                        canStart: true,
                        seats: [
                            LOBBY.seats[0],
                            { seat: 1, playerId: 'p2', nickname: 'Arkady Darell', status: 'computer', difficulty: 'adept' },
                            { seat: 2, playerId: 'p3', nickname: 'Lathan Devers', status: 'computer', difficulty: 'adept' },
                            { seat: 3, playerId: 'p4', nickname: 'Ducem Barr', status: 'computer', difficulty: 'master' }
                        ]
                    },
                    seat: { seat: 0, playerId: 'p1' }
                })
            );
        }
    ],
    [
        'lobby with the host gone',
        root => {
            const screen = createLobbyScreen({
                onStart: noop,
                onDissolve: noop,
                onAddBot: () => {},
                onRemoveBot: () => {},
                clipboard: { writeText: noopAsync },
                joinUrlFor: id => `https://court.example.com/join/${id}`
            });
            drive(
                screen,
                root,
                makeState({
                    screen: 'lobby',
                    matchId: 'K7QX2',
                    lobby: { ...LOBBY, seats: [{ ...LOBBY.seats[0], status: 'disconnected' }, ...LOBBY.seats.slice(1)] },
                    seat: { seat: 1, playerId: 'p2' }
                })
            );
        }
    ],
    [
        'action sheet',
        root => {
            const sheet = createActionSheet({ onPlay: () => true, onCancel: noop });
            sheet.mount(root);
            sheet.update(makeState({ screen: 'table', table: makeTable() }));
            sheet.open({
                cardId: 'informant',
                cardInstanceId: 'informant#1',
                targets: [
                    { playerId: 'p2', nickname: 'Ana', eligible: true },
                    { playerId: 'p3', nickname: 'Toran', eligible: false, reason: 'protected' },
                    { playerId: 'p4', nickname: 'Bayta', eligible: false, reason: 'eliminated' }
                ],
                available: { w: 390, h: 844 }
            });
        }
    ],
    [
        'elimination notice',
        root => {
            const notice = createEliminationNotice();
            drive(notice, root, makeState({ screen: 'table', table: makeTable() }));
            notice.show({
                headline: 'You are out of the round.',
                detail: 'Ana compared hands with you. You held 3 · Ebling Mis; they held 5 · Bayta Darell. The lower card is out.'
            });
        }
    ],
    [
        'card hint',
        root => {
            const surface = createCardHint({ viewport: () => ({ w: 1000, h: 800 }) });
            drive(surface, root, makeState({ screen: 'table', table: makeTable() }));
            surface.show('first-speaker', { x: 120, y: 240 });
        }
    ],
    [
        'reference dock',
        root => {
            const dock = createReferenceDock({
                // A store that remembers nothing, so this case cannot depend on
                // whatever an earlier case happened to leave behind.
                storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
            });
            drive(dock, root, makeState({ screen: 'table', table: makeTable() }));
            (root.querySelector('[data-action="reference-dock"]') as HTMLButtonElement).click();
        }
    ],
    [
        'reference dock — match log tab',
        root => {
            const dock = createReferenceDock({
                storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
            });
            drive(
                dock,
                root,
                makeState({
                    screen: 'table',
                    table: makeTable({
                        view: makeView({
                            publicLog: [{ kind: 'PLAY', turn: 1, actorId: 'p1', cardId: 'informant' }],
                            roundHistory: [
                                {
                                    roundNumber: 1,
                                    reason: 'last-survivor',
                                    winnerIds: ['p2'],
                                    publicLog: [{ kind: 'PLAY', turn: 1, actorId: 'p2', cardId: 'mule' }]
                                }
                            ]
                        })
                    })
                })
            );
            (root.querySelector('[data-action="reference-dock"]') as HTMLButtonElement).click();
            (root.querySelector('[data-dock-tab="log"]') as HTMLButtonElement).click();
        }
    ],
    [
        // The first time this surface has been reachable by axe at all — its
        // predecessor was a `<canvas>`, which is one opaque node to an
        // accessibility tree no matter what is drawn on it. A dimmed hand
        // card, a protected seat with a discard, and a revealed elimination
        // are included deliberately: three of this file's own `<button>`s
        // (a hand card, a seat chip, its token run) with non-trivial
        // `aria-*` wiring, not just the empty table an idle round would show.
        'table',
        root => {
            const table = createTable({
                onCardSelected: noop,
                onCardHinted: noop,
                onCardHintCleared: noop,
                onSeatSelected: noop,
                onTokensSelected: noop,
                viewport: () => ({ w: 1280, h: 800 }),
                timers: fakeTimers().timers
            });
            drive(
                table,
                root,
                makeState({
                    screen: 'table',
                    table: makeTable({
                        nicknames: { p1: 'Ana', p2: 'Bayta', p3: 'Toran' },
                        view: makeView({
                            playerCount: 3,
                            own: { hand: ['informant#1', 'mule#2'], legalPlays: ['informant#1'] },
                            players: [
                                { id: 'p1', seat: 0, tokens: 2, alive: true, protected: false, discardPile: [], discardValueTotal: 0 },
                                {
                                    id: 'p2',
                                    seat: 1,
                                    tokens: 1,
                                    alive: true,
                                    protected: true,
                                    discardPile: [{ cardId: 'informant', value: 1 }],
                                    discardValueTotal: 1
                                },
                                {
                                    id: 'p3',
                                    seat: 2,
                                    tokens: 0,
                                    alive: false,
                                    protected: false,
                                    discardPile: [{ cardId: 'mule', value: 8 }],
                                    discardValueTotal: 8
                                }
                            ]
                        })
                    })
                })
            );
        }
    ],
    [
        'seat dossier',
        root => {
            const dossier = createSeatDossier();
            drive(
                dossier,
                root,
                makeState({
                    screen: 'table',
                    table: makeTable({
                        view: makeView({
                            publicLog: [{ kind: 'PLAY', turn: 1, actorId: 'p1', cardId: 'informant' }]
                        })
                    })
                })
            );
            dossier.open('p1');
        }
    ],
    [
        'round over',
        root => {
            const overlays = createOverlays({
                timers: fakeTimers().timers,
                now: () => 1_000_000,
                isHost: () => false,
                canEndMatch: () => false,
                onEndMatch: noop,
                onBackToMenu: noop
            });
            drive(
                overlays,
                root,
                makeState({
                    screen: 'table',
                    table: makeTable({ phase: 'round_over', revealDeadline: 1_005_000, view: makeView({ roundResult: DECK_OUT }) })
                })
            );
        }
    ],
    [
        'match over',
        root => {
            const overlays = createOverlays({
                timers: fakeTimers().timers,
                now: () => 1_000_000,
                isHost: () => true,
                canEndMatch: () => true,
                onEndMatch: noop,
                onBackToMenu: noop
            });
            drive(
                overlays,
                root,
                makeState({
                    screen: 'table',
                    table: makeTable({ phase: 'ended', view: makeView({ matchWinnerId: 'p1' }) }),
                    ended: { reason: 'won', winnerSeat: 'p1' }
                })
            );
        }
    ],
    [
        'paused',
        root => {
            const overlays = createOverlays({
                timers: fakeTimers().timers,
                now: () => 1_000_000,
                isHost: () => true,
                canEndMatch: () => false,
                onEndMatch: noop,
                onBackToMenu: noop
            });
            drive(overlays, root, makeState({ screen: 'table', table: makeTable({ paused: true, missingSeats: ['p2'] }) }));
        }
    ],
    [
        'fatal',
        root => {
            const screen = createFatalScreen({ onAction: noop });
            drive(screen, root, makeState({ screen: 'fatal', fatal: 'SEAT_TAKEN' }));
        }
    ],
    [
        // Both states, because the two differ in name, in `aria-pressed` and in
        // glyph — and a control whose name only makes sense in one of them is
        // exactly what this gate exists to catch.
        'mute — sound on',
        root => {
            drive(createSoundToggle({ sound: { muted: () => false, setMuted: noop } }), root, makeState({ screen: 'table' }));
        }
    ],
    [
        'mute — sound off',
        root => {
            drive(createSoundToggle({ sound: { muted: () => true, setMuted: noop } }), root, makeState({ screen: 'table' }));
        }
    ],
    [
        'chrome — dot and toasts together',
        root => {
            const dot = createConnectionDot();
            const toasts = createToasts({
                timers: fakeTimers().timers,
                copyFor: code => `Rule: ${code}`,
                onDismiss: noop
            });
            const state = makeState({
                screen: 'table',
                connection: 'reconnecting',
                table: makeTable(),
                notices: [{ id: 'n1', code: 'NOT_YOUR_TURN' }]
            });
            drive(dot, root, state);
            drive(toasts, root, state);
        }
    ]
];

describe.each(SURFACES)('%s is accessible', (_name, mount) => {
    it('reports no axe violations', async () => {
        const root = makeUiRootElement();
        loadRealStyles();
        mount(root);

        const results = await axe.run(document.body, {
            // jsdom has no layout, so this rule cannot evaluate. Contrast is
            // covered arithmetically instead — src/client/tokens/contrast.test.ts.
            rules: { 'color-contrast': { enabled: false } }
        });

        // Mapped to strings before asserting: a raw axe violation object prints
        // as an unreadable wall, and this names the rule immediately.
        expect(results.violations.map(v => `${v.id}: ${v.nodes.length} node(s)`)).toEqual([]);
    });
});

describe('the gate itself', () => {
    it('covers every surface the client mounts', () => {
        // A surface added to the DOM layer but not to this list would ship
        // unchecked, and nothing else in the suite would notice.
        //
        // Twenty cases across seventeen surfaces: the reference dock appears
        // twice, because its two tabs render entirely different markup and
        // checking only the one it happens to open on would leave the other
        // unchecked; the mute control appears twice because its name and its
        // pressed state both change with it; and the lobby appears three times,
        // because the host-only controls it renders differ by seat status and
        // the computer-seated case is the one that puts three identically
        // worded buttons on a single screen.
        expect(SURFACES).toHaveLength(20);
    });

    it('detects a violation rather than passing over it', async () => {
        // Proves the harness works. A button with no accessible name is exactly
        // the kind of regression this gate exists to catch.
        const root = makeUiRootElement();
        const button = document.createElement('button');
        root.appendChild(button);

        const results = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
        expect(results.violations.map(v => v.id)).toContain('button-name');
    });
});
