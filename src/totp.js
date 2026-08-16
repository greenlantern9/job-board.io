// RFC 6238 TOTP (SHA-1, 6 digits, 30s step) - the parameters every
// authenticator app assumes when they are omitted from the otpauth URI.

import { randomBytes, timingSafeEqual } from './crypto.js';

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  while (out.length % 8 !== 0) out += '=';
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** 20 bytes = 160 bits, the RFC 4226 recommended secret size. */
export function generateSecret() {
  return base32Encode(randomBytes(20));
}

async function hmacSha1(keyBytes, msgBytes) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, msgBytes));
}

function counterBytes(counter) {
  const buf = new Uint8Array(8);
  // Counter is a 64-bit big-endian int. Number can hold the value safely for
  // any realistic date, but bit ops are 32-bit - split into two halves.
  const high = Math.floor(counter / 0x100000000);
  const low = counter >>> 0;
  buf[0] = (high >>> 24) & 0xff;
  buf[1] = (high >>> 16) & 0xff;
  buf[2] = (high >>> 8) & 0xff;
  buf[3] = high & 0xff;
  buf[4] = (low >>> 24) & 0xff;
  buf[5] = (low >>> 16) & 0xff;
  buf[6] = (low >>> 8) & 0xff;
  buf[7] = low & 0xff;
  return buf;
}

export async function hotp(secretBase32, counter, digits = 6) {
  const mac = await hmacSha1(base32Decode(secretBase32), counterBytes(counter));
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export async function totp(secretBase32, atMs = Date.now(), step = 30) {
  return hotp(secretBase32, Math.floor(atMs / 1000 / step));
}

/**
 * Accepts a code from the previous, current, or next window by default, which
 * covers ordinary clock drift. Every candidate is compared in constant time and
 * the loop is not short-circuited, so a caller cannot learn *which* window
 * matched from timing.
 */
export async function verifyTotp(secretBase32, code, { atMs = Date.now(), window = 1, step = 30 } = {}) {
  const given = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(given)) return false;
  const counter = Math.floor(atMs / 1000 / step);
  const givenBytes = new TextEncoder().encode(given);
  let ok = false;
  for (let i = -window; i <= window; i++) {
    const candidate = await hotp(secretBase32, counter + i);
    if (timingSafeEqual(new TextEncoder().encode(candidate), givenBytes)) ok = true;
  }
  return ok;
}

/**
 * @param compactLabel  Drop the "issuer:" prefix from the label. The issuer
 *                      parameter still carries it, so apps group the entry
 *                      correctly either way - this only shortens the URI.
 * @param omitDefaults  Drop algorithm, digits and period. All three are the
 *                      RFC 6238 defaults that every authenticator assumes when
 *                      absent; stating them is belt and braces, not a
 *                      requirement.
 */
export function otpauthUri({ issuer, account, secret, compactLabel = false, omitDefaults = false }) {
  const label = encodeURIComponent(compactLabel ? account : `${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer });
  if (!omitDefaults) {
    params.set('algorithm', 'SHA1');
    params.set('digits', '6');
    params.set('period', '30');
  }
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Human-friendly grouping for the "can't scan the code?" fallback. */
export function formatSecretForDisplay(secret) {
  return (secret.replace(/=+$/, '').match(/.{1,4}/g) || []).join(' ');
}
