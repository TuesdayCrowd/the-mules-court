/**
 * Round over, match over, paused (UIX §9).
 *
 * One surface holds all three because at most one is ever up, and their
 * precedence matters: a match that has ended supersedes a pause, and a round
 * that also won the match shows the match screen rather than stacking two
 * dialogs (UIX §9.1).
 *
 * Revealed hands come from `roundResult.revealedHands` and nowhere else —
 * interface rule 4's showdown exception, and the only place another player's
 * card is ever named.
 */

import type { PlayerId, RedactedView, RoundResult } from '../../game/engine';
import { cardCopyFor } from '../content/cardCopy';
import { secondsRemaining } from '../content/countdown';
import type { ClientState, TableSnapshot } from '../store/types';
import type { Surface, Timers } from './surface';

export interface OverlaysDeps {
    readonly timers: Timers;
    readonly now: () => number;
    readonly isHost: () => boolean;
    /**
     * Whether a non-host may end the match yet.
     *
     * Supplied rather than derived: the server allows it only once a seat has
     * been missing past `activeGraceMs`, and no message on the wire carries when
     * that seat went missing — `STATE_UPDATE` has `missingSeats` but no
     * timestamp for them. See D4 in the plan.
     */
    readonly canEndMatch: () => boolean;
    readonly onEndMatch: () => void;
}

const TITLE_ID = 'overlay-title';
const TICK_MS = 1000;

type OverlayKind = 'round-over' | 'match-over' | 'paused' | null;

function joinNames(ids: readonly PlayerId[], nameOf: (id: PlayerId) => string): string {
    const names = ids.map(nameOf);
    if (names.length <= 1) return names[0] ?? '';
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function createOverlays(deps: OverlaysDeps): Surface {
    const container = document.createElement('div');
    container.dataset.role = 'overlays-host';

    let showing: OverlayKind = null;
    let tick: unknown = null;

    function stopTicking(): void {
        if (tick === null) return;
        deps.timers.clearTimeout(tick);
        tick = null;
    }

    function which(state: ClientState): OverlayKind {
        const table = state.table;
        if (state.screen !== 'table' || table === null) return null;

        // Terminal first. A match that has ended outranks a pause, and outranks
        // the round-over window it may have arrived during.
        if (table.phase === 'ended' || state.ended !== null || table.view.matchWinnerId !== null) return 'match-over';
        if (table.paused) return 'paused';
        if (table.phase === 'round_over' && table.view.roundResult !== null) return 'round-over';
        return null;
    }

    function nameOf(table: TableSnapshot): (id: PlayerId) => string {
        return id => table.nicknames[id] ?? id;
    }

    function roundOverBody(table: TableSnapshot, result: RoundResult): HTMLElement[] {
        const name = nameOf(table);
        const reason = document.createElement('p');
        reason.textContent =
            result.reason === 'deck-out'
                ? 'Deck ran out — highest card wins.'
                : `${joinNames(result.winnerIds, name)} is the last one standing.`;

        const winner = document.createElement('p');
        winner.textContent = `${joinNames(result.winnerIds, name)} takes the round.`;

        const nodes: HTMLElement[] = [reason, winner];

        // Populated on deck-out only, and a null entry marks the empty-hand
        // edge case — a seat with nothing to reveal reveals nothing.
        const hands = result.revealedHands;
        if (hands !== undefined) {
            const list = document.createElement('ul');
            for (const [playerId, cardId] of Object.entries(hands)) {
                if (cardId === null) continue;
                const item = document.createElement('li');
                item.dataset.role = 'revealed-hand';
                item.textContent = `${name(playerId)} held ${cardCopyFor(cardId).displayName}`;
                list.appendChild(item);
            }
            if (list.children.length > 0) nodes.push(list);
        }

        const countdown = document.createElement('p');
        countdown.dataset.role = 'countdown';
        nodes.push(countdown);

        return nodes;
    }

    function matchOverBody(state: ClientState, table: TableSnapshot): HTMLElement[] {
        const name = nameOf(table);
        const view: RedactedView = table.view;

        if (state.ended?.reason === 'abandoned') {
            // One line, no celebration chrome: nobody won this.
            const line = document.createElement('p');
            line.textContent = 'The match was abandoned.';
            return [line];
        }

        const winnerId = state.ended?.winnerSeat ?? view.matchWinnerId;
        const headline = document.createElement('p');
        headline.textContent =
            winnerId === null || winnerId === undefined
                ? 'The match has ended.'
                : `${name(winnerId)} reaches ${view.tokensToWin} devotion tokens and wins the court.`;

        const list = document.createElement('ul');
        for (const player of view.players) {
            const item = document.createElement('li');
            item.dataset.role = 'tally';
            item.textContent = `${name(player.id)} — ${player.tokens}`;
            list.appendChild(item);
        }

        return [headline, list];
    }

    function pausedBody(table: TableSnapshot): HTMLElement[] {
        const missing = joinNames(table.missingSeats, nameOf(table));
        const line = document.createElement('p');
        line.textContent = `Waiting for ${missing} to reconnect. The match will resume on its own.`;

        const nodes: HTMLElement[] = [line];

        // The host always may; anyone else only once the server would accept it.
        if (deps.isHost() || deps.canEndMatch()) {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.action = 'end-match';
            button.textContent = 'End match';
            button.addEventListener('click', () => deps.onEndMatch());
            nodes.push(button);
        }

        return nodes;
    }

    function titleFor(kind: Exclude<OverlayKind, null>): string {
        if (kind === 'round-over') return 'Round over';
        return kind === 'match-over' ? 'Match over' : 'Paused';
    }

    function paintCountdown(table: TableSnapshot): void {
        const node = container.querySelector('[data-role="countdown"]');
        if (node === null) return;

        const seconds = secondsRemaining(table, deps.now());
        node.textContent = seconds === null ? '' : `Next round in ${seconds}…`;
    }

    function scheduleTick(table: TableSnapshot): void {
        stopTicking();
        tick = deps.timers.setTimeout(() => {
            tick = null;
            paintCountdown(table);
            scheduleTick(table);
        }, TICK_MS);
    }

    function render(state: ClientState): void {
        const kind = which(state);

        if (kind === null) {
            stopTicking();
            if (showing !== null) {
                showing = null;
                container.replaceChildren();
            }
            return;
        }

        const table = state.table as TableSnapshot;
        const fresh = kind !== showing;

        const dialog = document.createElement('div');
        dialog.dataset.role = 'overlay';
        dialog.dataset.overlay = kind;
        dialog.className = 'overlay';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-labelledby', TITLE_ID);
        dialog.tabIndex = -1;

        const title = document.createElement('h2');
        title.id = TITLE_ID;
        title.textContent = titleFor(kind);

        const body =
            kind === 'round-over'
                ? roundOverBody(table, table.view.roundResult as RoundResult)
                : kind === 'match-over'
                  ? matchOverBody(state, table)
                  : pausedBody(table);

        dialog.append(title, ...body);
        container.replaceChildren(dialog);

        if (kind === 'round-over') {
            paintCountdown(table);
            scheduleTick(table);
        } else {
            stopTicking();
        }

        // Focus once, on the transition into an overlay. Re-taking it on every
        // snapshot would drag a screen reader back to the title mid-sentence.
        if (fresh) dialog.focus();
        showing = kind;
    }

    return {
        mount(parent) {
            parent.appendChild(container);
        },
        update: render,
        destroy() {
            stopTicking();
            container.remove();
        }
    };
}
