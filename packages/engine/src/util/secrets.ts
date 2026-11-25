import { sha256Hex } from './sha256';

/**
 * Cisco "type 7" reversible encoding used by `service password-encryption`.
 * The algorithm and key are public; it is obfuscation, not security (as on real IOS).
 */
const XLAT = 'dsfd;kfoA,.iyewrkldJKDHSUBsgvca69834ncxv9873254k;fg87';

export function type7Encode(plain: string, seed = 2): string {
  let out = seed.toString().padStart(2, '0');
  for (let i = 0; i < plain.length; i++) {
    const enc = plain.charCodeAt(i) ^ XLAT.charCodeAt((seed + i) % XLAT.length);
    out += enc.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

export function type7Decode(enc: string): string | null {
  if (!/^\d{2}([0-9A-Fa-f]{2})*$/.test(enc)) return null;
  const seed = Number(enc.slice(0, 2));
  let out = '';
  for (let i = 2, k = 0; i < enc.length; i += 2, k++) {
    out += String.fromCharCode(parseInt(enc.slice(i, i + 2), 16) ^ XLAT.charCodeAt((seed + k) % XLAT.length));
  }
  return out;
}

const B64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * One-way secret in the `$1$salt$hash` shape shown by IOS for `enable secret` (type 5).
 * The digest is salted SHA-256 re-encoded in the crypt alphabet, not genuine MD5-crypt,
 * so hashes are not interchangeable with real IOS (documented in COMPATIBILITY.md).
 */
export function type5Hash(plain: string, salt: string): string {
  const hex = sha256Hex(`${salt}$${plain}`);
  let out = '';
  for (let i = 0; i < 22; i++) out += B64[parseInt(hex.slice(i * 2, i * 2 + 2), 16) % 64];
  return `$1$${salt}$${out}`;
}

export function type5Verify(plain: string, hash: string): boolean {
  const m = /^\$1\$([^$]+)\$/.exec(hash);
  return !!m && type5Hash(plain, m[1]!) === hash;
}

export function saltFrom(seed: string): string {
  const hex = sha256Hex(seed);
  let s = '';
  for (let i = 0; i < 4; i++) s += B64[parseInt(hex.slice(i * 2, i * 2 + 2), 16) % 64];
  return s;
}
