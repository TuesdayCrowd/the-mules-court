/**
 * Whether a static response is worth gzipping, as three separate decisions.
 *
 * Nothing compressed anything before this module existed. `Bun.serve` does not
 * compress on its own and `staticAssets.ts` handed `Bun.file` straight to a
 * `Response`, so a player downloaded the raw bytes: 1,376,427 of Phaser and
 * 81,339 of the app where gzip makes those 355,047 and 25,387. That is the
 * whole reason this file is here — the measurement is in
 * `docs/plans/2026-07-30-renderer-architecture-research.md` §9.
 *
 * Split into three predicates rather than one condition because each arm is
 * wrong in a different direction, and only the middle one is obvious:
 * compressing without being asked breaks a client that cannot decode it,
 * compressing a PNG spends CPU to make the response *larger*, and compressing
 * forty bytes adds an eighteen-byte header to save nothing.
 */

/**
 * Below this, gzip's own framing is a meaningful fraction of the body.
 *
 * 1 KiB is the conventional floor and the reason is arithmetic rather than
 * folklore: the header and trailer are 18 bytes, so on a 100-byte response a
 * good ratio still nets almost nothing, and on an incompressible one it loses.
 */
export const COMPRESSIBLE_FLOOR_BYTES = 1024;

/**
 * Whether the client said it can decode gzip.
 *
 * Parsed as tokens rather than searched as a substring: `includes('gzip')`
 * is true of `notgzip`, and `q=0` is the header's way of saying *not this one*
 * — a client that explicitly refuses gzip and gets it anyway receives bytes it
 * will not decode, which presents as a blank page rather than as an error.
 */
export function acceptsGzip(header: string | null): boolean {
    if (header === null || header === '') return false;

    return header.split(',').some(part => {
        const [name, ...params] = part.trim().toLowerCase().split(';');
        if (name?.trim() !== 'gzip') return false;

        // `q=0` is a refusal. Any other q, or none at all, is acceptance.
        const q = params.map(p => p.trim()).find(p => p.startsWith('q='));
        return q === undefined || Number(q.slice(2)) > 0;
    });
}

/**
 * Whether this content-type is text under the hood.
 *
 * An allowlist, not a denylist. `public/assets/` is 8.1 MB of PNG and woff2 —
 * formats that carry their own compression — and the cost of guessing wrong in
 * that direction is paid on every request for the art, which is most of them.
 * SVG is here because it is markup that happens to be typed as an image.
 */
export function compressibleType(type: string | null): boolean {
    if (type === null || type === '') return false;

    const essence = type.split(';')[0]?.trim().toLowerCase() ?? '';

    return (
        essence.startsWith('text/') ||
        essence === 'image/svg+xml' ||
        essence === 'application/javascript' ||
        essence === 'application/json' ||
        essence === 'application/manifest+json'
    );
}

/** All three arms together: the client asked, the bytes are text, and there are enough of them. */
export function shouldCompress(acceptEncoding: string | null, type: string | null, size: number): boolean {
    return acceptsGzip(acceptEncoding) && compressibleType(type) && size >= COMPRESSIBLE_FLOOR_BYTES;
}
