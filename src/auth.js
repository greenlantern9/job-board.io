// Account and session logic. Route handlers live in routes/auth.js; this file
// holds the rules those handlers enforce.

import {
  hashPassword,
  verifyPassword,
  needsRehash,
  sha256Hex,
  newId,
  newSecretToken,
  encryptString,
  decryptString,
  randomBytes,
  toBase64,
  toBase64Url,
  timingSafeEqual,
  PBKDF2_ITERATIONS,
  UNVERIFIABLE,
} from './crypto.js';
import { queryOne, queryAll, run, nowIso, isoIn, parseJson } from './db.js';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const MFA_CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 minutes to finish the TOTP step
const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

// --- validation ------------------------------------------------------------

export function normalizeEmail(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

export function isValidEmail(value) {
  // Deliberately permissive: the verification email is the real check. This
  // only rejects input that cannot possibly be an address.
  return /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(value) && value.length <= 254;
}

/**
 * Length over composition rules. 12 characters with no character-class
 * requirement produces stronger passwords in practice than 8-with-a-symbol,
 * and the top-of-list check blocks the handful that get typed anyway.
 */
const COMMON_PASSWORDS = new Set([
  'password1234',
  'passwordpassword',
  '123456789012',
  'qwertyuiop12',
  'letmein12345',
  'iloveyou1234',
  'administrator',
  'welcome12345',
]);

export function passwordProblem(password) {
  const value = String(password || '');
  if (value.length < 12) return 'Password must be at least 12 characters.';
  if (value.length > 200) return 'Password must be 200 characters or fewer.';
  if (COMMON_PASSWORDS.has(value.toLowerCase())) return 'That password is too common.';
  if (/^(.)\1+$/.test(value)) return 'That password is too simple.';
  return null;
}

// --- users -----------------------------------------------------------------

export async function findUserByEmail(env, email) {
  return queryOne(env, 'SELECT * FROM users WHERE email = ?', normalizeEmail(email));
}

export async function findUserById(env, id) {
  return queryOne(env, 'SELECT * FROM users WHERE id = ?', id);
}

/** Server-side password pepper. Optional, but strongly recommended - see
 *  applyPepper() in crypto.js for why it carries real weight at 100k
 *  iterations. Absent, hashes are written unpeppered and still verify. */
export function passwordPepper(env) {
  return env.PASSWORD_PEPPER || '';
}

export async function createUser(env, { email, password, timezone = 'UTC' }) {
  const id = newId('usr_');
  const now = nowIso();
  await run(
    env,
    `INSERT INTO users (id, email, password_hash, timezone, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    normalizeEmail(email),
    await hashPassword(password, passwordPepper(env)),
    timezone,
    now,
    now
  );
  return findUserById(env, id);
}

export function isLocked(user) {
  return Boolean(user.locked_until) && new Date(user.locked_until).getTime() > Date.now();
}

/**
 * Verifies a password and maintains the per-account lockout counter. Always
 * runs a PBKDF2 pass - including for a user that does not exist - so response
 * timing does not reveal which emails are registered.
 */
export async function checkPassword(env, user, password) {
  const pepper = passwordPepper(env);

  if (!user) {
    // Burn the same CPU for an unknown address as for a real one. The
    // parameters must be ones verifyPassword will actually execute - an
    // out-of-range iteration count or malformed base64 short-circuits before
    // the KDF runs and hands back the timing oracle this exists to close.
    await verifyPassword(
      password,
      `${pepper ? 'pbkdf2p' : 'pbkdf2'}$sha256$${PBKDF2_ITERATIONS}$${toBase64(randomBytes(16))}$${toBase64(randomBytes(32))}`,
      pepper
    );
    return false;
  }
  const ok = await verifyPassword(password, user.password_hash, pepper);
  if (ok === UNVERIFIABLE) return UNVERIFIABLE;
  if (ok) {
    const patch = { failed_logins: 0, locked_until: '' };
    // Transparently upgrade the stored hash if our parameters have moved on,
    // including adopting the pepper once one is configured.
    if (needsRehash(user.password_hash, pepper)) {
      patch.password_hash = await hashPassword(password, pepper);
    }
    await run(
      env,
      `UPDATE users SET failed_logins = 0, locked_until = '', password_hash = ?, last_login_at = ?, updated_at = ?
       WHERE id = ?`,
      patch.password_hash || user.password_hash,
      nowIso(),
      nowIso(),
      user.id
    );
    return true;
  }
  const failed = (user.failed_logins || 0) + 1;
  const lockUntil = failed >= MAX_FAILED_LOGINS ? isoIn(LOCKOUT_MS) : '';
  await run(
    env,
    'UPDATE users SET failed_logins = ?, locked_until = ?, updated_at = ? WHERE id = ?',
    failed >= MAX_FAILED_LOGINS ? 0 : failed,
    lockUntil,
    nowIso(),
    user.id
  );
  return false;
}

// --- sessions --------------------------------------------------------------

/**
 * Creates a session and returns the raw token. Only the hash is stored, so the
 * database never holds anything replayable.
 *
 * mfaSatisfied=false means the password step passed but the TOTP step has not;
 * such a session gets a short TTL and is rejected by requireUser().
 */
export async function createSession(env, user, { request, mfaSatisfied }) {
  const token = newSecretToken();
  const ttl = mfaSatisfied ? SESSION_TTL_MS : MFA_CHALLENGE_TTL_MS;
  await run(
    env,
    `INSERT INTO sessions (token_hash, user_id, mfa_satisfied, created_at, expires_at, last_seen_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    await sha256Hex(token),
    user.id,
    mfaSatisfied ? 1 : 0,
    nowIso(),
    isoIn(ttl),
    nowIso(),
    (request && request.headers.get('CF-Connecting-IP')) || '',
    ((request && request.headers.get('User-Agent')) || '').slice(0, 200)
  );
  return { token, maxAge: Math.floor(ttl / 1000) };
}

/** Promotes a half-authenticated session once the TOTP code checks out. */
export async function upgradeSession(env, token) {
  await run(
    env,
    'UPDATE sessions SET mfa_satisfied = 1, expires_at = ?, last_seen_at = ? WHERE token_hash = ?',
    isoIn(SESSION_TTL_MS),
    nowIso(),
    await sha256Hex(token)
  );
  return Math.floor(SESSION_TTL_MS / 1000);
}

export async function loadSession(env, token) {
  if (!token) return null;
  const session = await queryOne(
    env,
    'SELECT * FROM sessions WHERE token_hash = ?',
    await sha256Hex(token)
  );
  if (!session) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    await run(env, 'DELETE FROM sessions WHERE token_hash = ?', session.token_hash);
    return null;
  }
  return session;
}

export async function destroySession(env, token) {
  if (!token) return;
  await run(env, 'DELETE FROM sessions WHERE token_hash = ?', await sha256Hex(token));
}

export async function destroyAllSessions(env, userId, exceptToken) {
  const keep = exceptToken ? await sha256Hex(exceptToken) : '';
  await run(env, 'DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', userId, keep);
}

export async function listSessions(env, userId) {
  return queryAll(
    env,
    `SELECT token_hash, created_at, last_seen_at, expires_at, ip, user_agent
     FROM sessions WHERE user_id = ? AND mfa_satisfied = 1 ORDER BY last_seen_at DESC`,
    userId
  );
}

/** Opportunistic cleanup, called from the cron handler. */
export async function purgeExpired(env) {
  await run(env, 'DELETE FROM sessions WHERE expires_at <= ?', nowIso());
  await run(env, 'DELETE FROM email_tokens WHERE expires_at <= ?', nowIso());
}

// --- TOTP secret storage ---------------------------------------------------

export function mfaConfigured(env) {
  return Boolean(env.TOTP_ENC_KEY);
}

function encKey(env) {
  const key = env.TOTP_ENC_KEY;
  if (!key) {
    // Fail closed. Enrolling MFA against a missing key would write secrets we
    // could never decrypt, and silently disabling MFA is worse than an error.
    //
    // Tagged so the route can say which secret is missing. Left untagged this
    // surfaced as the generic "something went wrong", which tells the one
    // person who can fix it precisely nothing.
    const error = new Error('TOTP_ENC_KEY secret is not configured');
    error.code = 'no_totp_key';
    throw error;
  }
  return key;
}

export async function storeTotpSecret(env, userId, secret, { pending }) {
  const blob = await encryptString(encKey(env), secret);
  const column = pending ? 'totp_pending' : 'totp_secret';
  await run(env, `UPDATE users SET ${column} = ?, updated_at = ? WHERE id = ?`, blob, nowIso(), userId);
}

export async function readTotpSecret(env, user, { pending }) {
  const blob = pending ? user.totp_pending : user.totp_secret;
  if (!blob) return null;
  try {
    return await decryptString(encKey(env), blob);
  } catch {
    return null;
  }
}

// --- recovery codes --------------------------------------------------------

/** Ten single-use codes, shown once. Stored as SHA-256: they are high-entropy
 *  already, so a slow KDF buys nothing here. */
export async function generateRecoveryCodes(env, userId) {
  const codes = Array.from({ length: 10 }, () =>
    toBase64Url(randomBytes(6)).slice(0, 8).toLowerCase()
  );
  const hashes = await Promise.all(codes.map((c) => sha256Hex(c)));
  await run(
    env,
    'UPDATE users SET recovery_codes = ?, updated_at = ? WHERE id = ?',
    JSON.stringify(hashes),
    nowIso(),
    userId
  );
  return codes;
}

/** Consumes a recovery code if it matches. Comparison is constant-time and the
 *  loop is not short-circuited. */
export async function consumeRecoveryCode(env, user, code) {
  const stored = parseJson(user.recovery_codes, []);
  if (!Array.isArray(stored) || stored.length === 0) return false;
  const candidate = await sha256Hex(String(code || '').trim().toLowerCase());
  const enc = new TextEncoder();
  let matchIndex = -1;
  stored.forEach((hash, i) => {
    if (timingSafeEqual(enc.encode(hash), enc.encode(candidate))) matchIndex = i;
  });
  if (matchIndex === -1) return false;
  const remaining = stored.filter((_, i) => i !== matchIndex);
  await run(
    env,
    'UPDATE users SET recovery_codes = ?, updated_at = ? WHERE id = ?',
    JSON.stringify(remaining),
    nowIso(),
    user.id
  );
  return true;
}

export async function disableMfa(env, userId) {
  await run(
    env,
    `UPDATE users SET totp_enabled = 0, totp_secret = '', totp_pending = '', recovery_codes = '[]', updated_at = ?
     WHERE id = ?`,
    nowIso(),
    userId
  );
}

// --- request context -------------------------------------------------------

/**
 * The shape handed to the client; never includes secrets or hashes.
 *
 * emailDelivery is a property of the service rather than of the person, and it
 * rides along here because every caller that returns a user is a caller whose
 * client has to decide whether to ask them to confirm an address. Threading it
 * separately meant setting it at four call sites and missing one.
 */
export function publicUser(user, env) {
  return {
    id: user.id,
    email: user.email,
    emailVerified: Boolean(user.email_verified),
    emailDelivery: Boolean(env && env.RESEND_API_KEY),
    mfaEnabled: Boolean(user.totp_enabled),
    isAdmin: Boolean(user.is_admin),
    timezone: user.timezone || 'UTC',
    createdAt: user.created_at,
    recoveryCodesRemaining: parseJson(user.recovery_codes, []).length,
  };
}
