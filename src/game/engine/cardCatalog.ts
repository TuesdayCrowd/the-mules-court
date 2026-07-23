import type { CardDef, CardInstanceId, CardTypeId, CardValue } from './types';

/**
 * The eleven card identities of The Mule's Court, totalling sixteen physical cards.
 *
 * Identity is separate from behaviour. Several values are split across two
 * differently named cards that share one ability: Han Pritcher and Bail Channis
 * are both PRIEST, Ebling Mis and Magnifico are both BARON, and the two Darells
 * are both PRINCE. Each keeps its own name, portrait, and instance identity while
 * resolving through the same effect.
 *
 * This table is static rules data. It holds no per-match secret, so a client may
 * safely receive it verbatim for card names and portrait lookup.
 */
export const CARD_CATALOG: Readonly<Record<CardTypeId, CardDef>> = {
    informant: {
        id: 'informant',
        displayName: 'Informant',
        value: 1,
        count: 5,
        assetSlug: 'informant',
        effectType: 'GUARD'
    },
    'han-pritcher': {
        id: 'han-pritcher',
        displayName: 'Han Pritcher',
        value: 2,
        count: 1,
        assetSlug: 'han-pritcher',
        effectType: 'PRIEST'
    },
    'bail-channis': {
        id: 'bail-channis',
        displayName: 'Bail Channis',
        value: 2,
        count: 1,
        assetSlug: 'bail-channis',
        effectType: 'PRIEST'
    },
    'ebling-mis': {
        id: 'ebling-mis',
        displayName: 'Ebling Mis',
        value: 3,
        count: 1,
        assetSlug: 'ebling-mis',
        effectType: 'BARON'
    },
    magnifico: {
        id: 'magnifico',
        displayName: 'Magnifico Giganticus',
        value: 3,
        count: 1,
        assetSlug: 'magnifico',
        effectType: 'BARON'
    },
    'shielded-mind': {
        id: 'shielded-mind',
        displayName: 'Shielded Mind',
        value: 4,
        count: 2,
        assetSlug: 'shielded-mind',
        effectType: 'HANDMAID'
    },
    'bayta-darell': {
        id: 'bayta-darell',
        displayName: 'Bayta Darell',
        value: 5,
        count: 1,
        assetSlug: 'bayta-darell',
        effectType: 'PRINCE'
    },
    'toran-darell': {
        id: 'toran-darell',
        displayName: 'Toran Darell',
        value: 5,
        count: 1,
        assetSlug: 'toran-darell',
        effectType: 'PRINCE'
    },
    'mayor-indbur': {
        id: 'mayor-indbur',
        displayName: 'Mayor Indbur',
        value: 6,
        count: 1,
        assetSlug: 'mayor-indbur',
        effectType: 'KING'
    },
    'first-speaker': {
        id: 'first-speaker',
        displayName: 'The First Speaker',
        value: 7,
        count: 1,
        assetSlug: 'first-speaker',
        effectType: 'COUNTESS'
    },
    mule: {
        id: 'mule',
        displayName: 'The Mule',
        value: 8,
        count: 1,
        assetSlug: 'mule',
        effectType: 'PRINCESS'
    }
};

/**
 * The Informant's own value, which it may never guess.
 *
 * Guessing names a VALUE rather than a character, because four values are shared
 * by two characters each — a guess of 5 catches either Darell. Naming a character
 * would halve the Informant's reach on every doubled value.
 */
export const INFORMANT_VALUE: CardValue = 1;

/** The values the deck contains, and therefore the range a guess may name. */
export const MIN_CARD_VALUE: CardValue = 1;
export const MAX_CARD_VALUE: CardValue = 8;

/** Builds the instance id for one physical copy of a card. */
export function makeCardInstanceId(cardId: CardTypeId, ordinal: number): CardInstanceId {
    return `${cardId}#${ordinal}`;
}

/**
 * Recovers a card's identity from an instance id.
 *
 * Splits on the final '#' because several slugs contain hyphens, and one day a
 * slug could contain anything else that a naive split would mangle.
 */
export function cardTypeOf(instanceId: CardInstanceId): CardTypeId {
    return instanceId.slice(0, instanceId.lastIndexOf('#')) as CardTypeId;
}

/** Every instance id in a fresh deck, in catalog order before shuffling. */
export function buildDeck(): CardInstanceId[] {
    const deck: CardInstanceId[] = [];
    for (const card of Object.values(CARD_CATALOG)) {
        for (let ordinal = 0; ordinal < card.count; ordinal++) {
            deck.push(makeCardInstanceId(card.id, ordinal));
        }
    }
    return deck;
}
