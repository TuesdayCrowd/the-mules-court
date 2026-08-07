/**
 * `bun build --compile`, minus the 63 MB it leaves behind.
 *
 * A successful compile whose target matches the host stages a copy of the Bun runtime —
 * `.<16 hex>-00000000.bun-build`, ~63 MB — in the process's working directory, and never
 * removes it. Nothing in `bun build` relocates it: it follows the *working directory*
 * rather than `--outfile`, ignores `TMPDIR` and `BUN_TMPDIR`, and has no flag of its own.
 * The name is random per run, so runs accumulate rather than overwrite, and `.gitignore`'s
 * `.*.bun-build` keeps every one of them out of `git status`. This repo had quietly
 * collected 189 MB that way before this wrapper existed.
 *
 * Compiling from a throwaway directory would sidestep the file entirely, and was rejected:
 * the working directory is also the root bun records for embedded module paths, so building
 * from elsewhere baked this machine's absolute checkout path into the binary — measured at
 * seven occurrences, against none today. The build stays where it was; the staging file goes.
 *
 * Only files that appear *during* this run are removed, so a compile running alongside keeps
 * its own. A failed compile writes no staging file, and neither does a cross-compile
 * (`--target` naming another platform), so this is a no-op for both.
 *
 * Usage: bun scripts/compileBinary.ts <bun build args...>
 */
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** The only shape bun stages under: a dotfile ending `.bun-build`. */
const STAGING = /^\..+\.bun-build$/;

const workingDir = process.cwd();

async function stagingFiles(): Promise<Set<string>> {
    const entries = await readdir(workingDir);
    return new Set(entries.filter((name) => STAGING.test(name)));
}

async function removeStagingFilesAddedSince(before: ReadonlySet<string>): Promise<number> {
    let removed = 0;
    for (const name of await stagingFiles()) {
        if (before.has(name)) continue;
        await rm(join(workingDir, name), { force: true });
        removed += 1;
    }
    return removed;
}

const args = process.argv.slice(2);
if (args.length === 0) {
    console.error('usage: bun scripts/compileBinary.ts <bun build args...>');
    process.exit(1);
}

const before = await stagingFiles();

// process.execPath rather than 'bun', so the compile runs under the same binary as this script.
const build = Bun.spawn([process.execPath, 'build', ...args], {
    cwd: workingDir,
    stdio: ['inherit', 'inherit', 'inherit'],
});

// Ctrl-C reaches the whole process group, so bun exits on its own. Registering a handler
// replaces the default "die immediately", which is what keeps the sweep below on the way out.
let signalled = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        signalled = true;
    });
}

const exitCode = await build.exited;
const removed = await removeStagingFilesAddedSince(before);

if (removed > 0) {
    console.log(`Removed ${removed} bun staging artifact${removed === 1 ? '' : 's'} (~63 MB each)`);
}

process.exit(signalled ? 130 : exitCode);
