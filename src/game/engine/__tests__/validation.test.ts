import { describe, it, expect } from 'vitest';
import { validateAction } from '../validation';
import { makeRound, makePlayers } from './helpers';
import type { PlayCardAction, RoundState, ValidationResult } from '../types';

const action = (overrides: Partial<PlayCardAction> = {}): PlayCardAction => ({
    type: 'PLAY_CARD',
    playerId: 'p0',
    cardInstanceId: 'informant#0',
    ...overrides
});

/** Asserts the result is a rejection carrying the given code, and optionally the reason. */
const expectError = (result: ValidationResult, code: string, reason?: string) => {
    expect(result.ok).toBe(false);
    if (!result.ok) {
        expect(result.error.code).toBe(code);
        if (reason !== undefined) {
            expect((result.error as { reason?: string }).reason).toBe(reason);
        }
    }
};

const twoPlayerRound = (): RoundState =>
    makeRound({
        players: makePlayers({
            p0: { hand: ['informant#0', 'han-pritcher#0'] },
            p1: { hand: ['mule#0'] }
        })
    });

describe('validateAction — turn and ownership', () => {
    it('accepts a legal play', () => {
        const result = validateAction(twoPlayerRound(), action({ target: 'p1', guess: 'mule' }));
        expect(result.ok).toBe(true);
    });

    it('rejects a play made out of turn', () => {
        const result = validateAction(twoPlayerRound(), action({ playerId: 'p1', cardInstanceId: 'mule#0' }));
        expectError(result, 'NOT_YOUR_TURN');
    });

    it('rejects a card the player does not hold', () => {
        const result = validateAction(twoPlayerRound(), action({ cardInstanceId: 'mayor-indbur#0' }));
        expectError(result, 'CARD_NOT_IN_HAND');
    });

    it('rejects any play once the round is over', () => {
        const round = { ...twoPlayerRound(), phase: 'round-over' as const };
        expectError(validateAction(round, action({ target: 'p1', guess: 'mule' })), 'ROUND_NOT_IN_PROGRESS');
    });
});

describe('validateAction — the First Speaker forced-play rule', () => {
    const forcedRound = (): RoundState =>
        makeRound({
            players: makePlayers({
                p0: { hand: ['first-speaker#0', 'mayor-indbur#0'] },
                p1: { hand: ['mule#0'] }
            })
        });

    it('accepts playing the First Speaker when it is forced', () => {
        expect(validateAction(forcedRound(), action({ cardInstanceId: 'first-speaker#0' })).ok).toBe(true);
    });

    it('rejects playing the other card while the First Speaker is forced', () => {
        const result = validateAction(forcedRound(), action({ cardInstanceId: 'mayor-indbur#0', target: 'p1' }));
        expectError(result, 'FORCED_PLAY_VIOLATION');
    });
});

describe('validateAction — targeting', () => {
    it('rejects a missing target when legal targets exist', () => {
        expectError(validateAction(twoPlayerRound(), action({ guess: 'mule' })), 'TARGET_REQUIRED');
    });

    it('rejects a target for an effect that takes none', () => {
        const round = makeRound({
            players: makePlayers({ p0: { hand: ['shielded-mind#0'] }, p1: { hand: ['mule#0'] } })
        });
        const result = validateAction(round, action({ cardInstanceId: 'shielded-mind#0', target: 'p1' }));
        expectError(result, 'TARGET_NOT_ALLOWED');
    });

    it('accepts an effect that takes no target', () => {
        const round = makeRound({
            players: makePlayers({ p0: { hand: ['shielded-mind#0'] }, p1: { hand: ['mule#0'] } })
        });
        expect(validateAction(round, action({ cardInstanceId: 'shielded-mind#0' })).ok).toBe(true);
    });

    it('rejects targeting a protected opponent', () => {
        const round = makeRound({
            players: makePlayers({
                p0: { hand: ['informant#0'] },
                p1: { hand: ['mule#0'], protected: true },
                p2: { hand: ['magnifico#0'] }
            })
        });
        const result = validateAction(round, action({ target: 'p1', guess: 'mule' }));
        expectError(result, 'TARGET_NOT_LEGAL', 'PROTECTED');
    });

    it('rejects an eliminated target', () => {
        const round = makeRound({
            players: makePlayers({
                p0: { hand: ['informant#0'] },
                p1: { hand: [], alive: false },
                p2: { hand: ['magnifico#0'] }
            })
        });
        expectError(validateAction(round, action({ target: 'p1', guess: 'mule' })), 'TARGET_NOT_LEGAL', 'ELIMINATED');
    });

    it('rejects an unknown target', () => {
        expectError(
            validateAction(twoPlayerRound(), action({ target: 'nobody', guess: 'mule' })),
            'TARGET_NOT_LEGAL',
            'UNKNOWN_PLAYER'
        );
    });

    // A PRINCE may reach itself but must never reach a protected opponent.
    it('rejects a PRINCE targeting a protected opponent', () => {
        const round = makeRound({
            players: makePlayers({
                p0: { hand: ['bayta-darell#0'] },
                p1: { hand: ['mule#0'], protected: true }
            })
        });
        const result = validateAction(round, action({ cardInstanceId: 'bayta-darell#0', target: 'p1' }));
        expectError(result, 'TARGET_NOT_LEGAL', 'PROTECTED');
    });

    it('accepts a PRINCE targeting itself', () => {
        const round = makeRound({
            players: makePlayers({
                p0: { hand: ['bayta-darell#0', 'mule#0'] },
                p1: { hand: ['magnifico#0'], protected: true }
            })
        });
        const result = validateAction(round, action({ cardInstanceId: 'bayta-darell#0', target: 'p0' }));
        expect(result.ok).toBe(true);
    });
});

