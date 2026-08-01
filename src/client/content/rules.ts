/**
 * How the game is played, in the words a player reads (UIX §6.2).
 *
 * The card reference answers "what does a 5 do". This answers the questions it
 * cannot: how a round ends, what happens when you are eliminated, and — the one
 * the table never stated anywhere — **how many devotion tokens win the match**.
 *
 * That number is not a constant. It is seven at two players, five at three and
 * four at four, because a shorter table needs more rounds to mean anything. So
 * the rules are a function of the match rather than a fixed block of prose, and
 * a player reading them is told the target for the table they are actually at.
 *
 * Everything here restates the engine; nothing here decides anything. Where a
 * number appears it is derived from `RedactedView`, so a rule cannot drift from
 * the rules being enforced a few modules away.
 */

import { CARD_CATALOG } from '../../game/engine';
import type { CardTypeId } from '../../game/engine';

export interface RuleSection {
    readonly heading: string;
    readonly lines: readonly string[];
}

const nameOf = (id: CardTypeId): string => CARD_CATALOG[id].displayName;

/** How many cards are removed before play, by table size (`SETUP_TABLE`). */
function setupLine(playerCount: number): string {
    if (playerCount === 2) {
        return 'At two players, one card is set aside face up and two face down — so three cards never appear.';
    }
    if (playerCount === 3) {
        return 'At three players, one card is set aside face down, unseen for the whole round.';
    }
    return 'At four players nothing is set aside: every one of the sixteen cards is dealt, drawn, or discarded.';
}

/**
 * The rules for one table.
 *
 * `tokensToWin` and `playerCount` come from the live view, so this is the match
 * in front of the player rather than the game in the abstract.
 */
export function rulesFor(tokensToWin: number, playerCount: number): readonly RuleSection[] {
    return [
        {
            heading: 'Winning the match',
            lines: [
                `Win a round and you earn one devotion token. The first player to ${tokensToWin} tokens wins the court.`,
                'If two players reach the target together, they keep playing until one of them wins a round outright.'
            ]
        },
        {
            heading: 'Your turn',
            lines: [
                'Draw one card, so you hold two. Play one of them and resolve its ability.',
                'You may not decline. A card with no legal target is still played and still discarded; its ability simply does nothing.'
            ]
        },
        {
            heading: 'Winning a round',
            lines: [
                'A round ends when only one player is left, or when the deck runs out.',
                'On an empty deck the highest card held wins. If those tie, the larger total of discarded values wins — so the cards you spent still count.',
                setupLine(playerCount)
            ]
        },
        {
            heading: 'Being eliminated',
            lines: [
                'An eliminated player is out for the round, not the match, and their hand is turned face up for everyone to see.',
                `Playing ${nameOf('shielded-mind')} protects you until your own next turn: while protected you cannot be chosen as a target at all.`
            ]
        },
        {
            heading: 'Two rules that catch people out',
            lines: [
                `Discard ${nameOf('mule')} for any reason and you are out of the round — including when someone else forces you to.`,
                `Hold ${nameOf('first-speaker')} beside ${nameOf('mayor-indbur')} or either Darell and you must play the ${nameOf('first-speaker')}; the choice is taken away from you.`,
                'Guesses name a value, never a character — so guessing 5 catches either Darell, and 1 may never be guessed.'
            ]
        }
    ];
}
