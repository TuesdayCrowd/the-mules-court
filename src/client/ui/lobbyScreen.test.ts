// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { SeatStatus } from '../../server/protocol';
import type { LobbySnapshot } from '../store/types';
import { makeState, makeUiRootElement } from './__fixtures__/dom';
import { createLobbyScreen } from './lobbyScreen';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

type SeatRow = LobbySnapshot['seats'][number];

function seat(index: number, nickname: string | null, status: SeatStatus = 'occupied'): SeatRow {
    return { seat: index, playerId: `p${index + 1}`, nickname, status };
}

function openSeat(index: number): SeatRow {
    return { seat: index, playerId: null, nickname: null, status: 'open' };
}

function lobby(overrides: Partial<LobbySnapshot> = {}): LobbySnapshot {
    return {
        matchId: 'K7QX2',
        hostSeat: 'p1',
        canStart: false,
        seats: [seat(0, 'Cornelius'), seat(1, 'Ana'), openSeat(2), openSeat(3)],
        ...overrides
    };
}

function mounted(overrides: { clipboard?: { writeText(text: string): Promise<void> } } = {}) {
    const root = makeUiRootElement();
    const started: number[] = [];
    const dissolved: number[] = [];
    const copied: string[] = [];
    const botted: number[] = [];

    const screen = createLobbyScreen({
        onStart: () => started.push(1),
        onDissolve: () => dissolved.push(1),
        onAddBot: seat => botted.push(seat),
        clipboard: overrides.clipboard ?? { writeText: text => (copied.push(text), Promise.resolve()) },
        joinUrlFor: matchId => `https://court.example.com/join/${matchId}`
    });
    screen.mount(root);

    const q = <T extends Element>(selector: string) => root.querySelector(selector) as T | null;

    return {
        root,
        screen,
        started,
        dissolved,
        copied,
        botted,
        addBotButtons: () =>
            [...root.querySelectorAll('[data-action="add-bot"]')] as HTMLButtonElement[],
        rows: () => [...root.querySelectorAll('[data-role="seat-row"]')].map(node => node.textContent ?? ''),
        startButton: () => q<HTMLButtonElement>('[data-action="start"]'),
        startCaption: () => q<HTMLElement>('[data-role="start-caption"]'),
        dissolveButton: () => q<HTMLButtonElement>('[data-action="dissolve"]'),
        copyButton: () => q<HTMLButtonElement>('[data-action="copy"]'),
        copyStatus: () => q<HTMLElement>('[data-role="copy-status"]'),
        inviteUrl: () => q<HTMLElement>('[data-role="invite-url"]'),
        show(snapshot: LobbySnapshot = lobby(), seatOf: { seat: number; playerId: string } | null = { seat: 0, playerId: 'p1' }) {
            screen.update(makeState({ screen: 'lobby', matchId: 'K7QX2', lobby: snapshot, seat: seatOf }));
        }
    };
}

describe('when it is not the lobby', () => {
    it('renders nothing', () => {
        const ui = mounted();
        ui.screen.update(makeState({ screen: 'menu' }));
        expect(ui.rows()).toEqual([]);
    });

    it('renders nothing while the lobby snapshot has not arrived', () => {
        const ui = mounted();
        ui.screen.update(makeState({ screen: 'lobby', lobby: null }));
        expect(ui.rows()).toEqual([]);
    });
});

