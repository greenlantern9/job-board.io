// Two things the board knows but never told anyone.
//
// Applications that have gone quiet, and the skills that keep coming up in
// jobs you did not quite match. Both fall out of data already being stored;
// neither needs an API key.

import { queryAll, nowIso, parseJson } from './db.js';
import { extractSkillsHeuristically } from './profile.js';

/**
 * Days of silence before an application is worth chasing.
 *
 * Ten is the usual advice and it is roughly right: long enough not to look
 * impatient, short enough that the role is still open and the hiring manager
 * remembers reading your name.
 */
export const FOLLOWUP_AFTER_DAYS = 10;

/** Statuses where the ball is plausibly in their court. */
const IN_FLIGHT = ['applied', 'interview'];

/**
 * Applications that have not moved in a while.
 *
 * Silence is measured from the last status change, not from updated_at - notes,
 * re-scoring and source refreshes all bump the latter, which would reset the
 * clock and mean this never fired.
 */
export async function quietApplications(env, userId, { afterDays = FOLLOWUP_AFTER_DAYS } = {}) {
  const cutoff = new Date(Date.now() - afterDays * 86400000).toISOString();

  const rows = await queryAll(
    env,
    `SELECT j.id, j.title, j.company, j.url, j.status, j.applied_at, j.status_changed_at,
            j.followed_up_at, j.closed_at, b.name AS board_name
     FROM jobs j
     JOIN boards b ON b.id = j.board_id
     WHERE j.user_id = ?
       AND j.status IN ('applied', 'interview')
       AND j.followed_up_at = ''
       AND COALESCE(NULLIF(j.status_changed_at, ''), NULLIF(j.applied_at, ''), j.updated_at) <= ?
     ORDER BY COALESCE(NULLIF(j.status_changed_at, ''), NULLIF(j.applied_at, ''), j.updated_at) ASC
     LIMIT 50`,
    userId,
    cutoff
  );

  const now = Date.now();
  return rows.map((row) => {
    const since = row.status_changed_at || row.applied_at || '';
    const days = since ? Math.floor((now - new Date(since).getTime()) / 86400000) : null;
    return {
      id: row.id,
      title: row.title,
      company: row.company,
      url: row.url,
      status: row.status,
      boardName: row.board_name,
      quietForDays: days,
      since,
      // Worth knowing before chasing: the listing may already be gone.
      delisted: Boolean(row.closed_at),
    };
  });
}

/**
 * Skills that keep appearing in jobs the profile does not cover.
 *
 * Weighted by the job's score, so a gap on something scoring 90 counts for more
 * than the same gap on something scoring 30 - the point is what is standing
 * between you and the roles you actually want, not every skill in the market.
 */
export async function skillGapReport(env, userId, profile, { limit = 12 } = {}) {
  if (!profile) return { ready: false, reason: 'no-profile', gaps: [] };

  const rows = await queryAll(
    env,
    `SELECT title, company, description, score
     FROM jobs
     WHERE user_id = ? AND status NOT IN ('archived', 'delisted') AND scored_at <> ''
     ORDER BY score DESC LIMIT 200`,
    userId
  );
  if (rows.length === 0) return { ready: false, reason: 'no-jobs', gaps: [] };

  const known = new Set((profile.skills || []).map((s) => String(s).toLowerCase()));
  const tally = new Map();

  for (const row of rows) {
    const required = extractSkillsHeuristically(`${row.title} ${row.description}`);
    for (const skill of required) {
      if (known.has(skill)) continue;
      const entry = tally.get(skill) || { skill, jobs: 0, weight: 0, examples: [] };
      entry.jobs++;
      // Square-ish weighting so a handful of strong matches outrank a long
      // tail of weak ones.
      entry.weight += Math.max(1, row.score) ** 1.5;
      if (entry.examples.length < 3) entry.examples.push(`${row.title} at ${row.company}`);
      tally.set(skill, entry);
    }
  }

  const gaps = [...tally.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
    .map(({ skill, jobs, examples }) => ({
      skill,
      jobs,
      share: Math.round((jobs / rows.length) * 100),
      examples,
    }));

  return { ready: true, scanned: rows.length, gaps, generatedAt: nowIso() };
}

export { parseJson };
