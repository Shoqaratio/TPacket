/** IPv6 helpers. Addresses are bigint (128 bits). */

const MAX = (1n << 128n) - 1n;

export function parseIp6(s: string): bigint | null {
  const t = s.trim().toLowerCase();
  if (!/^[0-9a-f:]+$/.test(t) || t.includes(':::')) return null;
  const parts = t.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const groups = parts.length === 2 ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail] : head;
  if (groups.length !== 8 || (parts.length === 2 && head.length + tail.length > 7)) return null;
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

/** RFC 5952 canonical text form, upper-case like IOS. */
export function ip6ToString(n: bigint): string {
  const g: number[] = [];
  for (let i = 7; i >= 0; i--) g.push(Number((n >> BigInt(i * 16)) & 0xffffn));
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen && j - i > 1) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = g.map((x) => x.toString(16).toUpperCase());
  if (bestStart < 0) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
}

export function prefixMask6(len: number): bigint {
  return len === 0 ? 0n : (MAX << BigInt(128 - len)) & MAX;
}

export function network6(ip: bigint, len: number): bigint {
  return ip & prefixMask6(len);
}

/** "2001:db8::1/64" */
export function parseCidr6(s: string): { ip: bigint; len: number } | null {
  const m = /^(\S+)\/(\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  const ip = parseIp6(m[1]!);
  const len = Number(m[2]);
  if (ip === null || len > 128) return null;
  return { ip, len };
}

/** Modified EUI-64 link-local address from a MAC (FE80::/64). */
export function linkLocal(mac: string): bigint {
  const b = mac.match(/../g)!.map((x) => parseInt(x, 16));
  b[0] = b[0]! ^ 0x02;
  const iid = [b[0], b[1], b[2], 0xff, 0xfe, b[3], b[4], b[5]].reduce((n, x) => (n << 8n) | BigInt(x!), 0n);
  return (0xfe80n << 112n) | iid;
}

export function isLinkLocal(ip: bigint): boolean {
  return ip >> 118n === 0x3fan; // fe80::/10
}
