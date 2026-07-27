/**
 * Which seats a card may be played at, as the action sheet's buttons.
 *
 * **This mirrors the engine rather than inventing a rule**, and the mirroring is
 * the uncomfortable part. `computeLegalTargets` is the authority, but it takes a
 * `RoundState` the client does not have and the `RedactedView` carries no
 * `legalTargets` field — so the sheet has to assemble the list from what it can
 * see. The two rules it applies are read from the shared `EFFECT_DEFS` table,
 * not restated: `requiresTarget` decides whether there are targets at all, and
 * `canTargetSelf` decides whether the viewer is one of them.
 *
 * The alternative is a transport change putting `legalTargets` on the wire per
 * playable card, which is the right long-term shape and is noted as follow-up.
 * Until then this is the one place the derivation lives, so it can be tested
 * against the engine's behaviour instead of being spread through `main.ts`.
 *
 * The bug this replaced: the viewer was filtered out unconditionally, so a
 * Darell — "choose ANY player", `canTargetSelf: true` — could never be aimed at
 * yourself. With every opponent protected the sheet then declared the play a
 * fizzle and sent a frame with no target, which the engine refused with
 * `TARGET_REQUIRED` because a legal target (you) did exist. The sheet closed and
 * the turn stayed put.
 */

import { CARD_CATALOG, EFFECT_DEFS } from '../../game/engine';
import type { CardTypeId, PlayerId, RedactedView } from '../../game/engine';

export interface SheetTargetOption {
    readonly playerId: PlayerId;
    readonly nickname: string;
    readonly eligible: boolean;
    readonly reason?: 'protected' | 'eliminated';
}

export function sheetTargetsFor(
    view: RedactedView,
    cardId: CardTypeId,
    nameOf: (id: PlayerId) => string
): SheetTargetOption[] {
    const effect = EFFECT_DEFS[CARD_CATALOG[cardId].effectType];
    if (!effect.requiresTarget) return [];

    const own = view.own.playerId;

    return view.players
        // Self appears only when the card allows it. For every other card the
        // viewer is not a hidden choice being withheld — they are not a
        // participant, and a disabled "yourself" button would imply otherwise.
        .filter(player => player.id !== own || effect.canTargetSelf)
        .map(player => {
            const isSelf = player.id === own;

            // The engine's predicate, both halves: alive always, and for an
            // opponent, unprotected. Protection guards against other players,
            // so it never blocks a self-target.
            const eligible = player.alive && (isSelf || !player.protected);

            return {
                playerId: player.id,
                nickname: isSelf ? `${nameOf(player.id)} (you)` : nameOf(player.id),
                eligible,
                ...(!player.alive
                    ? { reason: 'eliminated' as const }
                    : !isSelf && player.protected
                      ? { reason: 'protected' as const }
                      : {})
            };
        });
}
