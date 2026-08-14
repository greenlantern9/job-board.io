// Authentication and account management endpoints.

import {
  json,
  badRequest,
  unauthorized,
  tooMany,
  readJson,
  setCookie,
  clearCookie,
  clientIp,
  allowRate,
  SESSION_COOKIE,
} from '../http.js';
import {
  normalizeEmail,
  isValidEmail,
  passwordProblem,
  findUserByEmail,
  findUserById,
  createUser,
  checkPassword,
  isLocked,
  createSession,
  upgradeSession,
  destroySession,
  destroyAllSessions,
  listSessions,
  storeTotpSecret,
  readTotpSecret,
  generateRecoveryCodes,
  consumeRecoveryCode,
  disableMfa,
  publicUser,
  SESSION_TTL_MS,
} from '../auth.js';
import { generateSecret, verifyTotp, otpauthUri, formatSecretForDisplay } from '../totp.js';
import { qrToSvg } from '../qr.js';
import { sha256Hex, newSecretToken, hashPassword } from '../crypto.js';
import { queryOne, run, nowIso, isoIn } from '../db.js';
import { sendTransactional } from '../notify.js';

const cookieFor = (token, maxAge) => setCookie(SESSION_COOKIE, token, { maxAge });

async function issueVerificationEmail(env, user) {
  const token = newSecretToken();
  await run(
    env,
    `INSERT INTO email_tokens (token_hash, user_id, kind, expires_at, created_at)
     VALUES (?, ?, 'verify', ?, ?)`,
    await sha256Hex(token),
    user.id,
    isoIn(24 * 3600 * 1000),
    nowIso()
  );
  const url = `${env.SITE_URL || 'https://job-boards.io'}/verify?token=${encodeURIComponent(token)}`;
  return sendTransactional(env, {
    to: user.email,
    subject: 'Confirm your job-boards.io address',
    heading: 'Confirm your email',
    body: 'Alerts only go to confirmed addresses. This link is good for 24 hours.',
    actionUrl: url,
    actionLabel: 'Confirm address',
  });
}

// --- public endpoints ------------------------------------------------------

async function signup(request, env) {
  if (!(await allowRate(env.AUTH_RATE_LIMIT, `signup:${clientIp(request)}`))) return tooMany();

  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) return badRequest('Enter a valid email address.');

  const problem = passwordProblem(body.password);
  if (problem) return badRequest(problem);

  const existing = await findUserByEmail(env, email);
  if (existing) {
    // Do not confirm which addresses are registered. The person who owns the
    // address learns about the duplicate attempt by email; anyone else learns
    // nothing from the response.
    await sendTransactional(env, {
      to: email,
      subject: 'Someone tried to sign up with your address',
      heading: 'You already have an account',
      body: 'A signup was attempted with this address. If that was you, sign in instead.',
      actionUrl: `${env.SITE_URL || 'https://job-boards.io'}/app`,
      actionLabel: 'Sign in',
    });
    return json({ ok: true, pendingVerification: true });
  }

  const timezone = typeof body.timezone === 'string' ? body.timezone.slice(0, 64) : 'UTC';
  const user = await createUser(env, { email, password: body.password, timezone });
  await issueVerificationEmail(env, user);

  const { token, maxAge } = await createSession(env, user, { request, mfaSatisfied: true });
  return json(
    { ok: true, user: publicUser(user), pendingVerification: true },
    { headers: { 'Set-Cookie': cookieFor(token, maxAge) } }
  );
}

async function login(request, env) {
  if (!(await allowRate(env.AUTH_RATE_LIMIT, `login:${clientIp(request)}`))) return tooMany();

  const body = await readJson(request);
  const user = await findUserByEmail(env, body.email);

  if (user && isLocked(user)) {
    return json(
      { error: 'Too many failed attempts. Try again in about 15 minutes.' },
      { status: 429 }
    );
  }

  const ok = await checkPassword(env, user, String(body.password || ''));
  if (!ok || !user) return unauthorized('That email and password do not match.');

  if (user.totp_enabled) {
    // Half-authenticated: short-lived, and requireUser() rejects it until the
    // second factor lands.
    const { token, maxAge } = await createSession(env, user, { request, mfaSatisfied: false });
    return json(
      { ok: true, mfaRequired: true },
      { headers: { 'Set-Cookie': cookieFor(token, maxAge) } }
    );
  }

  const { token, maxAge } = await createSession(env, user, { request, mfaSatisfied: true });
  return json(
    { ok: true, user: publicUser(user) },
    { headers: { 'Set-Cookie': cookieFor(token, maxAge) } }
  );
}

