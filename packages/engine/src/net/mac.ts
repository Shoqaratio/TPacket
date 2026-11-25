/** MAC addresses are stored as 12 lowercase hex digits. */

export const BROADCAST_MAC = 'ffffffffffff';

/** Generated MACs use the 00:0A:F3 prefix followed by a per-project counter (deterministic). */
export function macFromNumber(n: number): string {
  return '000af3' + (n & 0xffffff).toString(16).padStart(6, '0');
}

export function macAdd(mac: string, offset: number): string {
  const n = parseInt(mac.slice(6), 16) + offset;
  return mac.slice(0, 6) + (n & 0xffffff).toString(16).padStart(6, '0');
}

export function macCisco(mac: string): string {
  return `${mac.slice(0, 4)}.${mac.slice(4, 8)}.${mac.slice(8, 12)}`;
}

export function macWindows(mac: string): string {
  return mac.match(/../g)!.join('-').toUpperCase();
}

export function macColon(mac: string): string {
  return mac.match(/../g)!.join(':').toUpperCase();
}
