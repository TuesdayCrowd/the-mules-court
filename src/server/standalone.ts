/**
 * Entrypoint for the single-file distributable (`bun run compile`).
 *
 * `index.ts` stays exactly as it is: it reads `dist/` off the real filesystem,
 * which is right for `bun run serve` and for every transport test. This file is
 * the same server with its client bytes compiled in, so the binary runs from
 * any directory with no dist/ beside it and nothing to install.
 *
 * Only the *lookup* differs — the routing rules come from `staticAssets.ts`,
 * shared, so a dead invite link cannot reach the binary without first appearing
 * in this repo's own test run. `standalone.test.ts` covers the wiring.
 *
 * Runnable uncompiled (`bun src/server/standalone.ts`) because a `type: 'file'`
 * import evaluates to a real path outside a binary and an embedded-VFS path
 * inside one, and `Bun.file` accepts both.
 */
import { resolve } from 'node:path';
import { EMBEDDED } from './embeddedAssets.generated';
import { configFromLaunch, startServer } from './index';
import { embeddedLookup, serveFrom } from './staticAssets';

const config = configFromLaunch();
const lookup = embeddedLookup(EMBEDDED);
const running = startServer(config, pathname => serveFrom(lookup, pathname));

// Say where the database went. It is created relative to the working directory,
// so a binary launched by double-click from a downloads folder writes there —
// silently, which is the kind of thing someone finds a week later.
const database = config.dbPath === ':memory:' ? 'in memory (nothing written)' : resolve(config.dbPath);

console.log(
    [
        ``,
        `  The Mule's Court`,
        ``,
        `  Playing at   ${config.publicBaseUrl}`,
        `  Database     ${database}`,
        `  Assets       ${EMBEDDED.size} files compiled in`,
        ``,
        `  --port=<1-65535> moves the port; MULES_DB_PATH and MULES_PUBLIC_BASE_URL`,
        `  (or MULES_PORT) change the rest.`,
        `  Press Ctrl-C to stop.`,
        ``
    ].join('\n')
);

// A hard kill leaves sqlite's write-ahead log behind. `stop()` closes the store
// and force-closes every live socket, which is the teardown path the transport
// tests already exercise.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        console.log('\n  Stopping…');
        running.stop();
        process.exit(0);
    });
}