async function mfaChallenge(request, env, ctx) {
  if (!ctx.session || !ctx.user) return unauthorized('Start again from the sign-in screen.');
  if (ctx.session.mfa_satisfied) return json({ ok: true, user: publicUser(ctx.user) });
  if (!(await allowRate(env.AUTH_RATE_LIMIT, `mfa:${ctx.user.id}`))) return tooMany();

  const body = await readJson(request);
  const code = String(body.code || '').trim();

  let passed = false;
  if (body.useRecoveryCode) {
    passed = await consumeRecoveryCode(env, ctx.user, code);
  } else {
    const secret = await readTotpSecret(env, ctx.user, { pending: false });
    passed = secret ? await verifyTotp(secret, code) : false;
  }

  if (!passed) return unauthorized('That code is not valid.');

  const maxAge = await upgradeSession(env, ctx.token);
  const fresh = await findUserById(env, ctx.user.id);
  return json(
    { ok: true, user: publicUser(fresh) },
    { headers: { 'Set-Cookie': cookieFor(ctx.token, maxAge) } }
  );
}

async function logout(request, env, ctx) {
  await destroySession(env, ctx.token);
  return json({ ok: true }, { headers: { 'Set-Cookie': clearCookie(SESSION_COOKIE) } });
}

async function session(request, env, ctx) {
  if (!ctx.user || !ctx.session) return unauthorized();
  if (!ctx.session.mfa_satisfied) return json({ mfaRequired: true }, { status: 401 });
  return json({ user: publicUser(ctx.user) });
}

async function verifyEmailToken(env, token) {
  const row = await queryOne(
    env,
    `SELECT * FROM email_tokens WHERE token_hash = ? AND kind = 'verify' AND used_at = ''`,
    await sha256Hex(token)
  );
  if (!row || new Date(row.expires_at).getTime() <= Date.now()) return false;
  await run(env, 'UPDATE email_tokens SET used_at = ? WHERE token_hash = ?', nowIso(), row.token_hash);
  await run(
    env,
    'UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?',
    nowIso(),
    row.user_id
  );
  return true;
}

async function resendVerification(request, env, ctx) {
  if (!ctx.user) return unauthorized();
  if (ctx.user.email_verified) return json({ ok: true, alreadyVerified: true });
  if (!(await allowRate(env.AUTH_RATE_LIMIT, `verify:${ctx.user.id}`))) return tooMany();
  const result = await issueVerificationEmail(env, ctx.user);
  return json({ ok: true, delivery: result.status });
}

async function forgotPassword(request, env) {
  if (!(await allowRate(env.AUTH_RATE_LIMIT, `forgot:${clientIp(request)}`))) return tooMany();
  const body = await readJson(request);
  const user = await findUserByEmail(env, body.email);

  if (user) {
    const token = newSecretToken();
    await run(
      env,
      `INSERT INTO email_tokens (token_hash, user_id, kind, expires_at, created_at)
       VALUES (?, ?, 'reset', ?, ?)`,
      await sha256Hex(token),
      user.id,
      isoIn(60 * 60 * 1000),
      nowIso()
    );
    await sendTransactional(env, {
      to: user.email,
      subject: 'Reset your job-boards.io password',
      heading: 'Reset your password',
      body: 'This link works once and expires in an hour.',
      actionUrl: `${env.SITE_URL || 'https://job-boards.io'}/reset?token=${encodeURIComponent(token)}`,
      actionLabel: 'Choose a new password',
    });
  }
  // Same response either way - an enumeration oracle here undoes the care taken
  // on the signup path.
  return json({ ok: true });
}

async function resetPassword(request, env) {
  if (!(await allowRate(env.AUTH_RATE_LIMIT, `reset:${clientIp(request)}`))) return tooMany();
  const body = await readJson(request);
  const problem = passwordProblem(body.password);
  if (problem) return badRequest(problem);

  const row = await queryOne(
    env,
    `SELECT * FROM email_tokens WHERE token_hash = ? AND kind = 'reset' AND used_at = ''`,
    await sha256Hex(String(body.token || ''))
  );
  if (!row || new Date(row.expires_at).getTime() <= Date.now()) {
    return badRequest('That reset link has expired. Request a new one.');
  }

  await run(env, 'UPDATE email_tokens SET used_at = ? WHERE token_hash = ?', nowIso(), row.token_hash);
  await run(
    env,
    `UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = '', updated_at = ? WHERE id = ?`,
    await hashPassword(body.password),
    nowIso(),
    row.user_id
  );
  // A password reset invalidates every existing session: if the reset was
  // triggered by a compromise, the attacker's session must not survive it.
  await destroyAllSessions(env, row.user_id, null);
  return json({ ok: true });
}

// --- account endpoints (require a fully authenticated session) --------------

async function changePassword(request, env, ctx) {
  const body = await readJson(request);
  if (!(await checkPassword(env, ctx.user, String(body.currentPassword || '')))) {
    return badRequest('Your current password is not correct.');
  }
  const problem = passwordProblem(body.newPassword);
  if (problem) return badRequest(problem);

  await run(
    env,
    'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?',
    await hashPassword(body.newPassword),
    nowIso(),
    ctx.user.id
  );
  await destroyAllSessions(env, ctx.user.id, ctx.token);
  return json({ ok: true, otherSessionsSignedOut: true });
}

