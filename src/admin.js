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

import { queryOne, run, nowIso, isoIn } from './db.js';
import { sha256Hex, newSecretToken } from './crypto.js';
import { recentErrors, errorSummary, accountActivity, listFeedback, notionConfigured } from './ops.js';
import { estimateCost } from './budget.js';
import { ATS_KINDS } from './sources.js';
import { CATEGORIES } from './categories.js';

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

  // The account has to carry the flag, not merely hold the address.
  //
  // Addresses cannot be changed in this app, but accounts can be deleted - and
  // once deleted, the address is free for anyone to register. A check against
  // ADMIN_EMAIL alone would hand the new account everything the old one had.
  // The flag is granted to a user id and a re-registration is a different id,
  // so that path is closed.
  //
  // Both are still required. The flag alone would leave admin rights sitting on
  // an account after the owner changed, and the address alone is what this is
  // fixing; needing both means an attacker has to obtain a specific account
  // rather than either one of its properties.
  if (!ctx.user.is_admin) return { ok: false, reason: 'not-owner' };
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
 * Everything the operations view needs: who is using the service, what is
 * failing for them, and what they have asked for.
 *
 * Separate from adminStats because it carries addresses and free text, which
 * the counts deliberately do not - keeping them apart makes it obvious which
 * call returns what.
 */
