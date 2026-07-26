import { describe, expect, it } from 'vitest';
import type { KeyValueStore, StoredSeat } from './seatTokenStore';
import { createSeatTokenStore, seatStorageKey } from './seatTokenStore';

/** A Map-backed stand-in for web storage. No globals, no module mocking. */
function fakeStorage(initial: Record<string, string> = {}): KeyValueStore & { readonly map: Map<string, string> } {
    const map = new Map(Object.entries(initial));
    return {
        map,
        getItem: key => map.get(key) ?? null,
        setItem: (key, value) => void map.set(key, value),
        removeItem: key => void map.delete(key)
    };
}

/** Storage that refuses writes, as Safari private mode does. */
function readOnlyStorage(initial: Record<string, string> = {}): KeyValueStore {
    const inner = fakeStorage(initial);
    return {
        getItem: inner.getItem,
        setItem: () => {
            throw new DOMException('QuotaExceededError');
        },
        removeItem: inner.removeItem
    };
}

const SEAT: StoredSeat = { seat: 0, playerId: 'p1', seatToken: 'tok-abc' };

describe('seatStorageKey', () => {
    it('is namespaced per match, exactly as UIX §3 fixes it', () => {
        expect(seatStorageKey('K7QX2')).toBe('mules-court:K7QX2');
    });
});

describe('createSeatTokenStore', () => {
    it('round-trips a stored seat', () => {
        const store = createSeatTokenStore(fakeStorage());
        store.save('K7QX2', SEAT);
        expect(store.load('K7QX2')).toEqual(SEAT);
    });

    it('returns null for a match it has never seen', () => {
        expect(createSeatTokenStore(fakeStorage()).load('nope')).toBeNull();
    });

    it('clears exactly one match and leaves the others', () => {
        const store = createSeatTokenStore(fakeStorage());
        store.save('one', SEAT);
        store.save('two', { ...SEAT, seatToken: 'tok-two' });

        store.clear('one');

        expect(store.load('one')).toBeNull();
        expect(store.load('two')).toEqual({ ...SEAT, seatToken: 'tok-two' });
    });

    it('returns null for a corrupt value instead of throwing', () => {
        // A half-written entry must never brick the app on boot.
        const store = createSeatTokenStore(fakeStorage({ 'mules-court:K7QX2': '{not json' }));
        expect(store.load('K7QX2')).toBeNull();
    });

    it('returns null for well-formed JSON of the wrong shape', () => {
        const store = createSeatTokenStore(
            fakeStorage({ 'mules-court:K7QX2': JSON.stringify({ seat: 0, playerId: 'p1' }) })
        );
        expect(store.load('K7QX2')).toBeNull();
    });

    it('rejects a stored seat whose fields have the wrong types', () => {
        const store = createSeatTokenStore(
            fakeStorage({ 'mules-court:K7QX2': JSON.stringify({ seat: '0', playerId: 'p1', seatToken: 'tok' }) })
        );
        expect(store.load('K7QX2')).toBeNull();
    });

    it('rejects a JSON array, which is an object but not a seat', () => {
        const store = createSeatTokenStore(fakeStorage({ 'mules-court:K7QX2': '[]' }));
        expect(store.load('K7QX2')).toBeNull();
    });

    it('degrades to no-stored-seat when writing throws, rather than crashing', () => {
        // Safari private mode throws on setItem. Losing the token costs a
        // reconnect; an exception here would cost the whole boot.
        const store = createSeatTokenStore(readOnlyStorage());
        expect(() => store.save('K7QX2', SEAT)).not.toThrow();
        expect(store.load('K7QX2')).toBeNull();
    });

    it('survives a storage that throws on clear', () => {
        const store = createSeatTokenStore({
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {
                throw new DOMException('SecurityError');
            }
        });
        expect(() => store.clear('K7QX2')).not.toThrow();
    });

    it('survives a storage that throws on read', () => {
        const store = createSeatTokenStore({
            getItem: () => {
                throw new DOMException('SecurityError');
            },
            setItem: () => {},
            removeItem: () => {}
        });
        expect(store.load('K7QX2')).toBeNull();
    });

    it('writes under the namespaced key and nowhere else', () => {
        const storage = fakeStorage();
        createSeatTokenStore(storage).save('K7QX2', SEAT);
        expect([...storage.map.keys()]).toEqual(['mules-court:K7QX2']);
    });
});