describe('validateAction — self-targeting a card that forbids it', () => {
    it('rejects an Informant aimed at its own player, naming the reason', () => {
        const round = makeRound({
            players: makePlayers({
                p0: { hand: ['informant#0', 'magnifico#0'] },
                p1: { hand: ['mule#0'] }
            })
        });
        expectError(
            validateAction(round, action({ target: 'p0', guess: 'mule' })),
            'TARGET_NOT_LEGAL',
            'SELF_NOT_ALLOWED'
        );
    });

    it('rejects a King aimed at its own player', () => {
        const round = makeRound({
            players: makePlayers({
                p0: { hand: ['mayor-indbur#0', 'magnifico#0'] },
                p1: { hand: ['mule#0'] }
            })
        });
        expectError(
            validateAction(round, action({ cardInstanceId: 'mayor-indbur#0', target: 'p0' })),
            'TARGET_NOT_LEGAL',
            'SELF_NOT_ALLOWED'
        );
    });
});

describe('validateAction — the guess must name a real card', () => {
    it('rejects a guess that is not a known card identity', () => {
        const result = validateAction(
            twoPlayerRound(),
            action({ target: 'p1', guess: 'not-a-card' as never })
        );
        expect(result.ok).toBe(false);
    });
});

describe('validateAction — the no-valid-target fizzle', () => {
    const fizzleRound = (): RoundState =>
        makeRound({
            players: makePlayers({
                p0: { hand: ['informant#0', 'han-pritcher#0'] },
                p1: { hand: ['mule#0'], protected: true }
            })
        });

    it('accepts an omitted target when every opponent is protected', () => {
        expect(validateAction(fizzleRound(), action()).ok).toBe(true);
    });

    it('rejects supplying a target when none is legal', () => {
        expectError(validateAction(fizzleRound(), action({ target: 'p1' })), 'TARGET_NOT_ALLOWED');
    });

    it('rejects a guess when the play has fizzled', () => {
        expectError(validateAction(fizzleRound(), action({ guess: 'mule' })), 'GUESS_NOT_ALLOWED');
    });
});

describe('validateAction — the Informant guess', () => {
    it('rejects a missing guess when a target exists', () => {
        expectError(validateAction(twoPlayerRound(), action({ target: 'p1' })), 'GUESS_REQUIRED');
    });

    it('rejects naming the Informant itself', () => {
        const result = validateAction(twoPlayerRound(), action({ target: 'p1', guess: 'informant' }));
        expectError(result, 'GUESS_CANNOT_BE_INFORMANT');
    });

    it('accepts naming any other card', () => {
        expect(validateAction(twoPlayerRound(), action({ target: 'p1', guess: 'first-speaker' })).ok).toBe(true);
    });

    it('rejects a guess on an effect that takes none', () => {
        const result = validateAction(
            twoPlayerRound(),
            action({ cardInstanceId: 'han-pritcher#0', target: 'p1', guess: 'mule' })
        );
        expectError(result, 'GUESS_NOT_ALLOWED');
    });
});

describe('validateAction — purity', () => {
    it('never mutates the round it inspects', () => {
        const round = twoPlayerRound();
        const snapshot = JSON.parse(JSON.stringify(round));
        validateAction(round, action({ target: 'p1', guess: 'mule' }));
        validateAction(round, action({ cardInstanceId: 'mayor-indbur#0' }));
        expect(JSON.parse(JSON.stringify(round))).toEqual(snapshot);
    });
});
