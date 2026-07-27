/**
 * Static hosting, split so one set of rules can serve two sources of bytes.
 *
 * `serveFrom` owns the *policy* — decode, exact hit, SPA fallback for an
 * extensionless path, 404 for anything else (UIX §2.6). A `Lookup` owns
 * *resolution*, and only that differs between the two deployments this repo
 * ships: the filesystem lookup resolves against a directory and must refuse
 * traversal, while the embedded lookup a compiled binary uses is a `Map.get`
 * that cannot escape anything by construction.
 *
 * Duplicating the policy per source is the failure this file exists to prevent.
 * The drift would surface as a dead invite link from a downloaded binary, with
 * nothing in the repo's own test run to catch it — the routing rules would look
 * right in the file everybody reads and be wrong in the file nobody does.
 */
import { resolve, sep } from 'node:path';

/** Resolves an already-decoded, in-root request path to a file, or null. */
export type Lookup = (pathname: string) => Promise<Bun.BunFile | null>;

/**
 * Serves `pathname` through `lookup`, applying the routing policy.
 *
 * The extension test reads the *request* path rather than a resolved one: a
 * path with no extension is a client route, so it gets the app shell and the
 * router sorts it out, while a missing `.png` stays a 404 because pretending a
 * broken asset is the homepage hides the breakage.
 *
 * Reading the request path also fixes a case the resolved-path version got
 * wrong — a request for '/' resolves to the root directory itself, so its
 * basename was the directory's own name, and a root whose name contained a dot
 * refused to serve the homepage. `staticAssets.test.ts` pins that.
 */
export async function serveFrom(lookup: Lookup, pathname: string): Promise<Response> {
    let decoded: string;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        // A malformed percent-escape is not a path worth guessing at.
        return new Response('Not Found', { status: 404 });
    }

    // Refused here rather than in a lookup, because a lookup can only answer
    // "no file", and "no file" is what triggers the shell fallback below. A
    // traversal that reached that fallback would be answered with the app's
    // homepage and a 200 — `/../../etc/passwd` has no extension, so it reads as
    // a client route. Neither source has a legitimate parent-directory segment:
    // one has no directory to leave, the other must never leave it.
    if (decoded.split('/').includes('..')) {
        return new Response('Not Found', { status: 404 });
    }

    const hit = await lookup(decoded);
    if (hit !== null) return new Response(hit);

    const lastSegment = decoded.slice(decoded.lastIndexOf('/') + 1);
    if (!lastSegment.includes('.')) {
        const shell = await lookup(SHELL_PATH);
        if (shell !== null) return new Response(shell);
    }

    return new Response('Not Found', { status: 404 });
}

/** The app shell every client route falls back to. */
export const SHELL_PATH = '/index.html';

/**
 * Reads from a directory on disk, refusing any path that escapes it.
 *
 * The resolve-then-prefix-check is the whole security story: `resolve`
 * collapses every `..`, and a resolved path that no longer starts with the root
 * is refused before `Bun.file` ever opens it. Percent-encoded traversal is
 * covered because `serveFrom` decodes first and this resolves second — checking
 * a raw pathname would miss `%2e%2e`, and decoding after resolving would
 * reintroduce it.
 *
 * The `target !== base` arm matters: a request for `/` resolves to the root
 * itself, which is legitimate and does not carry the trailing separator the
 * prefix test looks for. Comparing against `base + sep` alone would refuse the
 * homepage; comparing against `base` alone would let `/../dist-evil` through on
 * a sibling directory whose name merely starts with the root's.
 */
export function filesystemLookup(root: string): Lookup {
    const base = resolve(root);

    return async pathname => {
        const target = resolve(base, '.' + pathname);
        if (target !== base && !target.startsWith(base + sep)) return null;

        // `resolve` strips a trailing separator, so a request for '/' lands on
        // the directory itself. `Bun.file(dir).exists()` is false, which is the
        // answer we want — `serveFrom`'s shell fallback handles it from there.
        const file = Bun.file(target);
        return (await file.exists()) ? file : null;
    };
}

/**
 * Reads from the manifest `bun build --compile` embedded into the binary.
 *
 * The map's values are whatever `import … with { type: 'file' }` evaluated to:
 * an absolute filesystem path when run under `bun`, an opaque embedded-VFS path
 * inside a compiled binary. `Bun.file` accepts both, which is why
 * `standalone.ts` is runnable — and testable — with no 61 MB build step.
 *
 * No traversal guard, deliberately: a `Map.get` for '/../../etc/passwd' misses,
 * and there is no directory to escape into. The `exists` check is not
 * ceremonial either — run uncompiled, these paths are real files that a rebuild
 * can rename out from under a stale manifest.
 */
export function embeddedLookup(embedded: ReadonlyMap<string, string>): Lookup {
    return async pathname => {
        const target = embedded.get(pathname === '/' ? SHELL_PATH : pathname);
        if (target === undefined) return null;

        const file = Bun.file(target);
        return (await file.exists()) ? file : null;
    };
}
