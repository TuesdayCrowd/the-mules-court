// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { MAX_NICKNAME_LENGTH } from '../content/nickname';
import type { CreateRoomResult, RoomInfo } from '../store/roomApi';
import { makeState, makeUiRootElement } from './__fixtures__/dom';
import { createMenuScreen } from './menuScreen';

const ROOM: RoomInfo = {
    matchId: 'K7QX2',
    joinUrl: 'http://localhost:3000/join/K7QX2',
    hostSeat: 'p1',
    hostSeatToken: 'tok-host'
};

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function mounted(overrides: { createRoom?: () => Promise<CreateRoomResult> } = {}) {
    const root = makeUiRootElement();
    const order: string[] = [];
    const saved: Array<{ matchId: string; nickname?: string; seatToken: string }> = [];
    const navigated: string[] = [];

    const screen = createMenuScreen({
        roomApi: { createRoom: overrides.createRoom ?? (() => Promise.resolve({ ok: true, room: ROOM })) },
        tokens: {
            save: (matchId, seat) => {
                order.push('save');
                saved.push({ matchId, nickname: seat.nickname, seatToken: seat.seatToken });
            }
        },
        navigate: path => {
            order.push('navigate');
            navigated.push(path);
        }
    });
    screen.mount(root);
    screen.update(makeState({ screen: 'menu' }));

    const q = <T extends Element>(selector: string) => root.querySelector(selector) as T | null;

    return {
        root,
        screen,
        order,
        saved,
        navigated,
        hostButton: () => q<HTMLButtonElement>('[data-action="host"]')!,
        joinButton: () => q<HTMLButtonElement>('[data-action="join"]')!,
        nameInput: () => q<HTMLInputElement>('[data-role="host-name"]'),
        linkInput: () => q<HTMLInputElement>('[data-role="join-link"]'),
        error: () => q<HTMLElement>('[data-role="menu-error"]'),
        type(selector: string, value: string) {
            const input = q<HTMLInputElement>(selector)!;
            input.value = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    };
}

describe('the menu', () => {
    it('offers hosting and joining by name', () => {
        const ui = mounted();
        expect(ui.hostButton().textContent).toBe('Host a game');
        expect(ui.joinButton().textContent).toBe('Join a game');
    });

    it('renders nothing on another screen', () => {
        const ui = mounted();
        ui.screen.update(makeState({ screen: 'lobby' }));
        expect(ui.root.querySelector('[data-action="host"]')).toBeNull();
    });
});

describe('the host name field', () => {
    // D2, decided in favour of (a): the host names themselves before the room
    // exists, so RESUME_SEAT carries the name on its very first frame and the
    // lobby never renders a blank host.
    it('asks the host for a name, as every other player is asked', () => {
        const ui = mounted();
        expect(ui.nameInput()).not.toBeNull();
        expect(ui.nameInput()!.maxLength).toBe(MAX_NICKNAME_LENGTH);
    });

    it('gives the field an accessible name through a real label', () => {
        const ui = mounted();
        const label = ui.root.querySelector(`label[for="${ui.nameInput()!.id}"]`);
        expect(label).not.toBeNull();
        expect(label!.textContent!.length).toBeGreaterThan(0);
    });

    it('keeps hosting disabled until the name validates', () => {
        const ui = mounted();
        expect(ui.hostButton().disabled).toBe(true);

        ui.type('[data-role="host-name"]', 'Cornelius');
        expect(ui.hostButton().disabled).toBe(false);
    });

    it('uses the same rules the join screen and the server use', () => {
        const ui = mounted();
        ui.type('[data-role="host-name"]', 'C'.repeat(MAX_NICKNAME_LENGTH + 1));
        expect(ui.hostButton().disabled).toBe(true);
    });
});

describe('hosting', () => {
    it('persists the host seat token before it navigates anywhere', async () => {
        // The token never arrives over the socket; there is no second copy.
        const ui = mounted();
        ui.type('[data-role="host-name"]', 'Cornelius');
        ui.hostButton().click();
        await flush();

        expect(ui.order).toEqual(['save', 'navigate']);
    });

    it('stores the seat, the token, and the name together', async () => {
        const ui = mounted();
        ui.type('[data-role="host-name"]', 'Cornelius');
        ui.hostButton().click();
        await flush();

        expect(ui.saved).toEqual([{ matchId: 'K7QX2', nickname: 'Cornelius', seatToken: 'tok-host' }]);
    });

    it('navigates to the room’s own join route', async () => {
        const ui = mounted();
        ui.type('[data-role="host-name"]', 'Ana');
        ui.hostButton().click();
        await flush();

        expect(ui.navigated).toEqual(['/join/K7QX2']);
    });

    it('stores the trimmed name, matching what the server will keep', async () => {
        const ui = mounted();
        ui.type('[data-role="host-name"]', '   Ana   ');
        ui.hostButton().click();
        await flush();

        expect(ui.saved[0].nickname).toBe('Ana');
    });

    it('disables the button while the request is in flight', async () => {
        let release!: (result: CreateRoomResult) => void;
        const ui = mounted({ createRoom: () => new Promise<CreateRoomResult>(resolve => (release = resolve)) });
        ui.type('[data-role="host-name"]', 'Ana');

        ui.hostButton().click();
        expect(ui.hostButton().disabled).toBe(true);

        release({ ok: true, room: ROOM });
        await flush();
    });

    it('creates one room however many times the button is pressed', async () => {
        let calls = 0;
        let release!: (result: CreateRoomResult) => void;
        const ui = mounted({
            createRoom: () => {
                calls++;
                return new Promise<CreateRoomResult>(resolve => (release = resolve));
            }
        });
        ui.type('[data-role="host-name"]', 'Ana');

        ui.hostButton().click();
        ui.hostButton().click();
        ui.hostButton().click();

        expect(calls).toBe(1);
        release({ ok: true, room: ROOM });
        await flush();
    });
});

describe('hosting when it fails', () => {
    it.each([
        ['rate-limited', 'trying again'],
        ['server-error', 'went wrong'],
        ['unreachable', 'reach'],
        ['malformed', 'went wrong']
    ] as const)('explains %s without navigating', async (reason, fragment) => {
        const ui = mounted({ createRoom: () => Promise.resolve({ ok: false, reason }) });
        ui.type('[data-role="host-name"]', 'Ana');
        ui.hostButton().click();
        await flush();

        expect(ui.navigated).toEqual([]);
        expect(ui.saved).toEqual([]);
        expect(ui.error()!.textContent!.toLowerCase()).toContain(fragment);
    });

    it('lets the player try again after a failure', async () => {
        let attempt = 0;
        const ui = mounted({
            createRoom: () => {
                attempt++;
                return Promise.resolve(
                    attempt === 1 ? ({ ok: false, reason: 'rate-limited' } as const) : ({ ok: true, room: ROOM } as const)
                );
            }
        });
        ui.type('[data-role="host-name"]', 'Ana');

        ui.hostButton().click();
        await flush();
        expect(ui.hostButton().disabled).toBe(false); // released, not stuck

        ui.hostButton().click();
        await flush();
        expect(ui.navigated).toEqual(['/join/K7QX2']);
    });

    it('clears a stale failure when the next attempt starts', async () => {
        let attempt = 0;
        const ui = mounted({
            createRoom: () => {
                attempt++;
                return attempt === 1
                    ? Promise.resolve({ ok: false, reason: 'rate-limited' } as const)
                    : new Promise<CreateRoomResult>(() => {});
            }
        });
        ui.type('[data-role="host-name"]', 'Ana');
        ui.hostButton().click();
        await flush();
        expect(ui.error()).not.toBeNull();

        ui.hostButton().click();
        expect(ui.error()).toBeNull();
    });
});

describe('joining by link', () => {
    it.each([
        ['a full invite URL', 'http://localhost:3000/join/K7QX2'],
        ['an https URL', 'https://court.example.com/join/K7QX2'],
        ['a URL with a trailing slash', 'http://localhost:3000/join/K7QX2/'],
        ['a URL with a query', 'http://localhost:3000/join/K7QX2?from=chat'],
        ['a bare match id', 'K7QX2'],
        ['a bare id with padding', '  K7QX2  ']
    ])('extracts the match id from %s', (_name, pasted) => {
        const ui = mounted();
        ui.type('[data-role="join-link"]', pasted);
        ui.joinButton().click();

        expect(ui.navigated).toEqual(['/join/K7QX2']);
    });

    it('keeps the join button disabled until something is pasted', () => {
        const ui = mounted();
        expect(ui.joinButton().disabled).toBe(true);

        ui.type('[data-role="join-link"]', 'K7QX2');
        expect(ui.joinButton().disabled).toBe(false);
    });

    it('refuses a link that names no match', () => {
        const ui = mounted();
        ui.type('[data-role="join-link"]', 'http://localhost:3000/');
        expect(ui.joinButton().disabled).toBe(true);
    });

    it('needs no nickname, because the join screen asks for one', () => {
        const ui = mounted();
        ui.type('[data-role="join-link"]', 'K7QX2');
        expect(ui.joinButton().disabled).toBe(false);
        expect(ui.navigated).toEqual([]);
    });
});

describe('teardown', () => {
    it('removes itself', () => {
        const ui = mounted();
        ui.screen.destroy();
        expect(ui.root.querySelector('[data-role="menu"]')).toBeNull();
    });
});