describe('seat rows', () => {
    it('renders one row per seat the server sent', () => {
        const ui = mounted();
        ui.show();
        expect(ui.rows()).toHaveLength(4);
    });

    it('shows a nickname for an occupied seat', () => {
        const ui = mounted();
        ui.show();
        expect(ui.rows()[1]).toContain('Ana');
    });

    it('shows an open seat as open', () => {
        const ui = mounted();
        ui.show();
        expect(ui.rows()[2]).toContain('(open)');
    });

    it('shows a dropped claim as reconnecting', () => {
        const ui = mounted();
        ui.show(lobby({ seats: [seat(0, 'Cornelius'), seat(1, 'Ana', 'disconnected'), openSeat(2), openSeat(3)] }));
        expect(ui.rows()[1]).toContain('Reconnecting');
    });

    it('numbers the seats from one, as the design shows them', () => {
        const ui = mounted();
        ui.show();
        expect(ui.rows()[0]).toContain('Seat 1');
        expect(ui.rows()[3]).toContain('Seat 4');
    });

    it('marks the host row', () => {
        const ui = mounted();
        ui.show();
        expect(ui.rows()[0]).toContain('host');
        expect(ui.rows()[1]).not.toContain('host');
    });

    it('marks this viewer’s own row', () => {
        const ui = mounted();
        ui.show(lobby(), { seat: 1, playerId: 'p2' });
        expect(ui.rows()[1]).toContain('(you)');
        expect(ui.rows()[0]).not.toContain('(you)');
    });

    it('falls back to "Host" for a host seat with no nickname', () => {
        // UIX §13.1: still reachable when a host's client predates the
        // RESUME_SEAT nickname, since a seat named once is never renamed.
        const ui = mounted();
        ui.show(lobby({ seats: [seat(0, null), seat(1, 'Ana'), openSeat(2), openSeat(3)] }));
        expect(ui.rows()[0]).toContain('Host');
    });

    it('renders a hostile nickname as text, never as markup', () => {
        const ui = mounted();
        ui.show(lobby({ seats: [seat(0, '<img src=x onerror=alert(1)>'), seat(1, 'Ana'), openSeat(2), openSeat(3)] }));
        expect(ui.root.querySelector('img')).toBeNull();
        expect(ui.rows()[0]).toContain('<img src=x onerror=alert(1)>');
    });
});

describe('the invite box', () => {
    it('shows the join URL for this match', () => {
        const ui = mounted();
        ui.show();
        expect(ui.inviteUrl()!.textContent).toBe('https://court.example.com/join/K7QX2');
    });

    it('copies through the injected clipboard', async () => {
        const ui = mounted();
        ui.show();
        ui.copyButton()!.click();
        await flush();

        expect(ui.copied).toEqual(['https://court.example.com/join/K7QX2']);
    });

    it('reports success in a live region, so the confirmation is not sighted-only', async () => {
        const ui = mounted();
        ui.show();
        expect(ui.copyStatus()!.getAttribute('aria-live')).toBe('polite');

        ui.copyButton()!.click();
        await flush();

        expect(ui.copyStatus()!.textContent!.length).toBeGreaterThan(0);
    });

    it('says so when the clipboard refuses, rather than claiming a copy that never happened', async () => {
        const ui = mounted({ clipboard: { writeText: () => Promise.reject(new Error('denied')) } });
        ui.show();

        ui.copyButton()!.click();
        await flush();

        expect(ui.copyStatus()!.textContent!.toLowerCase()).toContain('copy');
        expect(ui.copyStatus()!.textContent).not.toContain('Copied');
    });
});

describe('starting the match', () => {
    it('offers Start Match to the host', () => {
        const ui = mounted();
        ui.show(lobby({ canStart: true }), { seat: 0, playerId: 'p1' });
        expect(ui.startButton()).not.toBeNull();
    });

    it('offers it to nobody else', () => {
        const ui = mounted();
        ui.show(lobby({ canStart: true }), { seat: 1, playerId: 'p2' });
        expect(ui.startButton()).toBeNull();
    });

    it('enables it exactly when canStart is true', () => {
        const ui = mounted();
        ui.show(lobby({ canStart: false }));
        expect(ui.startButton()!.disabled).toBe(true);

        ui.show(lobby({ canStart: true }));
        expect(ui.startButton()!.disabled).toBe(false);
    });

    it('says why while it is disabled', () => {
        // Show-reasons applies to buttons, not only to targets.
        const ui = mounted();
        ui.show(lobby({ canStart: false }));
        expect(ui.startCaption()!.textContent).toBe('Waiting for 2–4 players, all connected');
    });

    it('ties that caption to the button, so it is read with it', () => {
        const ui = mounted();
        ui.show(lobby({ canStart: false }));
        expect(ui.startButton()!.getAttribute('aria-describedby')).toBe(ui.startCaption()!.id);
    });

    it('drops the caption once the match can start', () => {
        const ui = mounted();
        ui.show(lobby({ canStart: false }));
        ui.show(lobby({ canStart: true }));

        expect(ui.startCaption()).toBeNull();
        expect(ui.startButton()!.getAttribute('aria-describedby')).toBeNull();
    });

    it('emits once when pressed', () => {
        const ui = mounted();
        ui.show(lobby({ canStart: true }));
        ui.startButton()!.click();
        expect(ui.started).toHaveLength(1);
    });

    it('emits nothing while disabled', () => {
        const ui = mounted();
        ui.show(lobby({ canStart: false }));
        ui.startButton()!.click();
        expect(ui.started).toEqual([]);
    });
});

