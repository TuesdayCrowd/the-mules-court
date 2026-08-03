/**
 * Display names for computer opponents.
 *
 * A bot has no client to supply a nickname, so the server invents one — the
 * mirror of the host seat, whose nickname is adopted over the wire rather than
 * minted here. `nickname` is a `StoredSeat` field, so whatever is chosen is
 * written into the record and survives a rebuild unchanged.
 *
 * **Drawn from all three series, because they are one history.** Asimov
 * stitched the Robot novels, the Empire novels and the Foundation novels into a
 * single future in `Robots and Empire` and `Foundation's Edge` — Daneel Olivaw
 * is present at both ends of it. A table seating Susan Calvin against Golan
 * Trevize is not a crossover; it is the same universe at two of its ends, which
 * is exactly the joke the Mule would appreciate.
 *
 * Two rules bind every entry, and `__tests__/botNames.test.ts` enforces both
 * rather than trusting this comment:
 *
 *  - **No name here is a card.** A seat labelled "Bayta Darell" beside a
 *    discard pile holding Bayta Darell tells a player something false about the
 *    round.
 *  - **Every name fits `maxNicknameLength`.** These bypass CLAIM_SEAT's
 *    validation entirely — nothing sends them over the wire to be checked — so
 *    the limit a person is held to has to hold here by construction.
 */

/**
 * The Robot stories and novels: `I, Robot` through `Robots and Empire`.
 *
 * The two `R.` prefixes are kept because that is how the books print them, and
 * a robot sitting at a court of human intriguers should say so.
 */
export const ROBOT_NAMES: readonly string[] = [
    'Susan Calvin',
    'Alfred Lanning',
    'Peter Bogert',
    'Gregory Powell',
    'Mike Donovan',
    'Stephen Byerley',
    'Elijah Baley',
    'R. Daneel Olivaw',
    'R. Giskard Reventlov',
    'Gladia Delmarre',
    'Kelden Amadiro',
    'Vasilia Aliena',
    'Jander Panell',
    'Julius Enderby',
    'Roj Nemennuh Sarton'
];

/** The Empire novels: `Pebble in the Sky`, `The Stars, Like Dust`, `The Currents of Space`. */
export const EMPIRE_NAMES: readonly string[] = [
    'Joseph Schwartz',
    'Bel Arvardan',
    'Affret Shekt',
    'Pola Shekt',
    'Biron Farrill',
    'Artemisia oth Hinriad',
    'Gillbret oth Hinriad',
    'Simok Aratap',
    'Rizzett',
    'Myrlyn Terens',
    'Valona March',
    'Selim Junz',
    'Ludigan Abel'
];

/**
 * The Foundation novels, minus the eleven characters who are cards.
 *
 * The four the game shipped with — Preem Palver, Arkady Darell, Lathan Devers,
 * Ducem Barr — are kept and are no longer bound to a seat index.
 */
export const FOUNDATION_NAMES: readonly string[] = [
    'Hari Seldon',
    'Salvor Hardin',
    'Hober Mallow',
    'Limmar Ponyets',
    'Bel Riose',
    'Lathan Devers',
    'Ducem Barr',
    'Preem Palver',
    'Arkady Darell',
    'Jorane Sutt',
    'Sef Sermak',
    'Lewis Pirenne',
    'Lord Dorwin',
    'Poly Verisof',
    'Sennett Forell',
    'Homir Munn',
    'Jole Turbor',
    'Elvett Semic',
    'Golan Trevize',
    'Janov Pelorat',
    'Stor Gendibal',
    'Harla Branno',
    'Munn Li Compor',
    'Dors Venabili',
    'Yugo Amaryl',
    'Eto Demerzel',
    'Raych Seldon',
    'Wanda Seldon'
];

/** Chronological by era, which is also the order the books were written in. */
export const BOT_NAMES: readonly string[] = [...ROBOT_NAMES, ...EMPIRE_NAMES, ...FOUNDATION_NAMES];

/**
 * One name for a new computer opponent, avoiding every name already at the
 * table.
 *
 * `taken` is every occupied seat's nickname, not just the bots': nothing stops
 * a person typing "Hari Seldon", and a table with two of him is a table whose
 * log cannot be read.
 *
 * `draw` is injected rather than ambient so the choice replays. The transport
 * seeds it from the match id, on a stream separate from the one the opponents
 * think with — naming a seat must not change how it plays.
 */
export function pickBotName(taken: readonly string[], draw: () => number): string {
    const free = BOT_NAMES.filter(name => !taken.includes(name));

    // Unreachable at four seats against a pool of dozens, but the caller writes
    // this straight into a seat, so it must be a name rather than `undefined`.
    if (free.length === 0) return `Computer ${taken.length + 1}`;

    // Clamped rather than trusting `[0, 1)`. A draw of exactly 1 would index one
    // past the end and hand back `undefined` as a nickname.
    const ratio = Math.min(Math.max(draw(), 0), 1);
    return free[Math.min(Math.floor(ratio * free.length), free.length - 1)];
}
