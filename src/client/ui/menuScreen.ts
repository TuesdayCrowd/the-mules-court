/**
 * The menu: host a game, or join one from a link (UIX §3).
 *
 * The host names themselves here rather than on the join screen — D2, decided in
 * favour of (a). Their seat is minted over HTTP rather than claimed over the
 * socket, so this is the one moment before the room exists when a name can be
 * attached to it; `RESUME_SEAT` then carries the name on its first frame and the
 * lobby never renders a blank host.
 *
 * **The seat token is persisted before anything navigates.** It arrives in the
 * `POST /api/rooms` response and never over the socket, so there is no second
 * copy: a navigation that beat the write would lose the host's seat permanently.
 */

import { MAX_NICKNAME_LENGTH, validateNickname } from '../content/nickname';
import { parseRoute } from '../store/routes';
import type { StoredSeat } from '../store/seatTokenStore';
import type { CreateRoomFailure, CreateRoomResult } from '../store/roomApi';
import type { ClientState } from '../store/types';
import type { Surface } from './surface';

export interface MenuScreenDeps {
    readonly roomApi: { createRoom(): Promise<CreateRoomResult> };
    readonly tokens: { save(matchId: string, seat: StoredSeat): void };
    /** Real navigation in `main.ts`; a spy in tests. */
    readonly navigate: (path: string) => void;
}

const NAME_ID = 'menu-host-name';
const LINK_ID = 'menu-join-link';

const FAILURE_COPY: Readonly<Record<CreateRoomFailure, string>> = {
    'rate-limited': 'The court is busy — trying again shortly.',
    'server-error': 'Something went wrong opening the court. Try again.',
    unreachable: 'Could not reach the court. Check your connection and try again.',
    // A response we cannot read is a server problem the player cannot act on
    // differently, so it says the same thing rather than leaking a shape error.
    malformed: 'Something went wrong opening the court. Try again.'
};

/**
 * The match id inside whatever was pasted, or null.
 *
 * Reuses `parseRoute`, so the menu and the router agree on what a join link is
 * by construction. A bare id is accepted too, because that is what people
 * actually paste out of a chat message.
 */
function matchIdFrom(pasted: string): string | null {
    const trimmed = pasted.trim();
    if (trimmed.length === 0) return null;

    const path = trimmed.includes('://') ? pathOf(trimmed) : trimmed;
    if (path === null) return null;

    const route = parseRoute(path.startsWith('/') ? path : `/join/${path}`);
    return route.kind === 'join' ? route.matchId : null;
}

function pathOf(url: string): string | null {
    // Hand-parsed rather than `new URL(...)`: this module must stay free of
    // ambient globals, and the tail after the origin is all that is wanted.
    const afterScheme = url.slice(url.indexOf('://') + 3);
    const slash = afterScheme.indexOf('/');
    return slash === -1 ? null : afterScheme.slice(slash);
}

export function createMenuScreen(deps: MenuScreenDeps): Surface {
    const container = document.createElement('div');
    container.dataset.role = 'menu';
    container.className = 'screen screen-menu';

    let nameText = '';
    let linkText = '';
    let inFlight = false;
    let failure: CreateRoomFailure | null = null;
    let visible = false;

    const nameLabel = document.createElement('label');
    nameLabel.htmlFor = NAME_ID;
    nameLabel.textContent = 'Your name at this court';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.id = NAME_ID;
    nameInput.dataset.role = 'host-name';
    nameInput.maxLength = MAX_NICKNAME_LENGTH;
    nameInput.setAttribute('autocomplete', 'nickname');

    const hostButton = document.createElement('button');
    hostButton.type = 'button';
    hostButton.dataset.action = 'host';
    hostButton.textContent = 'Host a game';

    const linkLabel = document.createElement('label');
    linkLabel.htmlFor = LINK_ID;
    linkLabel.textContent = 'Paste an invite link';

    const linkInput = document.createElement('input');
    linkInput.type = 'text';
    linkInput.id = LINK_ID;
    linkInput.dataset.role = 'join-link';

    const joinButton = document.createElement('button');
    joinButton.type = 'button';
    joinButton.dataset.action = 'join';
    joinButton.textContent = 'Join a game';

    const error = document.createElement('p');
    error.dataset.role = 'menu-error';
    error.className = 'field-error';
    error.setAttribute('role', 'alert');

    function refresh(): void {
        hostButton.disabled = inFlight || !validateNickname(nameText).ok;
        joinButton.disabled = matchIdFrom(linkText) === null;

        if (failure === null) {
            error.remove();
            return;
        }
        error.textContent = FAILURE_COPY[failure];
        if (error.parentElement === null) container.appendChild(error);
    }

    nameInput.addEventListener('input', () => {
        nameText = nameInput.value;
        refresh();
    });

    linkInput.addEventListener('input', () => {
        linkText = linkInput.value;
        refresh();
    });

    hostButton.addEventListener('click', () => {
        const name = validateNickname(nameText);
        if (inFlight || !name.ok) return;

        inFlight = true;
        failure = null; // a stale message must not sit under a fresh attempt
        refresh();

        void deps.roomApi.createRoom().then(result => {
            inFlight = false;

            if (!result.ok) {
                failure = result.reason;
                refresh();
                return;
            }

            // Persist, THEN navigate. The order is the whole point.
            deps.tokens.save(result.room.matchId, {
                seat: 0,
                playerId: result.room.hostSeat,
                seatToken: result.room.hostSeatToken,
                nickname: name.value
            });
            deps.navigate(`/join/${result.room.matchId}`);
            refresh();
        });
    });

    joinButton.addEventListener('click', () => {
        const matchId = matchIdFrom(linkText);
        if (matchId === null) return;
        deps.navigate(`/join/${matchId}`);
    });

    function show(): void {
        if (visible) return;
        visible = true;
        container.replaceChildren(nameLabel, nameInput, hostButton, linkLabel, linkInput, joinButton);
        refresh();
    }

    function hide(): void {
        if (!visible) return;
        visible = false;
        container.replaceChildren();
    }

    return {
        mount(parent) {
            parent.appendChild(container);
        },

        update(state: ClientState) {
            if (state.screen === 'menu') show();
            else hide();
        },

        destroy() {
            container.remove();
        }
    };
}
