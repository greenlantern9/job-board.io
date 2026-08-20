// Primitives built on WebCrypto, which is all the Workers runtime gives us -
// no bcrypt/argon2 native modules.

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * The Workers runtime refuses more than 100,000 PBKDF2 iterations, throwing
 * NotSupportedError("Pbkdf2 failed: iteration counts above 100000 are not
 * supported"). It is a hard platform ceiling, not a tunable - `wrangler dev`
 * does not enforce it, so exceeding it passes every local test and then fails
 * on the first real signup in production.
 *
 * 100k is below the OWASP recommendation of 600k for PBKDF2-SHA256, so the
 * pepper below is doing real work rather than being belt-and-braces: it is what
 * keeps a database-only leak uncrackable at this iteration count.
 */
/**
 * Returned by verifyPassword when a stored hash cannot be checked on this
 * runtime at all - not when the password is wrong. Callers must treat it as its
 * own case; `=== true` is the only thing that means authenticated.
 */
export const UNVERIFIABLE = 'unverifiable';

export const PBKDF2_ITERATIONS = 100000;
export const PBKDF2_MAX_SUPPORTED = 100000;

export function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function toBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return fromBase64(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

export function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/**
 * Constant-time comparison. Returns false immediately on a length mismatch -
 * lengths here are always public (hash sizes, token sizes), so leaking that
 * costs nothing.
 */
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function sha256(input) {
  const data = typeof input === 'string' ? enc.encode(input) : input;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

export async function sha256Hex(input) {
  return toHex(await sha256(input));
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}

/**
 * HMAC the password with a server-side secret before it reaches PBKDF2.
 *
 * The pepper lives in a Worker secret, never in the database. That is the whole
 * point: at 100k iterations a stolen `users` table would otherwise be within
 * reach of a serious offline attack, but without the pepper the stored hashes
 * are not attackable at all - there is nothing to guess against.
 */
async function applyPepper(password, pepper) {
  if (!pepper) return password;
  return toBase64(await hmac(pepper, password));
}

/**
 * Returns a self-describing string, so parameters can change later without
 * invalidating existing passwords. The scheme prefix records whether a pepper
 * was applied: `pbkdf2p` means peppered, `pbkdf2` means not.
 */
export async function hashPassword(password, pepper = '') {
  const salt = randomBytes(16);
  const hash = await pbkdf2(await applyPepper(password, pepper), salt, PBKDF2_ITERATIONS);
  const scheme = pepper ? 'pbkdf2p' : 'pbkdf2';
  return `${scheme}$sha256$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(password, stored, pepper = '') {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 5) return false;

  const scheme = parts[0];
  if ((scheme !== 'pbkdf2' && scheme !== 'pbkdf2p') || parts[1] !== 'sha256') return false;
  // A peppered hash cannot be checked without the pepper. Refuse rather than
  // silently falling back and rejecting every correct password as wrong.
  if (scheme === 'pbkdf2p' && !pepper) return false;

  const iterations = Number(parts[2]);
  // A count the runtime cannot execute is a different thing from a wrong
  // password, and collapsing the two locked a real account out with the message
  // "that email and password do not match" - which was false, and sent the
  // owner looking for a typo that was never there. Hashes written before the
  // iteration count was brought under the platform cap can never be verified
  // here again, so say so and point at the way back.
  if (!Number.isInteger(iterations) || iterations < 1000) return false;

  let salt, expected;
  try {
    salt = fromBase64(parts[3]);
    expected = fromBase64(parts[4]);
  } catch {
    return false;
  }

  // Checked only once the hash is known to be well formed. A corrupt value that
  // happens to carry a large iteration count is invalid, not unverifiable, and
  // telling its owner to reset a password would send them to fix the wrong
  // thing. Only a hash that is genuinely intact but too expensive for this
  // runtime earns the softer answer.
  if (iterations > PBKDF2_MAX_SUPPORTED) return UNVERIFIABLE;

  const input = scheme === 'pbkdf2p' ? await applyPepper(password, pepper) : password;
  const actual = await pbkdf2(input, salt, iterations);
  return timingSafeEqual(actual, expected);
}

/**
 * True when a stored hash was made with weaker parameters than we now use,
 * predates the pepper, or cannot be executed by this runtime at all. Callers
 * rehash transparently on the next successful sign-in.
 *
 * Note the ceiling case is unreachable in practice: a hash above the cap can
 * never verify, so its owner can never sign in to trigger the rehash and has to
 * go through password reset. It is flagged anyway so the state is at least
 * visible rather than silently looking healthy.
 */
export function needsRehash(stored, pepper = '') {
  const parts = String(stored || '').split('$');
  if (parts.length !== 5) return true;
  if (pepper && parts[0] !== 'pbkdf2p') return true;

  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations)) return true;
  if (iterations < PBKDF2_ITERATIONS) return true; // weaker than current policy
  if (iterations > PBKDF2_MAX_SUPPORTED) return true; // unusable on this runtime
  return false;
}

async function aesKeyFrom(secret) {
  // The secret is an arbitrary-length string from `wrangler secret put`; hash
  // it to exactly 32 bytes so any secret produces a valid AES-256 key.
  const raw = await sha256(secret);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** AES-256-GCM. Used for TOTP secrets at rest: a database leak alone must not
 *  hand an attacker the second factor. */
export async function encryptString(secret, plaintext) {
  const key = await aesKeyFrom(secret);
  const iv = randomBytes(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext))
  );
  return `v1.${toBase64(iv)}.${toBase64(ct)}`;
}

export async function decryptString(secret, blob) {
  const parts = String(blob || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('bad ciphertext');
  const key = await aesKeyFrom(secret);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(parts[1]) },
    key,
    fromBase64(parts[2])
  );
  return dec.decode(pt);
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function hmac(secret, data) {
  const key = await hmacKey(secret);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

/** `payload.signature` - used for unsubscribe links and email tokens, which
 *  must be verifiable without a database round trip. */
export async function signToken(secret, payload) {
  const body = toBase64Url(enc.encode(JSON.stringify(payload)));
  const sig = toBase64Url(await hmac(secret, body));
  return `${body}.${sig}`;
}

export async function verifyToken(secret, token) {
  const idx = String(token || '').lastIndexOf('.');
  if (idx < 1) return null;
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  let given;
  try {
    given = fromBase64Url(sig);
  } catch {
    return null;
  }
  const expected = await hmac(secret, body);
  if (!timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(dec.decode(fromBase64Url(body)));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/** URL-safe opaque id. 16 bytes = 128 bits, plenty for row ids. */
export function newId(prefix = '') {
  return prefix + toBase64Url(randomBytes(16));
}

/** 32 bytes for anything that acts as a bearer credential (session cookies,
 *  password-reset tokens). */
export function newSecretToken() {
  return toBase64Url(randomBytes(32));
}
