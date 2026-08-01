/**
 * Which artwork each character wears, and which card stock they are printed on
 * (UIX §12).
 *
 * Four thematic variants exist per character (`portrait_0` … `portrait_3`,
 * catalogued in `PORTRAIT_PROMPTS.md`). This file is the **only** place in the
 * client that names one, so a curation decision is a one-line edit here and
 * nothing downstream has to be found and changed.
 *
 * Only the *chosen* variant lives under `public/assets/<slug>/`, because Vite
 * copies `public/` into the bundle verbatim — shipping all four would put
 * ~13 MB of unused art in front of every player. The unchosen three live in
 * `art/portraits/<slug>/`, tracked but never built. Choosing one is therefore
 * two steps: move the file into `public/assets/<slug>/`, then edit the line
 * below. `portraits.test.ts` fails loudly if the edit lands without the move.
 */

import { CARD_CATALOG } from '../../game/engine';
import type { CardTypeId } from '../../game/engine';

export type PortraitVariant = 'portrait_0' | 'portrait_1' | 'portrait_2' | 'portrait_3';

/**
 * The curation pass (UIX §12) is the project owner's aesthetic call. Until it
 * runs, every character uses `portrait_0` (the base variant). Changing a choice
 * is a one-line edit here; nothing else in the client names a variant.
 */
export const PORTRAIT_CHOICE: Readonly<Record<CardTypeId, PortraitVariant>> = {
    informant: 'portrait_0',
    'han-pritcher': 'portrait_0',
    'bail-channis': 'portrait_0',
    'ebling-mis': 'portrait_0',
    magnifico: 'portrait_0',
    'shielded-mind': 'portrait_0',
    'bayta-darell': 'portrait_0',
    'toran-darell': 'portrait_0',
    'mayor-indbur': 'portrait_0',
    'first-speaker': 'portrait_0',
    mule: 'portrait_0'
};

/**
 * Path under `public/assets/`, built from the catalog's own `assetSlug`.
 *
 * The slug is not always the display name — Magnifico Giganticus lives in
 * `magnifico/`, The First Speaker in `first-speaker/` — so it is read from the
 * catalog rather than derived from the id.
 */
export function portraitPath(id: CardTypeId): string {
    return `${CARD_CATALOG[id].assetSlug}/${PORTRAIT_CHOICE[id]}.png`;
}

/**
 * The card stock, chosen by measurement rather than taste.
 *
 * `card_back_2.png` is 768×1024, the same 0.75 aspect the layout gives every
 * card; the square alternate would have needed cropping to sit in the same box.
 *
 * There is no matching card FRONT. A card is its portrait, with the value badge
 * and the name strip drawn over the art — so a frame to drop that art into is a
 * thing this game does not have.
 */
export const CARD_BACK_ASSET = 'card-back/card_back_2.png';
