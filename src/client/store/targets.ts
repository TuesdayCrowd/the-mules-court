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

export function sheetTargetsFor(
    view: RedactedView,
    cardInstanceId: CardInstanceId,
    nameOf: (id: PlayerId) => string
): SheetTargetOption[] {
    // Read through `?? {}`, not `view.own.legalTargets[...]` directly.
    //
    // `parseServerMessage` deliberately validates the message TYPE and casts the
    // rest, so every field here is only as trustworthy as the server sending it
    // — and in dev the two halves version-skew routinely, because Vite hot-
    // reloads the client while `bun run dev:server` keeps running the engine it
    // booted with. A server predating this field made the subscript throw, and
    // because `openSheetFor` is the only way into the sheet, that TypeError took
    // every card on the table with it: no card could be opened, on turn or off,
    // with nothing on screen to say why.
    //
    // Absent therefore reads as "no target offered". The server is authoritative
    // and refuses a play it did not sanction, so this can only ever prevent a
    // move, never permit an illegal one.
    const legal = (view.own.legalTargets ?? {})[cardInstanceId] ?? [];
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
