/**
 * The wrapper, driven as a real subprocess against a real compile.
 *
 * The guarantee under test is a *negative* one — that a ~63 MB staging file is not
 * sitting in the working directory afterwards — and nothing short of an actual
 * `--compile` produces that file, so the first case pays for one. It runs in a fresh
 * temp directory, because the artifact follows the working directory and this suite
 * should not litter the checkout it is testing.
 *
 * The decoy in that first case is the concurrency guard: a staging file that was already
 * present must survive, since it may belong to a compile running alongside this one.
 */

import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const wrapper = join(import.meta.dir, 'compileBinary.ts');
const STAGING = /^\..+\.bun-build$/;

let dir: string;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'compile-binary-'));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

async function stagingFiles(): Promise<string[]> {
    return (await readdir(dir)).filter((name) => STAGING.test(name));
}

async function runWrapper(args: string[]): Promise<{ code: number; stderr: string }> {
    const child = Bun.spawn([process.execPath, wrapper, ...args], {
        cwd: dir,
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const stderr = await new Response(child.stderr).text();
    return { code: await child.exited, stderr };
}

/**
 * The control, and the reason the case below is not vacuous: without it, a wrapper that did
 * nothing at all would pass, since the assertion is that a file is absent. It is also the
 * canary — if a future Bun stops staging into the working directory this fails, and the
 * honest response is to delete the wrapper rather than to loosen the test.
 */
it('bare `bun build --compile` stages a file in the working directory', async () => {
    await writeFile(join(dir, 'cli.ts'), 'console.log("compiled ok");\n');

    const child = Bun.spawn([process.execPath, 'build', '--compile', 'cli.ts', '--outfile', 'out'], {
        cwd: dir,
        stdout: 'pipe',
        stderr: 'pipe',
    });

    expect(await child.exited).toBe(0);
    expect(await stagingFiles()).toHaveLength(1);
}, 120_000);

it('removes the staging file a successful compile leaves, and spares one it did not create', async () => {
    const decoy = '.decoy0000000000-00000000.bun-build';
    await writeFile(join(dir, decoy), 'not mine');
    await writeFile(join(dir, 'cli.ts'), 'console.log("compiled ok");\n');

    const { code } = await runWrapper(['--compile', 'cli.ts', '--outfile', 'out']);

    expect(code).toBe(0);
    expect(await stagingFiles()).toEqual([decoy]);

    // The binary itself still has to exist, or "no artifact" is trivially satisfied.
    const built = Bun.spawn([join(dir, 'out')], { stdout: 'pipe' });
    expect(await built.exited).toBe(0);
    expect(await new Response(built.stdout).text()).toContain('compiled ok');
}, 120_000);

it('passes a failed build\'s exit code through', async () => {
    const { code } = await runWrapper(['--compile', 'does-not-exist.ts', '--outfile', 'out']);

    expect(code).not.toBe(0);
    expect(await stagingFiles()).toEqual([]);
}, 30_000);

it('refuses to run with no arguments rather than invoking a bare `bun build`', async () => {
    const { code, stderr } = await runWrapper([]);

    expect(code).toBe(1);
    expect(stderr).toContain('usage:');
});
