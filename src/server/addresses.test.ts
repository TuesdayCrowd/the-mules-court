import { describe, expect, it } from 'bun:test';
import type { InterfaceRecord } from './addresses';
import { formatAddressLines, reachableAddresses } from './addresses';

/**
 * A real `os.networkInterfaces()` reading from the machine this was written on,
 * trimmed of nothing. It is the fixture rather than a tidy invention because the
 * noise is the point: `awdl0`, `llw0` and four `utun*` tunnels each contribute a
 * link-local IPv6 that is useless to a person choosing an address to type, and an
 * unfiltered banner prints eight of them ahead of the one that works.
 */
const REAL: InterfaceRecord = {
    lo0: [
        { address: '127.0.0.1', family: 'IPv4', internal: true },
        { address: '::1', family: 'IPv6', internal: true },
        { address: 'fe80::1', family: 'IPv6', internal: true }
    ],
    en0: [
        { address: 'fe80::80b:d82a:edc2:7ca8', family: 'IPv6', internal: false },
        { address: 'fd8a:33cf:fdde:dc20:14cf:9af7:bb04:c3f8', family: 'IPv6', internal: false },
        { address: '192.168.68.69', family: 'IPv4', internal: false }
    ],
    awdl0: [{ address: 'fe80::d850:2aff:fea2:4e72', family: 'IPv6', internal: false }],
    utun0: [{ address: 'fe80::171d:3faa:e401:2920', family: 'IPv6', internal: false }]
};

describe('reachableAddresses', () => {
    it('leads with localhost, which is always reachable', () => {
        expect(reachableAddresses({}, 3000)[0]).toEqual({ url: 'http://localhost:3000', label: 'this machine' });
    });

    it('offers only localhost when the machine is on no network', () => {
        expect(reachableAddresses({}, 3000)).toHaveLength(1);
    });

    it('offers each external IPv4 address, labelled with its interface', () => {
        expect(reachableAddresses(REAL, 3000)[1]).toEqual({ url: 'http://192.168.68.69:3000', label: 'en0' });
    });

    it('carries the port into every URL', () => {
        expect(reachableAddresses(REAL, 5199).map(a => a.url)).toEqual([
            'http://localhost:5199',
            'http://192.168.68.69:5199'
        ]);
    });

    it('drops IPv6, which no one is going to type into a phone', () => {
        const urls = reachableAddresses(REAL, 3000).map(a => a.url);
        expect(urls.some(url => url.includes(':::') || url.includes('fe80'))).toBe(false);
    });

    it('drops loopback interfaces, since localhost already covers them', () => {
        expect(reachableAddresses(REAL, 3000).some(a => a.url.includes('127.0.0.1'))).toBe(false);
    });

    it('drops link-local addresses, which mean the interface never got a lease', () => {
        const stranded: InterfaceRecord = {
            en1: [{ address: '169.254.13.4', family: 'IPv4', internal: false }]
        };
        expect(reachableAddresses(stranded, 3000)).toHaveLength(1);
    });

    it('lists every interface when a machine is on two networks at once', () => {
        const dual: InterfaceRecord = {
            en1: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
            en0: [{ address: '192.168.68.69', family: 'IPv4', internal: false }]
        };
        // Sorted by interface name, so the banner does not reshuffle between runs.
        expect(reachableAddresses(dual, 3000).map(a => a.label)).toEqual(['this machine', 'en0', 'en1']);
    });

    it('shows an address once when an interface reports it twice', () => {
        const twice: InterfaceRecord = {
            en0: [
                { address: '192.168.68.69', family: 'IPv4', internal: false },
                { address: '192.168.68.69', family: 'IPv4', internal: false }
            ]
        };
        expect(reachableAddresses(twice, 3000)).toHaveLength(2);
    });

    it('survives an interface node reports as absent', () => {
        expect(reachableAddresses({ en0: undefined }, 3000)).toHaveLength(1);
    });

    /**
     * Tailscale hands out addresses from the CGNAT range 100.64.0.0/10 on a
     * `utun*` tunnel, so the interface name a person would otherwise read is
     * `utun4` — which tells them nothing about the network they are on. This
     * machine's own Tailscale address is 100.105.185.38 on utun4.
     */
    it('names the tailscale network rather than the tunnel it rides on', () => {
        const tailscale: InterfaceRecord = {
            utun4: [{ address: '100.105.185.38', family: 'IPv4', internal: false }]
        };
        expect(reachableAddresses(tailscale, 3000)[1]).toEqual({
            url: 'http://100.105.185.38:3000',
            label: 'tailscale'
        });
    });

    it('claims the whole CGNAT range, both ends', () => {
        const edges: InterfaceRecord = {
            utun4: [
                { address: '100.64.0.1', family: 'IPv4', internal: false },
                { address: '100.127.255.254', family: 'IPv4', internal: false }
            ]
        };
        expect(reachableAddresses(edges, 3000).map(a => a.label)).toEqual(['this machine', 'tailscale', 'tailscale']);
    });

    it('leaves 100.x addresses outside the CGNAT range alone', () => {
        // 100.128.x is ordinary public space and 100.63.x sits below the range;
        // neither is Tailscale, and mislabelling them would be a confident lie.
        const nearby: InterfaceRecord = {
            en5: [
                { address: '100.63.255.255', family: 'IPv4', internal: false },
                { address: '100.128.0.1', family: 'IPv4', internal: false }
            ]
        };
        expect(reachableAddresses(nearby, 3000).map(a => a.label)).toEqual(['this machine', 'en5', 'en5']);
    });

    it('orders the local network ahead of tailscale, nearest reachable first', () => {
        const both: InterfaceRecord = {
            utun4: [{ address: '100.105.185.38', family: 'IPv4', internal: false }],
            en0: [{ address: '192.168.68.69', family: 'IPv4', internal: false }]
        };
        expect(reachableAddresses(both, 3000).map(a => a.label)).toEqual(['this machine', 'en0', 'tailscale']);
    });
});

describe('formatAddressLines', () => {
    it('pads every URL to a common width so the labels form a column', () => {
        expect(
            formatAddressLines([
                { url: 'http://localhost:3000', label: 'this machine' },
                { url: 'http://192.168.68.69:3000', label: 'en0' }
            ])
        ).toEqual(['http://localhost:3000      this machine', 'http://192.168.68.69:3000  en0']);
    });

    it('leaves no trailing space when a single address needs no padding', () => {
        expect(formatAddressLines([{ url: 'http://localhost:3000', label: 'this machine' }])).toEqual([
            'http://localhost:3000  this machine'
        ]);
    });
});