async function startMfa(request, env, ctx) {
  const secret = generateSecret();
  await storeTotpSecret(env, ctx.user.id, secret, { pending: true });
  const uri = otpauthUri({ issuer: 'job-boards.io', account: ctx.user.email, secret });
  return json({
    ok: true,
    secret: formatSecretForDisplay(secret),
    uri,
    qrSvg: qrToSvg(uri, { moduleSize: 5, margin: 3 }),
  });
}

async function confirmMfa(request, env, ctx) {
  const pending = await readTotpSecret(env, ctx.user, { pending: true });
  if (!pending) return badRequest('Start the setup again - no pending secret was found.');

  const body = await readJson(request);
  if (!(await verifyTotp(pending, String(body.code || '').trim()))) {
    return badRequest('That code is not valid. Check your device clock and try the next one.');
  }

  await storeTotpSecret(env, ctx.user.id, pending, { pending: false });
  await run(
    env,
    `UPDATE users SET totp_enabled = 1, totp_pending = '', updated_at = ? WHERE id = ?`,
    nowIso(),
    ctx.user.id
  );
  const codes = await generateRecoveryCodes(env, ctx.user.id);
  // Shown exactly once - they are not recoverable from the stored hashes.
  return json({ ok: true, recoveryCodes: codes });
}

async function disableMfaRoute(request, env, ctx) {
  const body = await readJson(request);
  if (!(await checkPassword(env, ctx.user, String(body.password || '')))) {
    return badRequest('Enter your password to turn off two-factor authentication.');
  }
  await disableMfa(env, ctx.user.id);
  return json({ ok: true });
}

async function regenerateRecoveryCodes(request, env, ctx) {
  const body = await readJson(request);
  if (!(await checkPassword(env, ctx.user, String(body.password || '')))) {
    return badRequest('Enter your password to generate new recovery codes.');
  }
  const codes = await generateRecoveryCodes(env, ctx.user.id);
  return json({ ok: true, recoveryCodes: codes });
}

async function sessionsList(request, env, ctx) {
  const rows = await listSessions(env, ctx.user.id);
  const current = await sha256Hex(ctx.token);
  return json({
    sessions: rows.map((row) => ({
      id: row.token_hash.slice(0, 16),
      current: row.token_hash === current,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
      ip: row.ip,
      userAgent: row.user_agent,
    })),
  });
}

async function revokeSessions(request, env, ctx) {
  await destroyAllSessions(env, ctx.user.id, ctx.token);
  return json({ ok: true });
}

async function updateAccount(request, env, ctx) {
  const body = await readJson(request);
  const timezone = String(body.timezone || 'UTC').slice(0, 64);
  try {
    // Reject a timezone the runtime cannot resolve, rather than storing a value
    // that would silently break digest scheduling.
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    return badRequest('That timezone is not recognised.');
  }
  await run(env, 'UPDATE users SET timezone = ?, updated_at = ? WHERE id = ?', timezone, nowIso(), ctx.user.id);
  return json({ ok: true, user: publicUser({ ...ctx.user, timezone }) });
}

async function deleteAccount(request, env, ctx) {
  const body = await readJson(request);
  if (!(await checkPassword(env, ctx.user, String(body.password || '')))) {
    return badRequest('Enter your password to delete your account.');
  }
  if (String(body.confirm || '').trim().toLowerCase() !== 'delete my account') {
    return badRequest('Type "delete my account" to confirm.');
  }
  // D1 does not enforce ON DELETE CASCADE unless foreign keys are on, so delete
  // children explicitly rather than trusting the constraint.
  const id = ctx.user.id;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM jobs WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM sources WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM boards WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM notification_rules WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM notifications WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM email_tokens WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
  ]);
  return json({ ok: true }, { headers: { 'Set-Cookie': clearCookie(SESSION_COOKIE) } });
}

// --- table -----------------------------------------------------------------

/** `auth: false` means the handler runs without a session; `partial: true`
 *  means a half-authenticated (pre-MFA) session is acceptable. */
export const AUTH_ROUTES = {
  'POST /api/auth/signup': { handler: signup, auth: false },
  'POST /api/auth/login': { handler: login, auth: false },
  'POST /api/auth/mfa': { handler: mfaChallenge, auth: false, partial: true },
  'POST /api/auth/logout': { handler: logout, auth: false, partial: true },
  'GET /api/auth/session': { handler: session, auth: false, partial: true },
  'POST /api/auth/verify/resend': { handler: resendVerification, partial: true },
  'POST /api/auth/password/forgot': { handler: forgotPassword, auth: false },
  'POST /api/auth/password/reset': { handler: resetPassword, auth: false },

  'POST /api/account/password': { handler: changePassword },
  'POST /api/account/mfa/start': { handler: startMfa },
  'POST /api/account/mfa/confirm': { handler: confirmMfa },
  'POST /api/account/mfa/disable': { handler: disableMfaRoute },
  'POST /api/account/recovery': { handler: regenerateRecoveryCodes },
  'GET /api/account/sessions': { handler: sessionsList },
  'POST /api/account/sessions/revoke': { handler: revokeSessions },
  'POST /api/account/update': { handler: updateAccount },
  'POST /api/account/delete': { handler: deleteAccount },
};

export { verifyEmailToken, SESSION_TTL_MS };
