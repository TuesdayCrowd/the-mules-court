/**
 * The lobby (UIX §4).
 *
 * Renders `LOBBY_UPDATE` and nothing else: which seats exist, who holds them,
 * whether the match may start. `canStart` is the server's answer and this screen
 * never second-guesses it.
 *
 * Rebuilt wholesale on each update rather than diffed. The lobby is four rows
 * and a button; a diffing renderer here would be machinery guarding against a
 * cost that does not exist, and the focus this screen holds is restored
 * explicitly below.
 */

import { iconElement } from './icons';
import { DEFAULT_DIFFICULTY, DIFFICULTY_COPY, difficultyCopy } from '../content/difficulty';
import type { BotDifficulty } from '../../server/protocol';
import type { ClientState, LobbySnapshot } from '../store/types';
import type { Surface } from './surface';

export interface LobbyScreenDeps {
    readonly onStart: () => void;
    readonly onDissolve: () => void;
    /** Fills one open seat with a computer opponent. Host only; the server re-checks. */
    readonly onAddBot: (seat: number, difficulty: BotDifficulty) => void;
    /** `navigator.clipboard` in `main.ts`; a fake in tests. */
    readonly clipboard: { writeText(text: string): Promise<void> };
    /** Built from the live origin, since only the host ever sees the server's own `joinUrl`. */
    readonly joinUrlFor: (matchId: string) => string;
}

const START_CAPTION_ID = 'lobby-start-caption';
const DIFFICULTY_LEGEND_ID = 'lobby-difficulty-legend';

type SeatRow = LobbySnapshot['seats'][number];

/**
 * What a row says about its occupant.
 *
 * The "Host" fallback is UIX §13.1's path and still reachable: a client that
 * predates the RESUME_SEAT nickname leaves seat zero unnamed, and a seat named
 * once is never renamed, so the blank persists for the life of the match.
 */
function occupantOf(row: SeatRow, isHost: boolean): string {
    if (row.status === 'open') return '(open)';
    if (row.status === 'disconnected') return `${row.nickname ?? (isHost ? 'Host' : 'Player')} — Reconnecting…`;
    // A computer seat needs no "reconnecting" treatment: it has no socket to
    // lose, so it is never absent and never waited on.
    return row.nickname ?? (isHost ? 'Host' : 'Player');
}

