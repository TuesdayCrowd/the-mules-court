import { CARD_CATALOG } from '../../game/engine';
import type { CardTypeId, CardValue } from '../../game/engine';

export interface CardCopy {
    readonly id: CardTypeId;
    readonly displayName: string;
    readonly value: CardValue;
    /** Player-facing ability text, from README.md's card table. */
    readonly effect: string;
    /** Texture key loaded by Preloader; one per character directory. */
    readonly portraitKey: string;
    /** Present for the Mule alone (UIX §7.2): the red Play button's exact words. */
    readonly playWarning?: string;
}

/**
 * Effect sentences only. Names and values come from the catalog — never retyped,
 * because two sources for one fact is two sources to drift.
 *
 * Tightened from README.md's table for the action sheet, which is a phone-width
 * column: the Informant's "If a targeted player holds a card of that value, they
 * are eliminated" becomes "If they hold it, they are out" with the target already
 * named directly above it. The rule is unchanged.
 */
const EFFECT_TEXT: Readonly<Record<CardTypeId, string>> = {
    informant: 'Guess a value from 2 to 8. If they hold it, they are out.',
    'han-pritcher': "Look at another player's hand.",
    'bail-channis': "Look at another player's hand.",
    'ebling-mis': 'Compare hands with another player. Lower value is eliminated.',
    magnifico: 'Compare hands with another player. Lower value is eliminated.',
    'shielded-mind': 'Until your next turn, ignore effects from other players.',
    'bayta-darell': 'Choose any player to discard their hand and draw a new card.',
    'toran-darell': 'Choose any player to discard their hand and draw a new card.',
    'mayor-indbur': 'Trade hands with another player.',
    'first-speaker': 'If you hold this with Mayor Indbur or either Darell, you must discard it.',
    mule: 'If you discard this card, you are eliminated from the round.'
};

function build(id: CardTypeId): CardCopy {
    const def = CARD_CATALOG[id];
    return {
        id,
        displayName: def.displayName,
        value: def.value,
        effect: EFFECT_TEXT[id],
        portraitKey: `portrait-${def.assetSlug}`,
        ...(id === 'mule' ? { playWarning: 'Discard The Mule — you are eliminated.' } : {})
    };
}

export const CARD_COPY: Readonly<Record<CardTypeId, CardCopy>> = Object.fromEntries(
    (Object.keys(CARD_CATALOG) as CardTypeId[]).map(id => [id, build(id)])
) as Record<CardTypeId, CardCopy>;

export function cardCopyFor(id: CardTypeId): CardCopy {
    return CARD_COPY[id];
}
