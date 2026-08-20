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
    is_admin INTEGER NOT NULL DEFAULT 0,
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
  // Leads from a scout run: organisations to approach, not postings to apply
  // to. Kept in their own table rather than as rows in jobs, because
  // conflating "somewhere worth writing to" with "a job you can apply for"
  // would misrepresent both - and a lead has no posting to expire.
  `CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    website TEXT NOT NULL DEFAULT '',
    contact_url TEXT NOT NULL DEFAULT '',
    relevance TEXT NOT NULL DEFAULT '',
    approach TEXT NOT NULL DEFAULT '',
    signal TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (board_id, website)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_leads_board ON leads(board_id, created_at DESC)`,
  // Company boards discovered once and shared by everyone.
  //
  // No applicant tracking system publishes a directory - Greenhouse has
  // thousands of customers and no endpoint that lists or searches them, so the
  // only way in is a slug you already know. Finding one costs web searches;
  // the slug it yields is then valid forever and identical for every user.
  //
  // Caching it globally is what keeps that affordable: discovery is paid for
  // once, by whoever needed it first, and every later board in the same
  // category gets it for nothing. The catalogue grows and the marginal cost of
  // a new board falls toward zero.
  `CREATE TABLE IF NOT EXISTS company_directory (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    identifier TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'other',
    title_terms TEXT NOT NULL DEFAULT '',
    job_count INTEGER NOT NULL DEFAULT 0,
    timeout_streak INTEGER NOT NULL DEFAULT 0,
    verified_at TEXT NOT NULL DEFAULT '',
    failed_streak INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE (kind, identifier)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_directory_category ON company_directory(category, job_count DESC)`,
  // When each field was last searched for new company boards.
  //
  // Needed because a fruitless attempt leaves no trace anywhere else: if the
  // only evidence of discovery were the rows it created, a field where nothing
  // could be found would be retried on every tick forever.
  `CREATE TABLE IF NOT EXISTS discovery_attempts (
    category TEXT PRIMARY KEY,
    attempted_at TEXT NOT NULL,
    found INTEGER NOT NULL DEFAULT 0
  )`,
  // Things that went wrong for somebody, kept so they can be seen.
  //
  // Failures were being written where they happened - a board's last_error, a
  // source's last_error, a console line - which meant each one was visible only
  // to whoever went looking in the right row. There was no way to answer "what
  // is breaking for people", which is the question that matters.
  `CREATE TABLE IF NOT EXISTS error_log (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    context TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_error_log_time ON error_log(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_error_log_kind ON error_log(kind, created_at DESC)`,

  // What people ask for, and what they report broken.
  `CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'idea',
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    page TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    forwarded_at TEXT NOT NULL DEFAULT '',
    forward_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_feedback_time ON feedback(created_at DESC)`,

  // Model calls per account per day. The ceiling is enforced rather than
  // advised, because every other path degrades silently when the model is
  // unavailable - so an overspend would have no symptom until the bill.
  `CREATE TABLE IF NOT EXISTS model_usage (
    user_id TEXT NOT NULL,
    day TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    jobs_scored INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, day)
  )`,
  // One row per status change, with a copy of the posting as it read at the
  // time. Postings get edited and delisted, so without this the record of what
  // you actually applied to disappears exactly when you need it - preparing for
  // the interview.
  `CREATE TABLE IF NOT EXISTS job_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    board_id TEXT NOT NULL DEFAULT '',
    from_status TEXT NOT NULL DEFAULT '',
    to_status TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    snapshot TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_job_events_user ON job_events(user_id, created_at DESC)`,
  // Optional candidate profile. One row per user; absent or disabled means the
  // ranking behaves exactly as it did before profiles existed.
  `CREATE TABLE IF NOT EXISTS profiles (
    user_id TEXT PRIMARY KEY,
    headline TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    skills TEXT NOT NULL DEFAULT '[]',
    titles TEXT NOT NULL DEFAULT '[]',
    years_experience INTEGER NOT NULL DEFAULT 0,
    seniority INTEGER,
    must_have TEXT NOT NULL DEFAULT '[]',
    deal_breakers TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
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
  // Slowness, counted separately from failure.
  //
  // A board that times out is not a board that has gone away, and the two were
  // sharing a column. Timeouts retired the four largest employers in the
  // catalogue - the biggest listings take the longest to read, so the richest
  // sources were the first to be deleted from every search.
  `ALTER TABLE company_directory ADD COLUMN timeout_streak INTEGER NOT NULL DEFAULT 0`,
  // The role words an employer's board actually contains.
  //
  // Employers were connected by field and by size, neither of which says
  // whether a company is hiring for the role somebody searched. Of eighteen
  // company boards on one programme-management board, eight were advertising
  // programme-management roles and none of those eight had been connected.
  // Classification already reads every title on every board; this keeps what it
  // saw, so the choice can be made on evidence instead of on size.
  `ALTER TABLE company_directory ADD COLUMN title_terms TEXT NOT NULL DEFAULT ''`,
  // Administrator status as a property of the account rather than a string
  // comparison against configuration.
  //
  // The gate used to admit whoever held the address in ADMIT_EMAIL. Addresses
  // cannot be changed in this app, so that was sound while the account existed
  // - but accounts can be deleted, and a deleted address can be registered
  // again by anyone. The flag cannot be claimed that way: it is granted to a
  // user id, and a new account with the same address is a different id.
  `ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`,
  // What each model call actually consumed. The table counted calls from the
  // start but never tokens, so the only answer to "what is this costing" was
  // arithmetic over the payload caps - an estimate nobody could check.
  `ALTER TABLE model_usage ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE model_usage ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE model_usage ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0`,
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
  // When the status last changed, so "gone quiet" measures silence since the
  // last real move rather than since any edit. updated_at is bumped by notes,
  // scoring and source refreshes, which would reset the clock constantly.
  `ALTER TABLE jobs ADD COLUMN status_changed_at TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE jobs ADD COLUMN followed_up_at TEXT NOT NULL DEFAULT ''`,
  // What the job asks for that the profile does not cover. Stored so the
  // skill-gap report can aggregate without re-scoring everything.
  `ALTER TABLE jobs ADD COLUMN gaps TEXT NOT NULL DEFAULT '[]'`,
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

  await grantAdmin(env);
  await repairTimeoutRetirements(env);

  schemaReady = true;
}

/**
 * Undo retirements caused by slowness rather than by failure.
 *
 * Runs once, recorded by a marker row. Boards that have ever returned jobs are
 * not dead; they were dropped because reading them took longer than a refresh
 * was willing to wait, which says something about their size and nothing about
 * whether they exist.
 */
async function repairTimeoutRetirements(env) {
  try {
    const done = await queryOne(
      env,
      "SELECT category FROM discovery_attempts WHERE category = '__unretired_v2'"
    );
    if (done) return;

    // Run again, because the first pass only half fixed it.
    //
    // The transient/timeout split was applied where boards are refreshed but
    // not where they are classified, and classification reads five hundred a
    // tick - so employers went on being retired for slowness immediately after
    // the first repair, and the marker for that repair had already been set.
    // The counters are cleared together this time: a slow row that is never
    // revisited never gets the vocabulary that makes it findable.
    await env.DB.prepare(
      'UPDATE company_directory SET failed_streak = 0, timeout_streak = 0 WHERE (failed_streak > 0 OR timeout_streak > 0) AND job_count > 0'
    ).run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO discovery_attempts (category, attempted_at, found) VALUES ('__unretired_v2', ?, 0)"
    )
      .bind(nowIso())
      .run();
  } catch (err) {
    console.error('unretire failed', String((err && err.message) || err));
  }
}

/**
 * Grant the admin flag to the configured owner, once.
 *
 * Only fires while no administrator exists, so the flag is bootstrapped on
 * first deploy and never handed out again by configuration alone. Changing
 * ADMIN_EMAIL afterwards does not move admin rights to the new address, which
 * is the point: rights belong to an account, and moving them should take a
 * deliberate database change rather than an edit to a committed config file.
 */
async function grantAdmin(env) {
  const owner = String(env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!owner) return;

  try {
    const existing = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM users WHERE is_admin = 1'
    ).first();
    if (existing && existing.n > 0) return;

    await env.DB.prepare('UPDATE users SET is_admin = 1 WHERE lower(email) = ?')
      .bind(owner)
      .run();
  } catch (err) {
    // Never take down every request because the grant could not run.
    console.error('admin grant failed', String(err && err.message));
  }
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
