import { describe, expect, it } from 'vitest';
import { parseRoute } from './routes';

describe('parseRoute', () => {
    it('reads the menu at the root', () => {
        expect(parseRoute('/')).toEqual({ kind: 'menu' });
    });

    it('reads a join route', () => {
        expect(parseRoute('/join/K7QX2')).toEqual({ kind: 'join', matchId: 'K7QX2' });
    });

    it('tolerates a trailing slash', () => {
        expect(parseRoute('/join/K7QX2/')).toEqual({ kind: 'join', matchId: 'K7QX2' });
    });

    it('treats a join route with no id as unknown', () => {
        expect(parseRoute('/join/')).toEqual({ kind: 'unknown' });
        expect(parseRoute('/join')).toEqual({ kind: 'unknown' });
    });

    it('treats anything else as unknown', () => {
        expect(parseRoute('/m/K7QX2')).toEqual({ kind: 'unknown' }); // the old VISUAL_SHOWCASE shape
        expect(parseRoute('/join/a/b')).toEqual({ kind: 'unknown' });
    });

    it('reads the real matchId shape the server mints', () => {
        // roomRegistry mints a 32-character lowercase hex id; the route must not
        // be tighter than what the server actually hands out.
        const minted = 'd25d40de47413d61bc53b26622e146fe';
        expect(parseRoute(`/join/${minted}`)).toEqual({ kind: 'join', matchId: minted });
    });

    it('decodes a percent-escaped id rather than passing the escape through', () => {
        expect(parseRoute('/join/K7%20QX2')).toEqual({ kind: 'join', matchId: 'K7 QX2' });
    });

    it('treats a malformed percent-escape as unknown instead of throwing', () => {
        expect(parseRoute('/join/%ZZ')).toEqual({ kind: 'unknown' });
    });

    it('treats an empty pathname as unknown', () => {
        expect(parseRoute('')).toEqual({ kind: 'unknown' });
    });

    it('ignores a query string and a fragment', () => {
        // `location.pathname` excludes both, but a caller passing a whole URL
        // fragment should not silently produce a matchId with a query glued on.
        expect(parseRoute('/join/K7QX2?x=1')).toEqual({ kind: 'join', matchId: 'K7QX2' });
        expect(parseRoute('/join/K7QX2#top')).toEqual({ kind: 'join', matchId: 'K7QX2' });
    });
});
