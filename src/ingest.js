// Board refresh: pull every enabled source, filter, persist what is new, and
// score it.

import { fetchSource, matchesFilters } from './sources.js';
import { scoreJobs } from './scoring.js';
import { queryAll, run, nowIso, parseJson } from './db.js';
import { newId } from './crypto.js';

/** Jobs older than this are dropped at ingest - they are almost always filled. */
const MAX_AGE_DAYS = 120;

/** One scheduled refresh a day. See clampRefreshInterval in routes/app.js. */
export const MIN_REFRESH_MINUTES = 1440;

function isTooOld(job) {
  if (!job.postedAt) return false;
  const age = (Date.now() - new Date(job.postedAt).getTime()) / 86400000;
  return Number.isFinite(age) && age > MAX_AGE_DAYS;
}

export function boardWithFilters(row) {
  return { ...row, filters: parseJson(row.filters, {}) };
}

/**
 * Refreshes one board. Never throws: a failing source is recorded against that
 * source row and the others still run, because one dead company page should
 * not stop the whole board from updating.
 */
export async function refreshBoard(env, boardRow, { selfHost } = {}) {
  const board = boardWithFilters(boardRow);
  const sources = await queryAll(
    env,
    'SELECT * FROM sources WHERE board_id = ? AND enabled = 1',
    board.id
  );

  const summary = {
    boardId: board.id,
    sourcesRun: 0,
    sourcesFailed: 0,
    fetched: 0,
    filteredOut: 0,
    added: 0,
    updated: 0,
    warnings: [],
  };

  if (sources.length === 0) {
    // Curation is what fills this in, and it runs on board creation and on a
    // schedule. Say that rather than sending the user off to configure things.
    await run(
      env,
      `UPDATE boards SET last_refresh = ?, last_error = ?, updated_at = ? WHERE id = ?`,
      nowIso(),
      'Still finding sources for this board. This usually takes a few seconds.',
      nowIso(),
      board.id
    );
    summary.warnings.push('No sources connected yet.');
    return summary;
  }

  const existing = new Map();
  for (const row of await queryAll(
    env,
    'SELECT id, external_id FROM jobs WHERE board_id = ?',
    board.id
  )) {
    existing.set(row.external_id, row.id);
  }

  const toInsert = [];
  const toUpdate = [];
  const seen = new Set();

  for (const source of sources) {
    let jobs;
    try {
      jobs = await fetchSource(source, { selfHost });
      summary.sourcesRun++;
    } catch (err) {
      summary.sourcesFailed++;
      summary.warnings.push(`${source.label || source.identifier}: ${err.message}`);
      await run(
        env,
        `UPDATE sources SET last_status = 'error', last_error = ?, last_fetched = ? WHERE id = ?`,
        String(err.message).slice(0, 300),
        nowIso(),
        source.id
      );
      continue;
    }

    let kept = 0;
    for (const job of jobs) {
      summary.fetched++;
      // A job can legitimately appear in two sources; first one wins.
      if (seen.has(job.externalId)) continue;
      seen.add(job.externalId);

      if (isTooOld(job) || !matchesFilters(job, board.filters)) {
        summary.filteredOut++;
        continue;
      }
      kept++;

      const existingId = existing.get(job.externalId);
      if (existingId) {
        toUpdate.push({ id: existingId, job });
      } else {
        toInsert.push({ id: newId('job_'), sourceId: source.id, job });
      }
    }

    // empty_streak drives retirement: a board that keeps returning nothing has
    // either stopped hiring or no longer matches, and curation reclaims the
    // slot. Any yield at all resets it.
    await run(
      env,
      `UPDATE sources SET last_status = 'ok', last_error = '', last_fetched = ?, found_count = ?,
         empty_streak = CASE WHEN ? > 0 THEN 0 ELSE empty_streak + 1 END
       WHERE id = ?`,
      nowIso(),
      kept,
      kept,
      source.id
    );
  }

  const now = nowIso();

  // Refresh the facts on jobs we already track, but never touch status, notes,
  // position, or applied_at - that is the user's data, not the source's.
  if (toUpdate.length > 0) {
    await env.DB.batch(
      toUpdate.map(({ id, job }) =>
        env.DB.prepare(
          `UPDATE jobs SET title = ?, company = ?, location = ?, remote = ?, employment = ?,
             salary_min = ?, salary_max = ?, salary_raw = ?, url = ?, description = ?,
             posted_at = ?, updated_at = ?
           WHERE id = ?`
        ).bind(
          job.title,
          job.company,
          job.location,
          job.remote ? 1 : 0,
          job.employment,
          job.salaryMin,
          job.salaryMax,
          job.salaryRaw,
          job.url,
          job.description,
          job.postedAt,
          now,
          id
        )
      )
    );
    summary.updated = toUpdate.length;
  }

  if (toInsert.length > 0) {
    await env.DB.batch(
      toInsert.map(({ id, sourceId, job }) =>
        env.DB.prepare(
          `INSERT INTO jobs (id, board_id, user_id, source_id, external_id, title, company, location,
             remote, employment, salary_min, salary_max, salary_raw, url, description, posted_at,
             discovered_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (board_id, external_id) DO NOTHING`
        ).bind(
          id,
          board.id,
          board.user_id,
          sourceId,
          job.externalId,
          job.title,
          job.company,
          job.location,
          job.remote ? 1 : 0,
          job.employment,
          job.salaryMin,
          job.salaryMax,
          job.salaryRaw,
          job.url,
          job.description,
          job.postedAt,
          now,
          now
        )
      )
    );
    summary.added = toInsert.length;
  }

  const scoring = await scoreUnscored(env, board);
  summary.warnings.push(...scoring.warnings);
  summary.scored = scoring.scored;

  await run(
    env,
    `UPDATE boards SET last_refresh = ?, last_error = ?, updated_at = ? WHERE id = ?`,
    nowIso(),
    summary.sourcesFailed > 0 ? summary.warnings.slice(0, 3).join(' | ').slice(0, 500) : '',
    nowIso(),
    board.id
  );

  return summary;
}

