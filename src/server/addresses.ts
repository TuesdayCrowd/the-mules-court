/**
 * Which addresses a person can actually type to reach this server.
 *
 * `Bun.serve` is given no `hostname` (`index.ts`), so it binds every interface
 * and the server is on the LAN the moment it starts. The banner said
 * `http://localhost:<port>` anyway, which is the one address that is guaranteed
 * *not* to work from the phone someone is holding — so the fact that LAN play
 * needs no configuration was invisible, and looked instead like a missing
 * feature.
 *
 * Pure, and takes the interface record rather than calling `os` itself, because
 * the interesting behaviour is the filtering and a test cannot choose what
 * hardware it runs on.
 *
 * **The filtering is the feature.** A developer laptop reports far more than it
 * can be reached on: this machine offers eight link-local IPv6 addresses across
 * `awdl0` (AirDrop), `llw0` and four `utun*` VPN tunnels, none of which anyone
 * is going to key into a phone. Listing everything would bury the single usable
 * line and be worse than the one address it replaced.
 */

/** The shape of one entry in `os.networkInterfaces()`, narrowed to what matters here. */
export interface InterfaceAddress {
    readonly address: string;
    /** Bun and Node ≥18 both report the string form. */
    readonly family: string;
    readonly internal: boolean;
}

/** `os.networkInterfaces()`. Values are optional — Node types them that way, and it does happen. */
export type InterfaceRecord = Record<string, readonly InterfaceAddress[] | undefined>;

export interface ReachableAddress {
    readonly url: string;
    /** The interface name, or a plain-language label for loopback. */
    readonly label: string;
}

/**
 * Link-local. The interface asked for a lease and never got one, so the address
 * is self-assigned and routes nowhere — offering it sends someone to a dead page
 * and makes the list look untrustworthy.
 */
const LINK_LOCAL = /^169\.254\./;

/**
 * Is this the CGNAT range, 100.64.0.0/10?
 *
 * Tailscale allocates from it, and on macOS rides a `utun*` tunnel — so the
 * interface name a person would otherwise read is `utun4`, which says nothing
 * about the network they are on. Naming it makes a three-network machine
 * legible: this machine, the LAN, the tailnet.
 *
 * Matched on the address rather than the interface name because the name is
 * platform-specific (`utun4` on macOS, `tailscale0` on Linux) and unstable
 * across reconnects, while the range is neither. The range is technically
 * shared with carrier-grade NAT, so this is a strong inference rather than a
 * certainty — which is why the range is matched exactly, and 100.63.x and
 * 100.128.x are left labelled by their interface instead of guessed at.
 */
function isCarrierGradeNat(address: string): boolean {
    const [a, b] = address.split('.').map(Number);
    return a === 100 && b !== undefined && b >= 64 && b <= 127;
}

/** LAN before tailnet: the nearest thing that can reach you, first. */
const LAN = 0;
const TAILNET = 1;

export function reachableAddresses(interfaces: InterfaceRecord, port: number): readonly ReachableAddress[] {
    const seen = new Set<string>();
    const external: { readonly rank: number; readonly name: string; readonly entry: ReachableAddress }[] = [];

    for (const name of Object.keys(interfaces)) {
        for (const candidate of interfaces[name] ?? []) {
            if (candidate.family !== 'IPv4') continue;
            if (candidate.internal) continue; // localhost below already covers loopback
            if (LINK_LOCAL.test(candidate.address)) continue;
            if (seen.has(candidate.address)) continue;

            seen.add(candidate.address);
            const tailnet = isCarrierGradeNat(candidate.address);
            external.push({
                rank: tailnet ? TAILNET : LAN,
                name,
                entry: { url: `http://${candidate.address}:${port}`, label: tailnet ? 'tailscale' : name }
            });
        }
    }

    // Ordered explicitly rather than left to `networkInterfaces()`, which
    // promises none: two runs on an unchanged machine must print one list.
    external.sort((x, y) => x.rank - y.rank || x.name.localeCompare(y.name) || x.entry.url.localeCompare(y.entry.url));

    // Always first, always true, and the one a solo player wants.
    return [{ url: `http://localhost:${port}`, label: 'this machine' }, ...external.map(item => item.entry)];
}

/** Two spaces past the longest URL, so a short `en0` still lands under a long label. */
const LABEL_GAP = 2;

/**
 * `url<pad>label` per address, the URLs padded to a common width.
 *
 * A ragged right edge on a list of near-identical strings is genuinely hard to
 * scan, and the whole point of the list is that someone reads down it and picks
 * one. The caller owns the indent.
 */
export function formatAddressLines(addresses: readonly ReachableAddress[]): readonly string[] {
    const widest = Math.max(...addresses.map(a => a.url.length));
    return addresses.map(a => `${a.url.padEnd(widest + LABEL_GAP)}${a.label}`);
}
