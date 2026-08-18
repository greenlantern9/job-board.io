// A hard ceiling on model spend.
//
// Everything else in this codebase degrades gracefully when the model is
// unavailable, which means an overspend has no user-visible symptom until the
// bill arrives. So the limit is enforced rather than advised: once a day's
// allowance is used the heuristic takes over, exactly as it does when no key is
// configured at all, and the board keeps working.

import { queryOne, run, nowIso } from './db.js';

/**
 * Model calls one account may make in a day.
 *
 * A refresh needs one call for its ten new jobs, a rescore needs up to four,
 * and discovery needs one. Thirty leaves room for three boards refreshing,
 * several manual pulls and some rescoring, and still caps the day at a few tens
 * of cents.
 */
export const DAILY_CALL_LIMIT = 30;

/**
 * Heuristic score a job must reach before it is worth asking the model about.
 *
 * Most of a large ingestion is obviously irrelevant - the heuristic already
 * knows a warehouse role does not match a photography search. Spending tokens
 * to confirm that is the easiest waste to remove, and it costs nothing in
 * quality because those jobs were never going to be read.
 */
export const MODEL_SCORE_FLOOR = 35;

const today = () => nowIso().slice(0, 10);

/** Calls used today, and whether there is room for more. */
export async function budgetStatus(env, userId) {
  const row = await queryOne(
    env,
    'SELECT calls, jobs_scored FROM model_usage WHERE user_id = ? AND day = ?',
    userId,
    today()
  );
  const used = (row && row.calls) || 0;
  return {
    used,
    limit: DAILY_CALL_LIMIT,
    remaining: Math.max(0, DAILY_CALL_LIMIT - used),
    jobsScored: (row && row.jobs_scored) || 0,
    exhausted: used >= DAILY_CALL_LIMIT,
  };
}

/**
 * Reserve one call before making it.
 *
 * Incrementing first means a crash mid-call costs the allowance rather than
 * escaping it - the failure that matters here is undercounting, since that is
 * the one that spends money.
 */
export async function reserveCall(env, userId, jobs = 0) {
  const status = await budgetStatus(env, userId);
  if (status.exhausted) return false;

  await run(
    env,
    `INSERT INTO model_usage (user_id, day, calls, jobs_scored, updated_at)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT (user_id, day) DO UPDATE SET
       calls = calls + 1,
       jobs_scored = jobs_scored + excluded.jobs_scored,
       updated_at = excluded.updated_at`,
    userId,
    today(),
    jobs,
    nowIso()
  );
  return true;
}
