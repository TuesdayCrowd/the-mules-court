import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { POINTER_POLICY } from './inputPolicy';

describe('the pointer policy', () => {
    it('keeps Phaser off the window', () => {
        // Not a preference. Phaser's MouseManager binds mousedown to window.top
        // and processes it precisely when `event.target !== canvas` — so with
        // this on, every tap on the action sheet also hit-tests the hand card
        // underneath and reopens the sheet for it.
        expect(POINTER_POLICY.windowEvents).toBe(false);
    });

    it('is the policy the game config actually uses', () => {
        // The constant is worthless if the config sets its own literal, and a
        // stray `input: { windowEvents: true }` would read as perfectly normal.
        const main = readFileSync('src/game/main.ts', 'utf8');
        expect(main).toContain('input: POINTER_POLICY');
        expect(main).not.toMatch(/input:\s*\{/);
    });
});
