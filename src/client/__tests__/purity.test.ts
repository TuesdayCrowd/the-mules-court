import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The client's pure layer, guarded the way the engine guards its own.
 *
 * "Importable and testable without Phaser" (UIX §2.1) is an architectural claim,
 * and claims decay the first time someone reaches for a global. These four
 * directories hold the decisions — geometry, copy, state, palette — so they are
 * the four that must stay reachable from a plain Node process.
 *
 * Note for anyone extending this: the assertions read raw file text, comments
 * included, so a comment naming one of the forbidden globals fails the test it
 * is describing. Name the injected interface instead of the global it wraps.
 */
const PURE_DIRS = ['src/client/layout', 'src/client/content', 'src/client/store', 'src/client/tokens'];

/** Every .ts file under `dir`, recursively, tests included. */
function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
        else if (full.endsWith('.ts')) out.push(full);
    }
    return out;
}

describe('pure client layer', () => {
    it('never imports Phaser', () => {
        for (const dir of PURE_DIRS) {
            for (const file of sourceFiles(dir)) {
                expect(readFileSync(file, 'utf8'), `${file} imports phaser`).not.toMatch(/from ['"]phaser['"]/);
            }
        }
    });

    it('never touches document or window outside injected dependencies', () => {
        // `store/` legitimately owns web storage and the socket, but only through
        // injected factories — the bare globals must not appear.
        //
        // The dot must be followed by the start of a property name. What is
        // banned is member ACCESS, and `content/` holds player-facing copy: UIX
        // §5 words SEAT_TAKEN as "This match is open in another window.", which
        // a bare /\bwindow\./ reads as a global reach and fails. Requiring an
        // identifier character after the dot keeps every real access caught
        // while letting English end a sentence.
        for (const dir of PURE_DIRS) {
            for (const file of sourceFiles(dir)) {
                if (file.endsWith('.test.ts')) continue;
                const src = readFileSync(file, 'utf8');
                expect(src, `${file} uses document`).not.toMatch(/\bdocument\.[A-Za-z_$]/);
                expect(src, `${file} uses window`).not.toMatch(/\bwindow\.[A-Za-z_$]/);
                expect(src, `${file} uses bare localStorage`).not.toMatch(/(?<!\.)\blocalStorage\b/);
            }
        }
    });

    it('takes only types from the server, with one documented exception', () => {
        // The client bundles for a browser; the server runs under Bun. A runtime
        // import across that line drags transport code into the game bundle, and
        // the failure mode is a build that succeeds and a page that does not.
        //
        // `content/nickname.ts` is the exception, argued in Task 22 and checked
        // rather than waved through: `src/server/config.ts` has zero imports and
        // touches neither Bun nor `process`, so it is a plain literal — and the
        // alternative is a second copy of the nickname limit that can drift into
        // the client sending exactly what the server refuses.
        const ALLOWED = new Set(['src/client/content/nickname.ts']);
        const runtimeServerImport = /^\s*import\s+(?!type\b)[^;]*?from\s+['"][^'"]*\/server\/[^'"]*['"]/m;

        for (const dir of PURE_DIRS) {
            for (const file of sourceFiles(dir)) {
                if (file.endsWith('.test.ts') || ALLOWED.has(file)) continue;
                expect(readFileSync(file, 'utf8'), `${file} imports server runtime`).not.toMatch(runtimeServerImport);
            }
        }
    });

    it('never reaches the browser audio or device globals', () => {
        // Added when the sound vocabulary landed. `store/sound.ts` holds every
        // frequency, envelope and gain in the game and must stay readable from a
        // plain Node process — but the checks above ban only the two globals
        // that existed when they were written, so the whole Web Audio surface
        // and everything hanging off the device object passed through freely.
        //
        // The pure layer decides what a thing sounds like; `ui/sound.ts` is the
        // only file allowed to know how to make a sound. The same goes for the
        // device object: vibration, media capabilities and the platform string
        // are all reasons a decision would silently stop being testable.
        const BANNED: ReadonlyArray<readonly [RegExp, string]> = [
            [/\bAudioContext\b/, 'builds an audio context'],
            [/\bwebkitAudioContext\b/, 'builds a prefixed audio context'],
            [/\bOfflineAudioContext\b/, 'builds an offline audio context'],
            [/\bnavigator\.[A-Za-z_$]/, 'reaches the device object']
        ];

        for (const dir of PURE_DIRS) {
            for (const file of sourceFiles(dir)) {
                if (file.endsWith('.test.ts')) continue;
                const src = readFileSync(file, 'utf8');
                for (const [pattern, complaint] of BANNED) {
                    expect(src, `${file} ${complaint}`).not.toMatch(pattern);
                }
            }
        }
    });

    it('never reaches a global through globalThis', () => {
        // The checks above ban `window.` and `document.` as member access, so
        // `globalThis.window.x` still trips them — but `globalThis.localStorage`
        // slipped past the bare-token check, whose lookbehind exists to permit
        // `deps.localStorage` on an injected object. Rather than patch that one
        // regex, close the hatch: `globalThis` is how *any* ambient global gets
        // reached, `fetch` and `WebSocket` included, and a pure module has no
        // business with any of them.
        for (const dir of PURE_DIRS) {
            for (const file of sourceFiles(dir)) {
                if (file.endsWith('.test.ts')) continue;
                expect(readFileSync(file, 'utf8'), `${file} reaches through globalThis`).not.toMatch(/\bglobalThis\b/);
            }
        }
    });
});
