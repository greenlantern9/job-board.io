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

/**
 * Published per-million-token rates for the models this app calls.
 *
 * Kept here rather than stored per row so that a price change corrects every
 * historical figure at once. The trade-off is that old rows are re-priced at
 * today's rates - acceptable because this exists to answer "what is this
 * costing me", not to reproduce a past invoice.
 */
const RATES = {
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
};

const DEFAULT_RATE = RATES['claude-opus-5'];

/** Dollar cost of a token count, at the given model's published rate. */
export function estimateCost({ inputTokens = 0, outputTokens = 0, cacheReadTokens = 0 }, model) {
  const rate = RATES[model] || DEFAULT_RATE;
  return (
    (inputTokens / 1e6) * rate.input +
    (outputTokens / 1e6) * rate.output +
    (cacheReadTokens / 1e6) * rate.cacheRead
  );
}

/**
 * Record what a call actually consumed, after it has returned.
 *
 * Separate from reserveCall because the two know different things at different
 * times: the reservation has to happen before the request, so that a crash
 * mid-call still costs the allowance, but the token counts only exist once the
 * response is in hand. A call that throws is therefore counted but not costed,
 * which errs toward over-reporting the allowance and under-reporting spend -
 * the right way round for a budget.
 */
export async function recordUsage(env, userId, usage) {
  if (!usage) return;
  const input = Number(usage.input_tokens || 0);
  const output = Number(usage.output_tokens || 0);
  const cached = Number(usage.cache_read_input_tokens || 0);
  if (!input && !output && !cached) return;

  await run(
    env,
    `INSERT INTO model_usage (user_id, day, calls, jobs_scored, input_tokens, output_tokens, cache_read_tokens, updated_at)
     VALUES (?, ?, 0, 0, ?, ?, ?, ?)
     ON CONFLICT (user_id, day) DO UPDATE SET
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
       updated_at = excluded.updated_at`,
    userId,
    today(),
    input,
    output,
    cached,
    nowIso()
  );
}

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
