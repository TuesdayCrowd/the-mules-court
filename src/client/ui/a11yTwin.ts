/**
 * The offscreen twin (UIX §11).
 *
 * The canvas table is one opaque rectangle to a screen reader. This is its
 * shadow: a per-seat status list re-rendered on every snapshot, plus a focusable
 * proxy for each of the viewer's own hand cards, positioned from the **same
 * `LayoutSpec`** that placed the sprites — so an iOS touch exploration lands on
 * the proxy exactly where the card appears to be.
 *
 * **These are the only shadow elements in the app**, and a test asserts the
 * count is exactly `seats + handCards`. That is what stops a second, parallel
 * DOM table from growing here unnoticed.
 *
 * Not a live region. Announcements belong to the toast channel (UIX §6.5); a
 * list re-rendered on every update would read every seat aloud each time and
 * double up with the narration.
 */

import { cardTypeOf } from '../../game/engine';
import type { CardInstanceId, PlayerId, RedactedView } from '../../game/engine';
import { cardCopyFor } from '../content/cardCopy';
import type { LayoutSpec } from '../layout/types';
import type { ClientState, TableSnapshot } from '../store/types';
import type { Surface } from './surface';

export interface A11yTwinDeps {
    /** The live spec, or null before the first layout. Hand proxies need geometry; the seat list does not. */
    readonly layout: () => LayoutSpec | null;
    /**
     * Raising a card. Optional, and wired in `main.ts`.
     *
     * The proxy is the accessible path to playing a card, so it is also a
     * perfectly good pointer path — one interaction surface serving both is
     * fewer places for the two to disagree.
     */
    readonly onSelect?: (cardInstanceId: CardInstanceId) => void;
}

type SeatView = RedactedView['players'][number];

function statusOf(seat: SeatView, currentPlayerId: PlayerId): string {
    if (!seat.alive) return 'Out of the round';
    const turn = seat.id === currentPlayerId ? ', their turn' : '';
    return `${seat.protected ? 'Protected' : 'In the round'}${turn}`;
}

export function createA11yTwin(deps: A11yTwinDeps): Surface {
    const container = document.createElement('div');

    function seatList(table: TableSnapshot): HTMLElement {
        const list = document.createElement('ul');

        for (const seat of table.view.players) {
            const item = document.createElement('li');
            item.dataset.twin = 'seat';
            const name = table.nicknames[seat.id] ?? seat.id;
            // textContent throughout: nicknames are other players' free text.
            item.textContent = `${name} — ${statusOf(seat, table.view.currentPlayerId)}, ${seat.tokens} devotion tokens, discards total ${seat.discardValueTotal}`;
            list.appendChild(item);
        }

        return list;
    }

    function handProxies(table: TableSnapshot): HTMLElement[] {
        const spec = deps.layout();
        if (spec === null) return [];

        const proxies: HTMLElement[] = [];

        table.view.own.hand.forEach((instanceId, index) => {
            const slot = spec.hand[index];
            // A hand the layout has no slot for gets no proxy: a shadow element
            // with nowhere to sit would be a focus stop pointing at nothing.
            if (slot === undefined) return;

            const copy = cardCopyFor(cardTypeOf(instanceId));
            const playable = table.view.own.legalPlays.includes(instanceId);

            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.twin = 'hand';
            button.dataset.cardInstance = instanceId;
            button.textContent = `${copy.value} ${copy.displayName}${playable ? ' — playable' : ''}`;

            // Same numbers the sprite got. Interface rule 9 keeps DOM anchored
            // to the viewport rather than to canvas coordinates; this proxy is
            // the one deliberate exception, and it reads the spec rather than
            // measuring the canvas.
            button.style.position = 'absolute';
            button.style.left = `${slot.x}px`;
            button.style.top = `${slot.y}px`;
            button.style.width = `${slot.w}px`;
            button.style.height = `${slot.h}px`;

            if (deps.onSelect !== undefined) {
                button.addEventListener('click', () => deps.onSelect?.(instanceId));
            }

            proxies.push(button);
        });

        return proxies;
    }

    return {
        mount(parent) {
            parent.appendChild(container);
        },

        update(state: ClientState) {
            const table = state.table;
            if (state.screen !== 'table' || table === null) {
                container.replaceChildren();
                return;
            }
            container.replaceChildren(seatList(table), ...handProxies(table));
        },

        destroy() {
            container.remove();
        }
    };
}
