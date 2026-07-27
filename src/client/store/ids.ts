/**
 * Minting `clientMsgId`s and notice ids.
 *
 * `crypto.randomUUID` is **secure-context only** — on `http://` at anything but
 * `localhost` it is simply `undefined`, and calling it throws. That is not an
 * edge case here: testing multiplayer means opening the game on a phone at
 * `http://<lan-ip>:8080`, which is exactly where it disappears. It took the
 * whole play path down with it, because the throw landed inside a click handler
 * and looked from the outside like the button doing nothing.
 *
 * So the UUID is used when it exists and never depended on. These ids are echo
 * tags — the protocol caps them at 64 characters and treats them as opaque —
 * so uniqueness within one browser session is the entire requirement, and
 * nothing about them needs to be unguessable.
 */

export interface IdMinterDeps {
    /** `Date.now` in production; a fixed clock in tests. */
    readonly now: () => number;
    readonly random: () => number;
    /** `crypto.randomUUID` where the context allows it, absent where it does not. */
    readonly uuid?: () => string;
}

export function createIdMinter(deps: IdMinterDeps): () => string {
    let sequence = 0;

    return () => {
        if (deps.uuid !== undefined) return deps.uuid();

        // Time orders them, the counter separates ids minted in the same
        // millisecond, and the random tail keeps two tabs from colliding.
        const time = deps.now().toString(36);
        const seq = (sequence++).toString(36);
        const tail = Math.floor(deps.random() * 0xffffff).toString(36);
        return `${time}-${seq}-${tail}`;
    };
}

/** The real minter, preferring `crypto.randomUUID` when the context provides it. */
export function browserIdMinter(cryptoLike: { randomUUID?: () => string } | undefined): () => string {
    return createIdMinter({
        now: () => Date.now(),
        random: () => Math.random(),
        // Bound explicitly: reading the method off `crypto` and calling it bare
        // loses `this` in some engines.
        ...(typeof cryptoLike?.randomUUID === 'function'
            ? { uuid: () => (cryptoLike.randomUUID as () => string).call(cryptoLike) }
            : {})
    });
}