describe('dissolving a lobby the host has left', () => {
    const HOST_GONE = lobby({
        seats: [seat(0, 'Cornelius', 'disconnected'), seat(1, 'Ana'), openSeat(2), openSeat(3)]
    });

    it('offers nothing while the host is present', () => {
        const ui = mounted();
        ui.show(lobby(), { seat: 1, playerId: 'p2' });
        expect(ui.dissolveButton()).toBeNull();
    });

    it('offers Dissolve lobby to a remaining player once the host has dropped', () => {
        const ui = mounted();
        ui.show(HOST_GONE, { seat: 1, playerId: 'p2' });
        expect(ui.dissolveButton()).not.toBeNull();
    });

    it('does not offer it to the host, who has Start Match and their own way out', () => {
        const ui = mounted();
        ui.show(HOST_GONE, { seat: 0, playerId: 'p1' });
        expect(ui.dissolveButton()).toBeNull();
    });

    it('says the court can only be dissolved after the grace, rather than promising it now', () => {
        // The client is never told when the grace expires — no LOBBY_UPDATE
        // fires for it, because the host seat never reopens. So the copy states
        // the condition instead of implying the button is certain to work.
        const ui = mounted();
        ui.show(HOST_GONE, { seat: 1, playerId: 'p2' });
        expect(ui.root.textContent).toContain('minute');
    });

    it('emits once when pressed', () => {
        const ui = mounted();
        ui.show(HOST_GONE, { seat: 1, playerId: 'p2' });
        ui.dissolveButton()!.click();
        expect(ui.dissolved).toHaveLength(1);
    });

    it('withdraws the offer when the host comes back', () => {
        const ui = mounted();
        ui.show(HOST_GONE, { seat: 1, playerId: 'p2' });
        ui.show(lobby(), { seat: 1, playerId: 'p2' });
        expect(ui.dissolveButton()).toBeNull();
    });
});

describe('teardown', () => {
    it('removes itself', () => {
        const ui = mounted();
        ui.show();
        ui.screen.destroy();
        expect(ui.root.querySelector('[data-role="lobby"]')).toBeNull();
    });
});

describe('the host marker', () => {
    it('uses an icon rather than an emoji, which renders differently everywhere', () => {
        const ui = mounted();
        ui.show();
        expect(ui.root.querySelector('svg')).not.toBeNull();
        expect(ui.rows()[0]).not.toContain('⭐');
    });

    it('keeps the meaning in words, since the glyph is hidden from the tree', () => {
        const ui = mounted();
        ui.show();
        expect(ui.root.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
        expect(ui.rows()[0]).toContain('host');
    });
});

describe('seating a computer opponent', () => {
    it('offers the host a button on every open seat', () => {
        const ui = mounted();
        ui.show();

        // The fixture lobby has two open seats and two taken.
        expect(ui.addBotButtons()).toHaveLength(2);
    });

    it('names the seat it will fill', () => {
        const ui = mounted();
        ui.show();

        ui.addBotButtons()[0].click();

        expect(ui.botted).toEqual([2]);
    });

    it('withdraws the offer once a human takes the seat', () => {
        const ui = mounted();
        ui.show();
        expect(ui.addBotButtons()).toHaveLength(2);

        ui.show(lobby({ seats: [seat(0, 'Cornelius'), seat(1, 'Ana'), seat(2, 'Bel'), openSeat(3)] }));

        expect(ui.addBotButtons()).toHaveLength(1);
    });

    it('withdraws the offer from a seat already holding a computer', () => {
        const ui = mounted();
        ui.show(
            lobby({
                seats: [seat(0, 'Cornelius'), seat(1, 'Preem Palver', 'computer'), openSeat(2), openSeat(3)]
            })
        );

        expect(ui.addBotButtons()).toHaveLength(2);
        expect(ui.rows()[1]).toContain('Preem Palver');
    });

    it('offers nothing to a player who is not the host', () => {
        const ui = mounted();
        ui.show(lobby(), { seat: 1, playerId: 'p2' });

        expect(ui.addBotButtons()).toHaveLength(0);
    });

    it('gives the button words, because the icon is hidden from the tree', () => {
        const ui = mounted();
        ui.show();

        const button = ui.addBotButtons()[0];
        expect(button.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
        expect(button.textContent).toMatch(/computer/i);
    });
});
