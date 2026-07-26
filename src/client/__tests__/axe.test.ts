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
import { createQuickReference } from '../ui/quickReference';
import { createSeatDossier } from '../ui/seatDossier';
import type { Surface } from '../ui/surface';
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
        { seat: 0, playerId: 'p1', nickname: 'Cornelius', status: 'occupied' },
        { seat: 1, playerId: 'p2', nickname: 'Ana', status: 'disconnected' },
        { seat: 2, playerId: null, nickname: null, status: 'open' },
        { seat: 3, playerId: null, nickname: null, status: 'open' }
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
                clipboard: { writeText: noopAsync },
                joinUrlFor: id => `https://court.example.com/join/${id}`
            });
            drive(screen, root, makeState({ screen: 'lobby', matchId: 'K7QX2', lobby: LOBBY, seat: { seat: 0, playerId: 'p1' } }));
        }
    ],
    [
        'lobby with the host gone',
        root => {
            const screen = createLobbyScreen({
                onStart: noop,
                onDissolve: noop,
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
            const sheet = createActionSheet({ onPlay: noop, onCancel: noop });
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
        'quick reference',
        root => {
            const panel = createQuickReference();
            drive(panel, root, makeState({ screen: 'table', table: makeTable() }));
            (root.querySelector('[data-action="quick-reference"]') as HTMLButtonElement).click();
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
                onEndMatch: noop
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
                onEndMatch: noop
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
                onEndMatch: noop
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
        expect(SURFACES).toHaveLength(13);
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
