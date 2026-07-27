/**
 * The client's two routes (UIX §2.6).
 *
 * Takes a pathname string rather than reading location, so the module stays
 * pure and testable; `main.ts` supplies `location.pathname`.
 *
 * `/join/:matchId` is the server's own `joinUrl` shape — `publicBaseUrl +
 * '/join/' + matchId` in `roomRegistry.ts` — and deliberately not the `/m/`
 * path VISUAL_SHOWCASE's mockup shows.
 */
export type Route = { kind: 'menu' } | { kind: 'join'; matchId: string } | { kind: 'unknown' };

const UNKNOWN: Route = { kind: 'unknown' };

export function parseRoute(pathname: string): Route {
    // A caller may hand over a whole URL tail rather than a bare pathname.
    // Dropping the query and fragment here beats gluing '?x=1' onto a matchId.
    const path = pathname.split('#')[0].split('?')[0];

    if (path === '/') return { kind: 'menu' };

    const segments = path.split('/').filter(segment => segment.length > 0);
    if (segments.length !== 2 || segments[0] !== 'join') return UNKNOWN;

    let matchId: string;
    try {
        matchId = decodeURIComponent(segments[1]);
    } catch {
        // A malformed escape is not an id worth guessing at, and throwing here
        // would take down the whole boot sequence over a mistyped link.
        return UNKNOWN;
    }

    return matchId.length === 0 ? UNKNOWN : { kind: 'join', matchId };
}
