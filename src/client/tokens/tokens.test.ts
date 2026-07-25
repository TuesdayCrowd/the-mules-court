import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOKENS } from './tokens';

/** `--color-nebula-red: #ef4444;` → `['colorNebulaRed', 0xef4444]` */
function parseCssTokens(css: string): Map<string, number> {
    const found = new Map<string, number>();
    const re = /--([a-z0-9-]+)\s*:\s*#([0-9a-f]{6})\s*;/gi;
    for (const [, name, hex] of css.matchAll(re)) {
        const camel = name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
        found.set(camel, parseInt(hex, 16));
    }
    return found;
}

describe('design tokens', () => {
    const css = parseCssTokens(readFileSync('src/client/styles/tokens.css', 'utf8'));

    it('finds every colour token declared in CSS', () => {
        expect(css.size).toBeGreaterThanOrEqual(14);
    });

    it('mirrors every CSS colour token in TypeScript with the same value', () => {
        for (const [name, value] of css) {
            expect(TOKENS, `missing TS token ${name}`).toHaveProperty(name);
            expect(TOKENS[name as keyof typeof TOKENS], `value drift on ${name}`).toBe(value);
        }
    });

    it('declares no TypeScript colour token absent from CSS', () => {
        for (const name of Object.keys(TOKENS)) {
            expect(css.has(name), `TS token ${name} has no CSS counterpart`).toBe(true);
        }
    });
});
