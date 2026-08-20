// The admin page gate.
//
// Two independent locks, and the inner one is never optional.
//
// The app's own session is checked first: signed in, and the address on the
// account matches ADMIN_EMAIL. That holds from the moment this deploys, with
// nothing to configure - so there is no window where the page exists and is
// unprotected, which is the usual way an "admin page behind SSO" leaks before
// the SSO is switched on.
//
// Cloudflare Access sits outside that as a second lock. When the team domain
// and audience are configured, a valid Access assertion is *required* as well,
// and the JWT is verified properly - signature against the team's published
// keys, audience, issuer, expiry. Trusting the header's presence alone would be
// theatre: headers are only trustworthy because Cloudflare overwrites them at
// its edge, and that guarantee does not hold on a workers.dev URL or any other
// path that reaches the Worker without passing through Access.

import { queryOne } from './db.js';
import { estimateCost } from './budget.js';

/** Verified JWKS, cached per team domain for the process lifetime of the
 *  isolate. Key rotation is infrequent and a stale key fails closed. */
const jwkCache = new Map();

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function teamKeys(teamDomain) {
  if (jwkCache.has(teamDomain)) return jwkCache.get(teamDomain);
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`could not read Access keys (${res.status})`);
  const { keys } = await res.json();
  jwkCache.set(teamDomain, keys || []);
  return keys || [];
}

/**
 * Verify a Cloudflare Access assertion.
 *
 * Returns the caller's email on success and throws otherwise - never a boolean,
 * so a caller cannot accidentally treat a thrown failure as a pass.
 */
export async function verifyAccessJwt(env, request) {
  const token =
    request.headers.get('Cf-Access-Jwt-Assertion') ||
    (request.headers.get('Cookie') || '').match(/CF_Authorization=([^;]+)/)?.[1];
  if (!token) throw new Error('no Access assertion on this request');

  const [headerPart, payloadPart, signaturePart] = token.split('.');
  if (!headerPart || !payloadPart || !signaturePart) throw new Error('malformed Access assertion');

  const header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(headerPart)));
  const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadPart)));

  const keys = await teamKeys(env.CF_ACCESS_TEAM_DOMAIN);
  const jwk = keys.find((candidate) => candidate.kid === header.kid);
  if (!jwk) throw new Error('Access assertion signed by an unknown key');

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlToBytes(signaturePart),
    signed
  );
  if (!ok) throw new Error('Access assertion signature did not verify');

  // Signature alone proves the token was minted by the team - not that it was
  // minted for this application, or that it is still valid.
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(env.CF_ACCESS_AUD)) {
    throw new Error('Access assertion was issued for a different application');
  }
  if (payload.iss !== `https://${env.CF_ACCESS_TEAM_DOMAIN}`) {
    throw new Error('Access assertion came from a different team');
  }
  if (!payload.exp || payload.exp * 1000 < Date.now()) {
    throw new Error('Access assertion has expired');
  }

  return String(payload.email || '').toLowerCase();
}

/** True when Access is configured and therefore must be satisfied. */
export function accessConfigured(env) {
  return Boolean(env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD);
}

/**
 * Decide whether this request may see the admin page.
 *
 * Fails closed on every path, including an unset ADMIN_EMAIL - an admin surface
 * with no configured owner belongs to nobody, not to everybody.
 */
export async function adminGate(env, request, ctx) {
  const owner = String(env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!owner) return { ok: false, reason: 'no-owner' };

  if (!ctx.user || !ctx.session) return { ok: false, reason: 'signed-out' };
  if (!ctx.session.mfa_satisfied) return { ok: false, reason: 'signed-out' };
  if (String(ctx.user.email || '').trim().toLowerCase() !== owner) {
    return { ok: false, reason: 'not-owner' };
  }

  // Two-factor must actually be switched on, not merely satisfied.
  //
  // mfa_satisfied means "this session is not waiting on a code" - and it is set
  // on every session, including those belonging to accounts with no second
  // factor at all. Checking it alone would have read as a 2FA requirement while
  // enforcing nothing, which is the most dangerous kind of security code:
  // the sort that looks present in review.
  if (!ctx.user.totp_enabled) return { ok: false, reason: 'needs-2fa' };

  if (accessConfigured(env)) {
    try {
      const accessEmail = await verifyAccessJwt(env, request);
      if (accessEmail !== owner) return { ok: false, reason: 'not-owner' };
    } catch (err) {
      return { ok: false, reason: 'access', detail: err.message };
    }
  }

  return { ok: true, viaAccess: accessConfigured(env) };
}

/**
 * Counts for the admin page.
 *
 * Aggregates only - no addresses, no board contents. The page answers "how is
 * this being used", and a list of who is using it is a different question with
 * a different privacy weight; it does not need to be sitting on a dashboard to
 * be available when it is genuinely wanted.
 */