export function createLobbyScreen(deps: LobbyScreenDeps): Surface {
    const container = document.createElement('div');
    container.dataset.role = 'lobby';
    container.className = 'screen screen-lobby';

    /**
     * The tier the next computer opponent will be seated at.
     *
     * Held here rather than read off the DOM at click time, because this screen
     * rebuilds itself wholesale on every `LOBBY_UPDATE` — and one arrives
     * immediately after each bot is seated. A selection living only in the
     * markup would reset between the first bot and the second, silently seating
     * the second at a different difficulty than the host had chosen.
     */
    let difficulty: BotDifficulty = DEFAULT_DIFFICULTY;

    /** Its own element so a rebuild never wipes a copy confirmation mid-announcement. */
    const copyStatus = document.createElement('p');
    copyStatus.dataset.role = 'copy-status';
    copyStatus.className = 'copy-status';
    copyStatus.setAttribute('aria-live', 'polite');

    /**
     * The host's offer to fill an open seat with a computer opponent.
     *
     * Offered per seat rather than as one "add opponents" control, because the
     * host may want a mix — two friends and one machine — and only the host
     * ever sees it. The server re-checks host, phase, and occupancy anyway; this
     * is the affordance, not the gate.
     *
     * It carries the word as well as the glyph. Icons here are `aria-hidden` by
     * construction, so a button labelled only by one would reach a screen reader
     * with no accessible name at all.
     */
    function addBotButton(row: SeatRow): HTMLElement {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.action = 'add-bot';
        button.dataset.seat = String(row.seat);
        button.appendChild(iconElement('robot'));
        button.appendChild(document.createTextNode(' Add computer'));
        button.addEventListener('click', () => deps.onAddBot(row.seat, difficulty));
        return button;
    }

    /**
     * One control for the table, not one per seat.
     *
     * Three buttons on every open row would be twelve controls to seat three
     * opponents. This is one choice that the robot buttons then read, which
     * still allows a mixed table — change the tier between presses — without
     * making the common case (three of the same) cost three decisions.
     */
    function difficultyControls(): HTMLElement {
        const group = document.createElement('fieldset');
        group.dataset.role = 'difficulty';

        const legend = document.createElement('legend');
        legend.id = DIFFICULTY_LEGEND_ID;
        legend.textContent = 'Computer opponents play as';
        group.appendChild(legend);

        for (const entry of DIFFICULTY_COPY) {
            const label = document.createElement('label');

            const input = document.createElement('input');
            input.type = 'radio';
            // Shared name, so the browser gives arrow-key navigation and a single
            // tab stop for the group without any script.
            input.name = 'bot-difficulty';
            input.value = entry.id;
            input.checked = entry.id === difficulty;
            input.addEventListener('change', () => {
                if (input.checked) difficulty = entry.id;
            });

            const text = document.createElement('span');
            text.textContent = entry.name;

            const hint = document.createElement('span');
            hint.dataset.role = 'difficulty-hint';
            hint.textContent = entry.description;

            label.append(input, text, hint);
            group.appendChild(label);
        }

        return group;
    }

    function seatRow(row: SeatRow, lobby: LobbySnapshot, ownPlayerId: string | null): HTMLElement {
        const isHost = row.playerId !== null && row.playerId === lobby.hostSeat;
        const viewerIsHost = ownPlayerId !== null && ownPlayerId === lobby.hostSeat;
        const element = document.createElement('li');
        element.dataset.role = 'seat-row';

        const label = document.createElement('span');
        label.textContent = `Seat ${row.seat + 1}`;

        const occupant = document.createElement('span');
        occupant.dataset.role = 'occupant';
        occupant.textContent = occupantOf(row, isHost); // textContent: nicknames are other players' free text

        element.append(label, occupant);

        if (isHost) {
            // The crown is aria-hidden and the word carries the meaning, so a
            // screen reader hears "host" once rather than a glyph name beside
            // it — and the emoji it replaces rendered differently on every
            // platform (UIX §12).
            const marker = document.createElement('span');
            marker.appendChild(iconElement('crown'));
            marker.appendChild(document.createTextNode(' host'));
            element.appendChild(marker);
        }
        if (row.status === 'computer') {
            const marker = document.createElement('span');
            marker.appendChild(iconElement('robot'));
            // The tier, not the word "computer": which opponent this is tells a
            // player something, and the icon already says it is not a person.
            marker.appendChild(
                document.createTextNode(
                    ` ${row.difficulty === null ? 'computer' : difficultyCopy(row.difficulty).name}`
                )
            );
            element.appendChild(marker);
        }
        if (row.playerId !== null && row.playerId === ownPlayerId) {
            const you = document.createElement('span');
            you.textContent = '(you)';
            element.appendChild(you);
        }
        if (row.status === 'open' && viewerIsHost) {
            element.appendChild(addBotButton(row));
        }

        return element;
    }

    function inviteBox(matchId: string): HTMLElement {
        const box = document.createElement('div');
        box.className = 'invite-box';

        const heading = document.createElement('p');
        heading.textContent = 'Share this link to invite players:';

        const url = document.createElement('code');
        url.dataset.role = 'invite-url';
        const href = deps.joinUrlFor(matchId);
        url.textContent = href;

        const copy = document.createElement('button');
        copy.type = 'button';
        copy.dataset.action = 'copy';
        copy.textContent = 'Copy';
        copy.addEventListener('click', () => {
            void deps.clipboard.writeText(href).then(
                () => {
                    copyStatus.textContent = 'Copied the invite link.';
                },
                () => {
                    // Never claim a copy that did not happen — the player would
                    // paste nothing and blame themselves.
                    copyStatus.textContent = 'Could not copy — select the link and copy it yourself.';
                }
            );
        });

        box.append(heading, url, copy, copyStatus);
        return box;
    }

    function startControls(lobby: LobbySnapshot): HTMLElement {
        const group = document.createElement('div');

        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.action = 'start';
        button.textContent = 'Start Match';
        button.disabled = !lobby.canStart;
        button.addEventListener('click', () => {
            if (lobby.canStart) deps.onStart();
        });
        group.appendChild(button);

        if (!lobby.canStart) {
            const caption = document.createElement('p');
            caption.id = START_CAPTION_ID;
            caption.dataset.role = 'start-caption';
            caption.textContent = 'Waiting for 2–4 players, all connected';
            button.setAttribute('aria-describedby', START_CAPTION_ID);
            group.appendChild(caption);
        }

        return group;
    }

    function dissolveControls(): HTMLElement {
        const group = document.createElement('div');

        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.action = 'dissolve';
        button.textContent = 'Dissolve lobby';
        button.addEventListener('click', () => deps.onDissolve());

        // Stated as a condition rather than a promise. The server allows this
        // only once the host has been gone past the lobby grace, and no message
        // tells the client when that moment arrives: the host seat never
        // reopens, so no LOBBY_UPDATE fires for it. See D4 in the plan.
        const caption = document.createElement('p');
        caption.textContent = 'The host has left. Once they have been gone a minute, the court can be dissolved.';

        group.append(caption, button);
        return group;
    }

    function render(state: ClientState): void {
        const lobby = state.lobby;
        if (state.screen !== 'lobby' || lobby === null) {
            container.replaceChildren();
            return;
        }

        const ownPlayerId = state.seat?.playerId ?? null;
        const isHost = ownPlayerId !== null && ownPlayerId === lobby.hostSeat;
        const hostRow = lobby.seats.find(row => row.playerId === lobby.hostSeat);
        const hostGone = hostRow !== undefined && hostRow.status === 'disconnected';

        const heading = document.createElement('h1');
        heading.textContent = "The Mule's Court";

        const seats = document.createElement('ul');
        seats.append(...lobby.seats.map(row => seatRow(row, lobby, ownPlayerId)));

        // The difficulty picker goes ABOVE the seat rows, because it governs the
        // buttons in them: a host who meets "Add computer" first will press it
        // before learning there was a choice, and the seat is then filled at a
        // tier they never chose.
        const children: HTMLElement[] = [heading, inviteBox(lobby.matchId)];
        if (isHost) children.push(difficultyControls());
        children.push(seats);
        if (isHost) children.push(startControls(lobby));
        else if (hostGone) children.push(dissolveControls());

        container.replaceChildren(...children);
    }

    return {
        mount(parent) {
            parent.appendChild(container);
        },
        update: render,
        destroy() {
            container.remove();
        }
    };
}
