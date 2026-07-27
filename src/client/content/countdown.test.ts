import { describe, expect, it } from 'vitest';
import { secondsRemaining } from './countdown';

describe('secondsRemaining', () => {
    it('renders seconds remaining from revealDeadline against the server clock', () => {
        const snapshot = { revealDeadline: 10_000, serverTime: 5_000, receivedAt: 1_000 } as const;
        expect(secondsRemaining(snapshot, 1_000)).toBe(5); // no local drift yet
        expect(secondsRemaining(snapshot, 3_000)).toBe(3); // 2s of local elapsed time
    });

    it('never returns a negative countdown', () => {
        expect(secondsRemaining({ revealDeadline: 10_000, serverTime: 5_000, receivedAt: 1_000 }, 99_000)).toBe(0);
    });

    it('returns null when no deadline is present', () => {
        expect(secondsRemaining({ serverTime: 5_000, receivedAt: 1_000 }, 1_000)).toBeNull();
    });

    it('shows a full five seconds again after a reconnect restarts the window', () => {
        // The transport never resumes a partial window (UIX §9.1), so a fresh
        // snapshot with a later deadline simply reads as five.
        expect(secondsRemaining({ revealDeadline: 20_000, serverTime: 15_000, receivedAt: 2_000 }, 2_000)).toBe(5);
    });

    it('measures elapsed time locally but takes the deadline from the server alone', () => {
        // Interface rule 5. The local clock only ages the server's own reading;
        // it never decides when the window ends, so a client whose wall clock is
        // an hour out still counts down five seconds.
        const skewed = { revealDeadline: 10_000, serverTime: 5_000, receivedAt: 3_600_000 } as const;
        expect(secondsRemaining(skewed, 3_600_000)).toBe(5);
        expect(secondsRemaining(skewed, 3_602_000)).toBe(3);
    });

    it('rounds up, so a countdown shows 1 until the moment it is actually over', () => {
        const snapshot = { revealDeadline: 10_000, serverTime: 5_000, receivedAt: 0 } as const;
        expect(secondsRemaining(snapshot, 4_001)).toBe(1); // 999ms left
        expect(secondsRemaining(snapshot, 5_000)).toBe(0);
    });

    it('reads zero at the deadline itself', () => {
        expect(secondsRemaining({ revealDeadline: 10_000, serverTime: 10_000, receivedAt: 0 }, 0)).toBe(0);
    });
});