export async function adminOperations(env) {
  const [errors, errorKinds, accounts, feedback] = await Promise.all([
    recentErrors(env, { limit: 40 }).catch(() => []),
    errorSummary(env, { hours: 24 }).catch(() => []),
    accountActivity(env, { limit: 50 }).catch(() => []),
    listFeedback(env, { limit: 50 }).catch(() => []),
  ]);

  return {
    errors,
    errorKinds,
    accounts,
    feedback,
    feedbackForwarding: notionConfigured(env),
  };
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
  const cataloguePlatforms = await queryAllSafe(
    env,
    `SELECT kind,
            COUNT(*) AS n,
            SUM(CASE WHEN category = '' THEN 1 ELSE 0 END) AS unclassified,
            SUM(CASE WHEN category = '' AND verified_at <> '' AND job_count = 0 THEN 1 ELSE 0 END) AS quiet,
            SUM(CASE WHEN failed_streak >= 3 THEN 1 ELSE 0 END) AS retired,
            SUM(CASE WHEN timeout_streak > 0 THEN 1 ELSE 0 END) AS slow,
            SUM(job_count) AS jobs,
            MAX(verified_at) AS last_read
     FROM company_directory GROUP BY kind ORDER BY n DESC`
  );

  // Every connected platform appears, including the ones nothing has seeded
  // yet. A kind absent from the table reads as "not connected", which is the
  // wrong answer for a connector that is live and simply has one seed row or
  // none - the zero is the honest number, so it is shown.
  const seen = new Set(cataloguePlatforms.map((row) => row.kind));
  const catalogue = [
    ...cataloguePlatforms,
    ...ATS_KINDS.filter((kind) => !seen.has(kind))
      .sort()
      .map((kind) => ({ kind, n: 0, unclassified: 0, quiet: 0, retired: 0, slow: 0, jobs: 0, last_read: '' })),
  ];
  const fieldRows = await queryAllSafe(
    env,
    `SELECT category, COUNT(*) AS n, SUM(job_count) AS jobs FROM company_directory
     WHERE category <> '' GROUP BY category ORDER BY jobs DESC`
  );

  // Coverage is only readable when the gaps are in the picture. A GROUP BY
  // omits categories with no employers, and those are precisely the fields
  // where a board comes up empty - "registered nurse returned nothing" was a
  // gap exactly like this, invisible because nothing counted it. Every field
  // the product offers appears, zeros included, with its human label.
  const byId = new Map(fieldRows.map((row) => [row.category, row]));
  const catalogueFields = CATEGORIES.map((cat) => {
    const row = byId.get(cat.id) || { n: 0, jobs: 0 };
    return { category: cat.id, label: cat.label, n: row.n || 0, jobs: row.jobs || 0 };
  }).sort((x, y) => y.jobs - x.jobs || y.n - x.n);

  // Readiness of the shared catalogue, and the largest sources in it.
  //
  // Owner-only, deliberately. This says how the corpus is built and which
  // employers carry it, which is not something a visitor needs and not
  // something to hand out from a public endpoint.
  const readiness = await one(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN category <> '' THEN 1 ELSE 0 END) AS classified,
            SUM(CASE WHEN title_terms <> '' THEN 1 ELSE 0 END) AS with_vocabulary,
            SUM(CASE WHEN job_count > 0 THEN 1 ELSE 0 END) AS counted,
            SUM(CASE WHEN failed_streak >= 3 THEN 1 ELSE 0 END) AS retired,
            SUM(CASE WHEN timeout_streak > 0 THEN 1 ELSE 0 END) AS slow,
            -- Read, answered, and had nothing to say. These cannot classify
            -- until they post again, and lumping them into "unclassified" made
            -- a finished fill read as a stalled one.
            SUM(CASE WHEN category = '' AND verified_at <> '' AND job_count = 0 THEN 1 ELSE 0 END) AS quiet
     FROM company_directory`
  );
  const biggest = await queryAllSafe(
    env,
    `SELECT identifier, job_count, failed_streak, timeout_streak
     FROM company_directory ORDER BY job_count DESC LIMIT 12`
  );
  const heartbeat = await one(
    "SELECT attempted_at FROM discovery_attempts WHERE category = '__cron'"
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
      readiness: {
        total: readiness.total || 0,
        classified: readiness.classified || 0,
        withVocabulary: readiness.with_vocabulary || 0,
        counted: readiness.counted || 0,
        retired: readiness.retired || 0,
        slow: readiness.slow || 0,
        quiet: readiness.quiet || 0,
      },
      biggest,
      lastCron: (heartbeat && heartbeat.attempted_at) || 'never',
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

/**
 * Mint a password-reset link for an account, for the owner to hand over
 * out-of-band - in person, by text, however they reach the person. With email
 * delivery switched off, the mail flow cannot send its link anywhere, which
 * made the owner the only recovery path for every account on the service
 * while giving them no way to actually be one.
 *
 * The token is the same object the mail flow mints: stored as a SHA-256 hash,
 * kind 'reset', one hour, single use. Consuming it goes through the ordinary
 * resetPassword handler, so it also clears the lockout counter and destroys
 * every existing session - this path changes who can start a reset, never
 * what a reset does. The owner never sees or sets the password itself.
 */
export async function mintResetLink(env, { userId } = {}) {
  const user = await queryOne(env, 'SELECT id, email FROM users WHERE id = ?', String(userId || ''));
  if (!user) return { error: 'No such account.' };

  // Outstanding unused reset tokens die first. The mail flow tolerates several
  // live at once because each left the building already; this one is displayed,
  // and a fresh mint should mean earlier handed-out links stop working.
  await run(
    env,
    `UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND kind = 'reset' AND used_at = ''`,
    nowIso(),
    user.id
  );

  const token = newSecretToken();
  const expiresAt = isoIn(60 * 60 * 1000);
  await run(
    env,
    `INSERT INTO email_tokens (token_hash, user_id, kind, expires_at, created_at)
     VALUES (?, ?, 'reset', ?, ?)`,
    await sha256Hex(token),
    user.id,
    expiresAt,
    nowIso()
  );

  return {
    ok: true,
    email: user.email,
    url: `${env.SITE_URL || 'https://job-boards.io'}/reset?token=${encodeURIComponent(token)}`,
    expiresAt,
  };
}


/**
 * Coverage for one topic word (or a few), answered from the vocabulary the
 * classifier already keeps. The fields chart shows the ten broad categories,
 * but "how many aerospace roles do I have" is a topic question - aerospace
 * employers sit inside software or trades - and the title_terms column is
 * where that answer lives.
 *
 * The input is normalized exactly the way titleTerms() normalizes titles
 * (lowercase, the same separator class, three-letter minimum), and matching is
 * exact-word - ' ' || title_terms || ' ' LIKE '% word %' - which is the SQL
 * spelling of the Set membership employer selection uses. Same semantics in,
 * same semantics out: what this reports matching is what a board would reach.
 * Several words mean all of them, since "aerospace engineer" asks for
 * employers advertising both.
 */
export async function termCoverage(env, rawQuery) {
  const terms = [
    ...new Set(
      String(rawQuery || '')
        .toLowerCase()
        .split(/[^a-z0-9+#]+/)
        .filter((word) => word.length >= 3)
    ),
  ].slice(0, 3);
  if (!terms.length) return { error: 'Give me at least one word of three letters or more.' };

  // Terms are already reduced to [a-z0-9+#], so no LIKE wildcard can survive
  // normalization; the parameters are bound regardless.
  const where = terms.map(() => `' ' || title_terms || ' ' LIKE ?`).join(' AND ');
  const binds = terms.map((term) => `% ${term} %`);

  const totals = await queryOne(
    env,
    `SELECT COUNT(*) AS n, COALESCE(SUM(job_count), 0) AS jobs
     FROM company_directory WHERE failed_streak < 3 AND ${where}`,
    ...binds
  );
  const byField = await queryAllSafe(
    env,
    `SELECT category, COUNT(*) AS n, COALESCE(SUM(job_count), 0) AS jobs
     FROM company_directory WHERE failed_streak < 3 AND ${where}
     GROUP BY category ORDER BY jobs DESC`,
    ...binds
  );
  const employers = await queryAllSafe(
    env,
    `SELECT name, kind, identifier, job_count FROM company_directory
     WHERE failed_streak < 3 AND ${where}
     ORDER BY job_count DESC LIMIT 8`,
    ...binds
  );

  const labels = new Map(CATEGORIES.map((cat) => [cat.id, cat.label]));
  return {
    terms,
    employers: (totals && totals.n) || 0,
    jobs: (totals && totals.jobs) || 0,
    byField: byField.map((row) => ({
      category: row.category,
      label: labels.get(row.category) || row.category || 'unclassified',
      n: row.n || 0,
      jobs: row.jobs || 0,
    })),
    top: employers.map((row) => ({
      name: row.name || row.identifier,
      kind: row.kind,
      jobs: row.job_count || 0,
    })),
  };
}
