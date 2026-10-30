import { lookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent } from 'undici';

// Every address a customer-supplied URL (webhook, OTLP endpoint) must never reach. IPv4-mapped IPv6 (::ffff:a.b.c.d in any
// spelling) is unpacked and checked as IPv4 below; NAT64 (64:ff9b::/96) is refused outright.
// (A ::ffff:0:0/96 rule cannot be used: BlockList would then match every IPv4 address.)
const PRIVATE = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const) {
  PRIVATE.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  PRIVATE.addSubnet(net, bits, 'ipv6');
}

/** Loopback, private, link-local (incl. cloud metadata), CGNAT, multicast, mapped and NAT64. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return PRIVATE.check(ip, 'ipv4');
  if (family === 6) {
    // An IPv4-mapped address is private exactly when its IPv4 part is.
    const mapped = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
    if (mapped) {
      const hi = parseInt(mapped[1]!, 16);
      const lo = parseInt(mapped[2]!, 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    const dotted = /:((?:\d{1,3}\.){3}\d{1,3})$/.exec(ip);
    if (dotted && /^(?:0{0,4}:){0,5}:?ffff:/i.test(ip)) return isPrivateAddress(dotted[1]!);
    return PRIVATE.check(ip, 'ipv6');
  }
  return true; // not an address at all: refuse
}

export interface GuardedClient {
  agent: Agent;
  allowPrivate: boolean;
}

/**
 * An HTTP client that refuses private addresses: hostnames are checked in the DNS lookup, on
 * the address actually connected to (no rebinding window), and IP literals before connecting.
 */
export function guardedAgent(allowPrivate: boolean, what = 'webhook'): GuardedClient {
  return { allowPrivate, agent: lookupGuardedAgent(allowPrivate, what) };
}

function lookupGuardedAgent(allowPrivate: boolean, what: string): Agent {
  return new Agent({
    connect: {
      lookup(hostname, options, cb) {
        lookup(hostname, { ...options, all: true }, (err, addresses) => {
          if (err) return cb(err, '', 0);
          const list = addresses as { address: string; family: number }[];
          const bad = list.find((a) => isPrivateAddress(a.address));
          if (bad && !allowPrivate) {
            return cb(
              new Error(`${what} host resolves to a private address (${bad.address})`),
              '',
              0,
            );
          }
          const first = list[0]!;
          if ((options as { all?: boolean }).all)
            return (cb as (e: null, a: typeof list) => void)(null, list);
          return cb(null, first.address, first.family);
        });
      },
    },
  });
}

/** Refuse an IP-literal URL host that is private (hostnames are checked when connecting). */
export function privateLiteralHost(url: string): string | null {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  return isIP(host) && isPrivateAddress(host) ? host : null;
}
