/**
 * The entrypoint, driven the way a person drives it: as a process, with
 * arguments on the command line.
 *
 * Every other test in this directory calls `startServer` with a config it built
 * itself, which is right for the transport but leaves the `import.meta.main`
 * block — the ten lines that decide what a config *is* for a real launch —
 * covered by nothing. That gap is a real bug's hiding place: `--port=5000` was
 * accepted by `bun run` and by the binary, passed to the entrypoint, and
 * silently ignored, so the server bound :3000 and reported EADDRINUSE while the
 * user watched it disregard the port they had asked for.
 *
 * Spawning is the only way to make that claim. Slow by the standards of this
 * suite (a process boot each), so there are three cases and no more.
 */
import { describe, expect, it } from 'bun:test';

/**
 * A port nothing is listening on, found by asking the OS for one and letting it
 * go. Racy in principle; the alternative is hardcoding a number, which is racy
 * in practice — and against the developer's own running `dev:server` at that.
 */
function freePort(): number {
    const probe = Bun.serve({ port: 0, fetch: () => new Response('probe') });
    const { port } = probe;
    probe.stop(true);
    // `Bun.Server.port` is optional in the types (a unix-socket server has none).
    if (port === undefined) throw new Error('Bun.serve bound no port to probe with');
    return port;
}

/** The launch config every case here shares: no client to host, nothing on disk. */
const ENV = { ...process.env, MULES_STATIC_ROOT: undefined, MULES_DB_PATH: ':memory:' };

async function waitForRoom(port: number, proc: Bun.Subprocess): Promise<Response> {
    const deadline = Date.now() + 5000;
    for (;;) {
        try {
            return await fetch(`http://localhost:${port}/api/rooms`, { method: 'POST' });
        } catch (err) {
            if (proc.exitCode !== null) throw new Error(`server exited with ${proc.exitCode}`);
            if (Date.now() > deadline) throw err;
            await Bun.sleep(50);
        }
    }
}

describe('launching src/server/index.ts', () => {
    it('listens on the port --port names', async () => {
        const port = freePort();
        const proc = Bun.spawn(['bun', 'src/server/index.ts', `--port=${port}`], { env: ENV, stdout: 'pipe' });

        try {
            const res = await waitForRoom(port, proc);
            expect(res.status).toBe(201);
        } finally {
            proc.kill();
            await proc.exited;
        }
    }, 15_000);

    it('hands out an invite link naming that port, not the default', async () => {
        const port = freePort();
        const proc = Bun.spawn(['bun', 'src/server/index.ts', `--port=${port}`], { env: ENV, stdout: 'pipe' });

        try {
            const room = (await (await waitForRoom(port, proc)).json()) as { joinUrl: string };
            expect(room.joinUrl).toContain(`localhost:${port}`);
        } finally {
            proc.kill();
            await proc.exited;
        }
    }, 15_000);

    it('refuses an unrecognized argument with a message, not a stack trace', async () => {
        const proc = Bun.spawn(['bun', 'src/server/index.ts', '--prot=5000'], {
            env: ENV,
            stdout: 'pipe',
            stderr: 'pipe'
        });

        const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
        expect(exitCode).toBe(1);
        expect(stderr).toContain('--prot=5000');
        expect(stderr).toContain('--port');
        expect(stderr).not.toContain('at parseFlags');
    }, 15_000);
});
