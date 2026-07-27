/**
 * Which seats a card may be played at, as the action sheet's buttons.
 *
 * **Eligibility is read, never derived** (interface rule 1). `view.own.
 * legalTargets` is the engine's own `computeLegalTargets` output, keyed by the
 * card being played, so this file decides nothing about who may be targeted —
 * it decides only how to present the answer.
 *
 * That split matters because the derived version got it wrong. The viewer was
 * filtered out for every card, so a Darell — "choose any player" — could never
 * be aimed at its own player; with every opponent protected the sheet then
 * declared a fizzle and sent a frame the engine refused with `TARGET_REQUIRED`,
 * and the turn never moved. Restating a rule is how a client drifts from the
 * engine, and there is no restatement left here to drift.
 *
 * Two presentation choices remain, and neither is a rule about this round:
 *
 *  - **Which seats to list.** Every opponent, always, so a disabled button can
 *    carry its reason (interface rule 3) rather than the rule being hidden. The
 *    viewer appears only when they are genuinely targetable — for a Guard or a
 *    Baron the viewer is not a choice being withheld, they are not a
 *    participant, and a disabled "yourself" would imply otherwise. Self is
 *    never *temporarily* ineligible: you are alive and holding the turn, and
 *    protection does not apply to your own play.
 *  - **Why a listed seat is disabled.** Taken from `players[]`, which is public
 *    board state every client can already see — an explanation of the engine's
 *    answer, not a second computation of it.
 */

import { CARD_CATALOG, EFFECT_DEFS } from '../../game/engine';
import type { CardInstanceId, CardTypeId, PlayerId, RedactedView } from '../../game/engine';

export interface SheetTargetOption {
    readonly playerId: PlayerId;
    readonly nickname: string;
    readonly eligible: boolean;
    readonly reason?: 'protected' | 'eliminated';
}

/**
 * `requiresTarget` is a static property of the card, like its value or its
 * name — not a fact about this round — so reading it here is not a rule
 * derivation. It is what separates the two meanings of an empty target list:
 * a card that takes no target at all, and one that takes a target but has no
 * legal one right now (UIX §7.2 gives those different copy).
 */
export function cardTakesTarget(cardId: CardTypeId): boolean {
    return EFFECT_DEFS[CARD_CATALOG[cardId].effectType].requiresTarget;
}

/**
 * Targets for one card, or `null` when the view cannot answer.
 *
 * `null` means the server did not send `legalTargets` at all — a version skew,
 * which in dev is routine: Vite hot-reloads the client the moment the engine
 * changes while `bun run dev:server` keeps running the engine it booted with.
 * `parseServerMessage` validates the message TYPE and casts the rest, on
 * purpose, so a field being present is never something this may assume.
 *
 * It is deliberately NOT folded into "no legal target". Those two look identical
 * on screen and mean opposite things: an empty list from the engine is a rule
 * — UIX §7.2's calm "every other player is protected or eliminated" — while a
 * missing list is the client having no idea. Reporting the second as the first
 * states a rule of the game that is not true, and did: a perfectly targetable
 * opponent was announced as protected. A caller that cannot tell them apart
 * will show one of them wrongly, so this makes telling them apart unavoidable.
 */
export function sheetTargetsFor(
    view: RedactedView,
    cardInstanceId: CardInstanceId,
    nameOf: (id: PlayerId) => string
): SheetTargetOption[] | null {
    const all = view.own.legalTargets;
    if (all === undefined || all === null) return null;

    const legal = all[cardInstanceId] ?? [];
    const own = view.own.playerId;

    return view.players
        .filter(player => player.id !== own || legal.includes(player.id))
        .map(player => {
            const isSelf = player.id === own;

            return {
                playerId: player.id,
                nickname: isSelf ? `${nameOf(player.id)} (you)` : nameOf(player.id),
                eligible: legal.includes(player.id),
                ...(!player.alive
                    ? { reason: 'eliminated' as const }
                    : !isSelf && player.protected
                      ? { reason: 'protected' as const }
                      : {})
            };
        });
}
