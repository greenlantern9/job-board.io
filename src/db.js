// Schema bootstrap and small query helpers.
//
// The statements below are the executable copy of schema.sql - D1 has no
// migration runner on the free plan, and a Worker cannot read a .sql file at
// runtime. Keep the two in sync when adding a column; schema.sql is the
// readable reference, this is what actually runs.

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    email_verified INTEGER NOT NULL DEFAULT 0,
    totp_secret TEXT NOT NULL DEFAULT '',
    totp_pending TEXT NOT NULL DEFAULT '',
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    recovery_codes TEXT NOT NULL DEFAULT '[]',
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT NOT NULL DEFAULT '',
    timezone TEXT NOT NULL DEFAULT 'UTC',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    mfa_satisfied INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    ip TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at)`,
  `CREATE TABLE IF NOT EXISTS email_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL DEFAULT '',
    filters TEXT NOT NULL DEFAULT '{}',
    refresh_mode TEXT NOT NULL DEFAULT 'schedule',
    refresh_every INTEGER NOT NULL DEFAULT 1440,
    last_refresh TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_boards_user ON boards(user_id)`,
  `CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    identifier TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_status TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '',
    last_fetched TEXT NOT NULL DEFAULT '',
    found_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sources_board ON sources(board_id)`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    source_id TEXT NOT NULL DEFAULT '',
    external_id TEXT NOT NULL,
    title TEXT NOT NULL,
    company TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    remote INTEGER NOT NULL DEFAULT 0,
    employment TEXT NOT NULL DEFAULT '',
    salary_min INTEGER NOT NULL DEFAULT 0,
    salary_max INTEGER NOT NULL DEFAULT 0,
    salary_raw TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    posted_at TEXT NOT NULL DEFAULT '',
    discovered_at TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    score_reason TEXT NOT NULL DEFAULT '',
    scored_by TEXT NOT NULL DEFAULT '',
    scored_at TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    position INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    applied_at TEXT NOT NULL DEFAULT '',
    notified_at TEXT NOT NULL DEFAULT '',
    missing_streak INTEGER NOT NULL DEFAULT 0,
    closed_at TEXT NOT NULL DEFAULT '',
    link_direct INTEGER NOT NULL DEFAULT 0,
    link_status TEXT NOT NULL DEFAULT '',
    link_checked_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE (board_id, external_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_board_score ON jobs(board_id, score DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_board_status ON jobs(board_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_updated ON jobs(board_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_unscored ON jobs(scored_at)`,
  `CREATE TABLE IF NOT EXISTS notification_rules (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    board_id TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL DEFAULT 'email',
    trigger_kind TEXT NOT NULL DEFAULT 'instant',
    min_score INTEGER NOT NULL DEFAULT 70,
    keywords TEXT NOT NULL DEFAULT '',
    send_hour INTEGER NOT NULL DEFAULT 8,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_sent_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rules_user ON notification_rules(user_id)`,
  `CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    rule_id TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL DEFAULT 'email',
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued',
    error TEXT NOT NULL DEFAULT '',
    dedupe_key TEXT NOT NULL DEFAULT '',
    job_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(dedupe_key) WHERE dedupe_key <> ''`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC)`,
];

/**
 * Columns added after a table first shipped.
 *
 * CREATE TABLE IF NOT EXISTS is a no-op once the table exists, so new columns
 * need ALTER. SQLite has no ADD COLUMN IF NOT EXISTS, and D1 aborts a whole
 * batch on one failure - so these run individually and a "duplicate column"
 * error is the expected outcome on every deploy after the first.
 */
const MIGRATIONS = [
  // Sources the system chose, versus ones the user added by hand. Curation only
  // ever prunes its own picks.
  `ALTER TABLE sources ADD COLUMN auto INTEGER NOT NULL DEFAULT 0`,
  // Consecutive refreshes that produced nothing, used to retire dead boards.
  `ALTER TABLE sources ADD COLUMN empty_streak INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE boards ADD COLUMN last_curated TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE boards ADD COLUMN curate_note TEXT NOT NULL DEFAULT ''`,
  // Scheduled refreshes are capped at one a day; boards written before the cap
  // still carry hourly. Idempotent, so re-running it on every cold isolate is
  // harmless.
  `UPDATE boards SET refresh_every = 1440 WHERE refresh_every < 1440`,
  // Consecutive refreshes in which a company board stopped listing this job.
  `ALTER TABLE jobs ADD COLUMN missing_streak INTEGER NOT NULL DEFAULT 0`,
  // Set when a job has been absent long enough to call it filled or pulled.
  `ALTER TABLE jobs ADD COLUMN closed_at TEXT NOT NULL DEFAULT ''`,
  // 1 when the url reaches the employer's own careers site rather than an
  // aggregator's landing page.
  `ALTER TABLE jobs ADD COLUMN link_direct INTEGER NOT NULL DEFAULT 0`,
  // live | dead | unknown - the result of actually fetching the posting.
  `ALTER TABLE jobs ADD COLUMN link_status TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE jobs ADD COLUMN link_checked_at TEXT NOT NULL DEFAULT ''`,
];

// Per-isolate latch. A cold isolate pays one batch; every later request skips
// straight through.
let schemaReady = false;

export async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(STATEMENTS.map((sql) => env.DB.prepare(sql)));

  for (const sql of MIGRATIONS) {
    try {
      await env.DB.prepare(sql).run();
    } catch (err) {
      // Already applied. Anything else is worth seeing in the logs, but must
      // not take down every request on the isolate.
      const message = String(err && err.message);
      if (!/duplicate column/i.test(message)) {
        console.error('migration failed', sql, message);
      }
    }
  }

  schemaReady = true;
}

/** Reset the latch - only used by tests. */
export function _resetSchemaLatch() {
  schemaReady = false;
}

export const nowIso = () => new Date().toISOString();

export function isoIn(ms) {
  return new Date(Date.now() + ms).toISOString();
}

export async function queryAll(env, sql, ...params) {
  const { results } = await env.DB.prepare(sql)
    .bind(...params)
    .all();
  return results || [];
}

export async function queryOne(env, sql, ...params) {
  return (
    (await env.DB.prepare(sql)
      .bind(...params)
      .first()) || null
  );
}

export async function run(env, sql, ...params) {
  return env.DB.prepare(sql)
    .bind(...params)
    .run();
}

/** Best-effort JSON column read - a malformed value must not 500 a page. */
export function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}
