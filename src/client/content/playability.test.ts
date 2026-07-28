import { describe, expect, it } from 'vitest';
import { cardCopyFor } from './cardCopy';
import { forcedPlayCaption, forcedPlaySentence, NOT_YOUR_TURN, NO_LEGAL_TARGET } from './playability';

describe('the forced-play wording', () => {
    it('names the card the engine left legal', () => {
        expect(forcedPlaySentence('first-speaker')).toContain(cardCopyFor('first-speaker').displayName);
        expect(forcedPlayCaption('first-speaker')).toContain(cardCopyFor('first-speaker').displayName);
    });

    /**
     * The canvas caption sits under a dimmed card that is already labelled, so
     * it is a fragment. The sheet's line stands alone and is read aloud, so it
     * is a sentence. One name source, two registers — the failure this guards
     * against is the two surfaces describing the same rule differently.
     */
    it('gives the canvas a fragment and the sheet a sentence', () => {
        expect(forcedPlayCaption('first-speaker')).toBe('must play The First Speaker');
        expect(forcedPlaySentence('first-speaker')).toBe('You must play The First Speaker this turn.');
    });

    it('works for any forcing card, not only the one the rule is named after', () => {
        // The engine expresses the rule over effect categories, so a card added
        // later can force. Nothing here may hardcode a character.
        expect(forcedPlaySentence('mule')).toContain('The Mule');
    });
});

describe('the other two reasons', () => {
    it('says whose turn it is without claiming a rule about targets', () => {
        expect(NOT_YOUR_TURN).toContain('Not your turn');
        expect(NOT_YOUR_TURN).not.toContain('protected');
    });

    it('reserves the protected-or-eliminated line for a card that really can be played', () => {
        expect(NO_LEGAL_TARGET).toContain('protected or eliminated');
        expect(NO_LEGAL_TARGET).toContain('no effect');
    });
});
