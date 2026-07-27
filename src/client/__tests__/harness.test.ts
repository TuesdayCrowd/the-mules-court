import { describe, expect, it } from 'vitest';

describe('client test harness', () => {
    it('runs pure modules under Node with no DOM', () => {
        expect(typeof globalThis.document).toBe('undefined');
        expect(1 + 1).toBe(2);
    });
});
