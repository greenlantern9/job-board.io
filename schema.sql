-- job-boards.io schema (Cloudflare D1 / SQLite)
--
-- worker.js applies this on demand the first time a query finds a table
-- missing, so you do not have to run it by hand. It is kept as the readable
-- reference for what the shape is.
--
-- Manual apply:
--   wrangler d1 execute job-board --remote --file=./schema.sql

-- ---------------------------------------------------------------- accounts --
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,       -- stored lowercased
  password_hash   TEXT NOT NULL,              -- pbkdf2$sha256$iters$salt$hash
  email_verified  INTEGER NOT NULL DEFAULT 0,
  totp_secret     TEXT NOT NULL DEFAULT '',   -- AES-GCM blob, empty until enrolled
  totp_pending    TEXT NOT NULL DEFAULT '',   -- enrolled-but-unconfirmed secret
  totp_enabled    INTEGER NOT NULL DEFAULT 0,
  recovery_codes  TEXT NOT NULL DEFAULT '[]', -- JSON array of SHA-256 hashes
  failed_logins   INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT NOT NULL DEFAULT '',   -- ISO 8601
  timezone        TEXT NOT NULL DEFAULT 'UTC',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_login_at   TEXT NOT NULL DEFAULT ''
);

-- Sessions store the SHA-256 of the cookie value, never the value itself, so a
-- database leak cannot be replayed as a login.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash    TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  mfa_satisfied INTEGER NOT NULL DEFAULT 0,   -- 0 = awaiting the TOTP challenge
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  ip            TEXT NOT NULL DEFAULT '',
  user_agent    TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- Single-use tokens for email verification and password reset.
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,                   -- verify | reset
  expires_at TEXT NOT NULL,
  used_at    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ------------------------------------------------------------------ boards --
CREATE TABLE IF NOT EXISTS boards (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  prompt        TEXT NOT NULL DEFAULT '',     -- free-text criteria, fed to the scorer
  filters       TEXT NOT NULL DEFAULT '{}',   -- JSON: keywords, exclude, locations, remote, min_salary, seniority
  refresh_mode  TEXT NOT NULL DEFAULT 'schedule', -- manual | schedule
  refresh_every INTEGER NOT NULL DEFAULT 60,  -- minutes
  last_refresh  TEXT NOT NULL DEFAULT '',
  last_error    TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_boards_user ON boards(user_id);

-- Where a board's jobs come from. `kind` selects the connector; `identifier`
-- is the company slug for ATS connectors or a URL for feeds.
CREATE TABLE IF NOT EXISTS sources (
  id           TEXT PRIMARY KEY,
  board_id     TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,                 -- greenhouse | lever | ashby | rss
  identifier   TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT '',
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_status  TEXT NOT NULL DEFAULT '',      -- ok | error
  last_error   TEXT NOT NULL DEFAULT '',
  last_fetched TEXT NOT NULL DEFAULT '',
  found_count  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sources_board ON sources(board_id);

-- -------------------------------------------------------------------- jobs --
CREATE TABLE IF NOT EXISTS jobs (
  id             TEXT PRIMARY KEY,
  board_id       TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  source_id      TEXT NOT NULL DEFAULT '',
  external_id    TEXT NOT NULL,               -- kind:slug:id, stable across refreshes
  title          TEXT NOT NULL,
  company        TEXT NOT NULL DEFAULT '',
  location       TEXT NOT NULL DEFAULT '',
  remote         INTEGER NOT NULL DEFAULT 0,
  employment     TEXT NOT NULL DEFAULT '',
  salary_min     INTEGER NOT NULL DEFAULT 0,
  salary_max     INTEGER NOT NULL DEFAULT 0,
  salary_raw     TEXT NOT NULL DEFAULT '',
  url            TEXT NOT NULL DEFAULT '',
  description    TEXT NOT NULL DEFAULT '',    -- plain text, truncated at ingest
  posted_at      TEXT NOT NULL DEFAULT '',
  discovered_at  TEXT NOT NULL,
  score          INTEGER NOT NULL DEFAULT 0,  -- 0-100
  score_reason   TEXT NOT NULL DEFAULT '',
  scored_by      TEXT NOT NULL DEFAULT '',    -- heuristic | model id
  scored_at      TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'new', -- new|saved|applied|interview|offer|rejected|archived
  position       INTEGER NOT NULL DEFAULT 0,  -- manual ordering within a kanban column
  notes          TEXT NOT NULL DEFAULT '',
  applied_at     TEXT NOT NULL DEFAULT '',
  notified_at    TEXT NOT NULL DEFAULT '',
  updated_at     TEXT NOT NULL,
  UNIQUE (board_id, external_id),
  FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_jobs_board_score ON jobs(board_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_board_status ON jobs(board_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_updated ON jobs(board_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_unscored ON jobs(scored_at);

-- ----------------------------------------------------------- notifications --
CREATE TABLE IF NOT EXISTS notification_rules (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  board_id     TEXT NOT NULL DEFAULT '',      -- empty = all boards
  channel      TEXT NOT NULL DEFAULT 'email',
  trigger_kind TEXT NOT NULL DEFAULT 'instant', -- instant | digest_daily | digest_weekly
  min_score    INTEGER NOT NULL DEFAULT 70,
  keywords     TEXT NOT NULL DEFAULT '',
  send_hour    INTEGER NOT NULL DEFAULT 8,    -- local hour for digests
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_sent_at TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_rules_user ON notification_rules(user_id);

-- Every send attempt lands here first, so a provider outage is visible in the
-- UI instead of silently dropping alerts. dedupe_key stops a job being
-- announced twice by the same rule.
CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  rule_id    TEXT NOT NULL DEFAULT '',
  channel    TEXT NOT NULL DEFAULT 'email',
  subject    TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'queued',  -- queued|sent|failed|skipped_no_provider
  error      TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT NOT NULL DEFAULT '',
  job_count  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  sent_at    TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(dedupe_key)
  WHERE dedupe_key <> '';
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