export async function adminStats(env) {
  const one = async (sql, ...args) => (await queryOne(env, sql, ...args)) || {};

  const users = await one(
    `SELECT COUNT(*) AS total,
            SUM(email_verified) AS verified,
            SUM(totp_enabled) AS with_2fa,
            MIN(created_at) AS first_signup,
            MAX(created_at) AS latest_signup
     FROM users`
  );
  const active = await one(
    `SELECT COUNT(DISTINCT user_id) AS n FROM boards`
  );
  const boards = await one(`SELECT COUNT(*) AS total FROM boards`);
  const jobs = await one(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'applied' THEN 1 ELSE 0 END) AS applied,
            SUM(CASE WHEN scored_by <> 'heuristic' AND scored_by <> '' THEN 1 ELSE 0 END) AS model_ranked
     FROM jobs`
  );
  const leads = await one(`SELECT COUNT(*) AS total FROM leads`);
  const today = await one(
    `SELECT COALESCE(SUM(calls), 0) AS calls,
            COALESCE(SUM(jobs_scored), 0) AS scored,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens
     FROM model_usage WHERE day = ?`,
    new Date().toISOString().slice(0, 10)
  );
  const allTime = await one(
    `SELECT COALESCE(SUM(calls), 0) AS calls,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens
     FROM model_usage`
  );
  const sources = await queryAllSafe(
    env,
    `SELECT kind, COUNT(*) AS n, SUM(found_count) AS found
     FROM sources GROUP BY kind ORDER BY n DESC`
  );

  // The shared company catalogue, which had no reporting at all until now -
  // there was no way to answer "is the Greenhouse list loaded yet?" without
  // database access. Classified and unclassified are counted separately
  // because they mean different things: a board with no category is in the
  // table but reaches nobody, since directoryFor matches an exact category.
  const catalogue = await queryAllSafe(
    env,
    `SELECT kind,
            COUNT(*) AS n,
            SUM(CASE WHEN category = '' THEN 1 ELSE 0 END) AS unclassified,
            SUM(CASE WHEN failed_streak >= 3 THEN 1 ELSE 0 END) AS retired
     FROM company_directory GROUP BY kind ORDER BY n DESC`
  );
  const catalogueFields = await queryAllSafe(
    env,
    `SELECT category, COUNT(*) AS n FROM company_directory
     WHERE category <> '' GROUP BY category ORDER BY n DESC`
  );

  return {
    users: {
      total: users.total || 0,
      verified: users.verified || 0,
      with2fa: users.with_2fa || 0,
      withBoards: active.n || 0,
      firstSignup: users.first_signup || '',
      latestSignup: users.latest_signup || '',
    },
    boards: boards.total || 0,
    jobs: {
      total: jobs.total || 0,
      applied: jobs.applied || 0,
      modelRanked: jobs.model_ranked || 0,
    },
    leads: leads.total || 0,
    modelToday: {
      calls: today.calls || 0,
      scored: today.scored || 0,
      inputTokens: today.input_tokens || 0,
      outputTokens: today.output_tokens || 0,
      cacheReadTokens: today.cache_read_tokens || 0,
      cost: estimateCost(
        {
          inputTokens: today.input_tokens || 0,
          outputTokens: today.output_tokens || 0,
          cacheReadTokens: today.cache_read_tokens || 0,
        },
        env.SCORING_MODEL || 'claude-opus-5'
      ),
    },
    modelAllTime: {
      calls: allTime.calls || 0,
      cost: estimateCost(
        {
          inputTokens: allTime.input_tokens || 0,
          outputTokens: allTime.output_tokens || 0,
          cacheReadTokens: allTime.cache_read_tokens || 0,
        },
        env.SCORING_MODEL || 'claude-opus-5'
      ),
    },
    sources,
    catalogue: {
      byPlatform: catalogue,
      byField: catalogueFields,
      total: catalogue.reduce((sum, row) => sum + (row.n || 0), 0),
      unclassified: catalogue.reduce((sum, row) => sum + (row.unclassified || 0), 0),
    },
    integrations: {
      aiRanking: Boolean(env.ANTHROPIC_API_KEY),
      twoFactor: Boolean(env.TOTP_ENC_KEY),
      email: Boolean(env.RESEND_API_KEY),
      adzuna: Boolean(env.ADZUNA_APP_ID && env.ADZUNA_APP_KEY),
      cloudflareAccess: accessConfigured(env),
    },
  };
}

/** A table that may not exist yet on an older database should read as empty
 *  rather than taking the whole page down. */
async function queryAllSafe(env, sql, ...args) {
  try {
    const { queryAll } = await import('./db.js');
    return await queryAll(env, sql, ...args);
  } catch {
    return [];
  }
}
