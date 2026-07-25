import { CARD_CATALOG, INFORMANT_VALUE } from '../../game/engine';
import type { CardTypeId, CardValue } from '../../game/engine';
import type { CardCopy } from './cardCopy';
import { cardCopyFor } from './cardCopy';

/**
 * One row per card value, which is the unit the game actually reasons in.
 *
 * The Informant guesses a value, never a character, so a panel organised by
 * character would answer a question nobody asks. Characters that share a value
 * share a row: value 5 is "both Darells", and knowing that is the whole game.
 */
export interface QuickReferenceRow {
    readonly value: CardValue;
    /** Physical cards at this value — five at value 1, one at value 8. */
    readonly count: number;
    /** Every character holding this value, in catalog order. */
    readonly cards: readonly CardCopy[];
    /** False for the Informant's own value alone, which it may never guess. */
    readonly guessable: boolean;
}

function buildRows(): QuickReferenceRow[] {
    const byValue = new Map<CardValue, CardTypeId[]>();
    for (const id of Object.keys(CARD_CATALOG) as CardTypeId[]) {
        const { value } = CARD_CATALOG[id];
        const bucket = byValue.get(value);
        if (bucket === undefined) byValue.set(value, [id]);
        else bucket.push(id);
    }

    return [...byValue.entries()]
        .sort(([a], [b]) => b - a) // 8 down to 1: the panel reads highest-first
        .map(([value, ids]) => ({
            value,
            count: ids.reduce((sum, id) => sum + CARD_CATALOG[id].count, 0),
            cards: ids.map(cardCopyFor),
            guessable: value !== INFORMANT_VALUE
        }));
}

/** UIX §10's table, derived from the catalog so a new card cannot be forgotten. */
export const QUICK_REFERENCE: readonly QuickReferenceRow[] = buildRows();

/** Sixteen. Stated as a sum so the panel can never disagree with the deck. */
export function totalCards(): number {
    return QUICK_REFERENCE.reduce((sum, row) => sum + row.count, 0);
}