/**
 * Scores anything on the board that has not been scored yet. Split out from
 * refresh so that "rescore with new criteria" can reuse it without refetching.
 *
 * The limit is high on purpose. The heuristic is pure local CPU, so every job
 * can afford one - and a job with no score at all shows up in the list as a
 * bare 0 with no reason, which reads as broken. Model spend is bounded
 * separately, inside scoreJobs, which only sends its first few batches.
 */
export async function scoreUnscored(env, board, { limit = 500, force = false } = {}) {
  const rows = await queryAll(
    env,
    force
      ? `SELECT * FROM jobs WHERE board_id = ? AND status <> 'archived' ORDER BY discovered_at DESC LIMIT ?`
      : `SELECT * FROM jobs WHERE board_id = ? AND scored_at = '' ORDER BY discovered_at DESC LIMIT ?`,
    board.id,
    limit
  );
  if (rows.length === 0) return { scored: 0, warnings: [] };

  const jobs = rows.map((row) => ({
    id: row.id,
    title: row.title,
    company: row.company,
    location: row.location,
    remote: Boolean(row.remote),
    employment: row.employment,
    salaryMin: row.salary_min,
    salaryMax: row.salary_max,
    salaryRaw: row.salary_raw,
    description: row.description,
    postedAt: row.posted_at,
  }));

  const { results, warnings } = await scoreJobs(env, jobs, board);
  const now = nowIso();

  // Chunked: a single batch of several hundred statements risks tripping D1's
  // per-batch limits on a board with a lot of new listings.
  const updates = [...results.entries()].map(([id, value]) =>
    env.DB.prepare(
      'UPDATE jobs SET score = ?, score_reason = ?, scored_by = ?, scored_at = ?, updated_at = ? WHERE id = ?'
    ).bind(value.score, value.reason, value.scoredBy, now, now, id)
  );
  for (let i = 0; i < updates.length; i += 100) {
    await env.DB.batch(updates.slice(i, i + 100));
  }

  return { scored: results.size, warnings };
}

/** Boards whose schedule has come due. Driven by the cron trigger. */
export async function boardsDueForRefresh(env, { limit = 25 } = {}) {
  const rows = await queryAll(
    env,
    `SELECT * FROM boards WHERE refresh_mode = 'schedule' ORDER BY last_refresh ASC LIMIT ?`,
    limit
  );
  const now = Date.now();
  return rows.filter((board) => {
    if (!board.last_refresh) return true;
    const elapsed = now - new Date(board.last_refresh).getTime();
    // Floored at a day regardless of what is stored, so a board written before
    // the cap - or through the API directly - cannot schedule itself hourly.
    return elapsed >= Math.max(MIN_REFRESH_MINUTES, board.refresh_every || MIN_REFRESH_MINUTES) * 60000;
  });
}
