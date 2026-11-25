/** IPv4 helpers. Addresses are handled as unsigned 32-bit numbers internally. */

export function parseIp(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const o = Number(m[i]);
    if (o > 255) return null;
    n = n * 256 + o;
  }
  return n >>> 0;
}

export function ipToString(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** Returns the prefix length of a contiguous mask, or null if the mask is not contiguous. */
export function maskToPrefix(mask: number): number | null {
  let len = 0;
  let seenZero = false;
  for (let i = 31; i >= 0; i--) {
    if ((mask >>> i) & 1) {
      if (seenZero) return null;
      len++;
    } else seenZero = true;
  }
  return len;
}

export function prefixToMask(len: number): number {
  return len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
}

export function networkOf(ip: number, mask: number): number {
  return (ip & mask) >>> 0;
}

export function broadcastOf(ip: number, mask: number): number {
  return (networkOf(ip, mask) | (~mask >>> 0)) >>> 0;
}

export function sameSubnet(a: number, b: number, mask: number): boolean {
  return networkOf(a, mask) === networkOf(b, mask);
}

/** Classful mask (used by the RIP `network` statement). */
export function classfulMask(ip: number): number {
  const first = ip >>> 24;
  if (first < 128) return prefixToMask(8);
  if (first < 192) return prefixToMask(16);
  return prefixToMask(24);
}

/** Wildcard (inverse) mask match used by ACLs. */
export function wildcardMatch(ip: number, base: number, wildcard: number): boolean {
  const care = ~wildcard >>> 0;
  return ((ip & care) >>> 0) === ((base & care) >>> 0);
}

export const BROADCAST_IP = 0xffffffff;

export function cidr(ip: number, mask: number): string {
  return `${ipToString(networkOf(ip, mask))}/${maskToPrefix(mask) ?? '?'}`;
}

/** Parses "a.b.c.d/len". */
export function parseCidr(s: string): { ip: number; mask: number } | null {
  const m = /^(\S+)\/(\d{1,2})$/.exec(s.trim());
  if (!m) return null;
  const ip = parseIp(m[1]!);
  const len = Number(m[2]);
  if (ip === null || len > 32) return null;
  return { ip, mask: prefixToMask(len) };
}

/** A host address is usable on a subnet if it is neither the network nor the broadcast address (/31, /32 excepted). */
export function isUsableHost(ip: number, mask: number): boolean {
  const len = maskToPrefix(mask);
  if (len === null) return false;
  if (len >= 31) return true;
  return ip !== networkOf(ip, mask) && ip !== broadcastOf(ip, mask);
}
