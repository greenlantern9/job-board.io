// Boards, sources, jobs, and notification rules.
//
// Ids travel in the request body rather than the path, so the router stays a
// flat lookup with no pattern matching. Every handler re-checks user_id - an
// id from the client is a claim, not proof of ownership.

import { json, badRequest, notFound, readJson, tooMany, allowRate } from '../http.js';
import { queryAll, queryOne, run, nowIso, parseJson } from '../db.js';
import { newId } from '../crypto.js';
import { SOURCE_KINDS, validateSlug, validateFeedUrl, fetchSource, SourceError } from '../sources.js';
import {
  refreshBoard,
  scoreUnscored,
  boardWithFilters,
  activeJobCount,
  MIN_REFRESH_MINUTES,
  ADD_BATCH_SIZE,
  MAX_ACTIVE_JOBS,
} from '../ingest.js';
import { suggestCompanies } from '../suggest.js';
import { curateBoard } from '../curate.js';
import { applyIntent } from '../intent.js';
import { inferCategory, isCategory } from '../categories.js';
import { getProfile, saveProfile, parseCvHeuristically, activeProfile } from '../profile.js';
import { quietApplications, skillGapReport, FOLLOWUP_AFTER_DAYS } from '../insights.js';
import { recordStatusChange, jobHistory, applicationHistory } from '../history.js';
import { scoutLeads, scoutAndStore, saveLeads, listLeads } from '../scout.js';
import { parseCvWithModel } from '../scoring.js';
import Anthropic from '@anthropic-ai/sdk';
import { listNotifications, ruleToPublic, TRIGGER_KINDS } from '../notify.js';

export const JOB_STATUSES = [
  'new',
  'saved',
  'applied',
  'interview',
  'offer',
  'rejected',
  // Set by the refresh when the employer stops listing the role. Not something
  // a user picks, but valid to store and to filter on.
  'delisted',
  'archived',
];

// --- shared helpers --------------------------------------------------------

async function ownedBoard(env, userId, boardId) {
  if (!boardId) return null;
  return queryOne(env, 'SELECT * FROM boards WHERE id = ? AND user_id = ?', boardId, userId);
}

function cleanFilters(input, prompt = '') {
  const raw = input && typeof input === 'object' ? input : {};
  const text = (value, max = 400) => String(value ?? '').slice(0, max).trim();
  const filters = {
    keywords: text(raw.keywords),
    exclude: text(raw.exclude),
    locations: text(raw.locations),
    remoteOnly: Boolean(raw.remoteOnly),
    minSalary: Math.max(0, Math.min(10_000_000, Number(raw.minSalary) || 0)),
    // Curated company list. "prioritize" boosts them in the ranking;
    // "limit" makes the list an allowlist and drops everything else.
    companies: text(raw.companies, 2000),
    companyMode: raw.companyMode === 'limit' ? 'limit' : 'prioritize',
  };
  const seniority = Number(raw.seniority);
  if (Number.isInteger(seniority) && seniority >= 0 && seniority <= 5) {
    filters.seniority = seniority;
  }
  const minSeniority = Number(raw.minSeniority);
  if (Number.isInteger(minSeniority) && minSeniority >= 0 && minSeniority <= 5) {
    filters.minSeniority = minSeniority;
  }
  const maxAgeDays = Number(raw.maxAgeDays);
  if (Number.isInteger(maxAgeDays) && maxAgeDays > 0 && maxAgeDays <= 365) {
    filters.maxAgeDays = maxAgeDays;
  }

  // One explicit category, inferred rather than demanded. It routes the
  // source taxonomies and the field check from a single value instead of four
  // independent regex guesses over the same sentence, and the user can correct
  // it in one click when the guess is wrong.
  filters.category = isCategory(raw.category) ? String(raw.category) : inferCategory(prompt);

  // Fill the gaps from the sentence. Someone who wrote "$250k" should get a
  // salary floor without having to find the field under Advanced - that number
  // was doing nothing at all before.
  return applyIntent(filters, prompt).filters;
}

/**
 * Scheduled refreshes are capped at one a day.
 *
 * Each refresh can spend up to four model batches on scoring, so the interval
 * is the main lever on what this costs to run. Hourly bought very little -
 * postings do not appear that fast - and multiplied the bill by 24. Manual
 * refresh is still there for when someone actually wants it now.
 */
const MAX_REFRESH_MINUTES = 10080; // a week

/**
 * Hard ceiling on boards per account.
 *
 * Boards are the unit that multiplies cost: each one refreshes on its own
 * schedule and each refresh can spend up to four model batches. Three is also
 * about as many distinct searches as anyone actually works at once.
 */
export const MAX_BOARDS = 3;

function clampRefreshInterval(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return MIN_REFRESH_MINUTES;
  return Math.max(MIN_REFRESH_MINUTES, Math.min(MAX_REFRESH_MINUTES, Math.round(minutes)));
}

function boardToPublic(row) {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    filters: parseJson(row.filters, {}),
    refreshMode: row.refresh_mode,
    refreshEvery: row.refresh_every,
    lastRefresh: row.last_refresh,
    lastError: row.last_error,
    lastCurated: row.last_curated || '',
    curateNote: row.curate_note || '',
    createdAt: row.created_at,
  };
}

function jobToPublic(row) {
  return {
    id: row.id,
    boardId: row.board_id,
    title: row.title,
    company: row.company,
    location: row.location,
    remote: Boolean(row.remote),
    employment: row.employment,
    salaryMin: row.salary_min,
    salaryMax: row.salary_max,
    salaryRaw: row.salary_raw,
    url: row.url,
    description: row.description,
    postedAt: row.posted_at,
    discoveredAt: row.discovered_at,
    score: row.score,
    scoreReason: row.score_reason,
    scoredBy: row.scored_by,
    status: row.status,
    position: row.position,
    notes: row.notes,
    appliedAt: row.applied_at,
    closedAt: row.closed_at || '',
    linkDirect: Boolean(row.link_direct),
    linkStatus: row.link_status || '',
    linkCheckedAt: row.link_checked_at || '',
    updatedAt: row.updated_at,
  };
}

// --- boards ----------------------------------------------------------------

async function listBoards(request, env, ctx) {
  const rows = await queryAll(
    env,
    'SELECT * FROM boards WHERE user_id = ? ORDER BY created_at ASC',
    ctx.user.id
  );
  // One extra round trip beats N+1: pull all counts in a single grouped query.
  const counts = await queryAll(
    env,
    `SELECT board_id, status, COUNT(*) AS n FROM jobs WHERE user_id = ? GROUP BY board_id, status`,
    ctx.user.id
  );
  const byBoard = {};
  for (const row of counts) {
    byBoard[row.board_id] = byBoard[row.board_id] || {};
    byBoard[row.board_id][row.status] = row.n;
  }
  return json({
    boards: rows.map((row) => {
      const counts = byBoard[row.id] || {};
      // Must match activeJobCount exactly, or the capacity shown disagrees with
      // the capacity enforced - which is how you get a board reading 30 of 50
      // while the server thinks there is room for eleven more.
      const active = Object.entries(counts)
        .filter(([status]) => !['rejected', 'archived', 'delisted'].includes(status))
        .reduce((sum, [, n]) => sum + n, 0);
      return { ...boardToPublic(row), counts, active, maxActive: MAX_ACTIVE_JOBS };
    }),
    addBatchSize: ADD_BATCH_SIZE,
    maxActive: MAX_ACTIVE_JOBS,
    // Sent so the client can disable "New board" at the limit rather than
    // letting someone fill in a form that is going to be rejected.
    maxBoards: MAX_BOARDS,
  });
}

/**
 * "Add 10 jobs" - pull the next batch on demand.
 *
 * Deliberately not limited to once a day. The daily refresh is the rhythm, but
 * someone working through a board should not have to wait until tomorrow for
 * more; the real limits are the fifty-job ceiling and the rate limiter, both of
 * which bound this without making it feel arbitrary.
 */
async function addJobs(request, env, ctx) {
  const body = await readJson(request);
  const board = await ownedBoard(env, ctx.user.id, body.id);
  if (!board) return notFound('Board not found.');

  const active = await activeJobCount(env, board.id);
  if (active >= MAX_ACTIVE_JOBS) {
    return json({
      ok: false,
      boardFull: true,
      active,
      max: MAX_ACTIVE_JOBS,
      message: `This board is holding its maximum of ${MAX_ACTIVE_JOBS} jobs. Reject or archive a few to make room.`,
    });
  }

  if (!(await allowRate(env.API_RATE_LIMIT, `addjobs:${ctx.user.id}`))) {
    return tooMany('Give it a minute between batches.');
  }

  const summary = await refreshBoard(env, board, { selfHost: new URL(request.url).hostname });
  return json({
    ok: true,
    ...summary,
    active: await activeJobCount(env, board.id),
    max: MAX_ACTIVE_JOBS,
  });
}

// --- insights --------------------------------------------------------------

/** Quiet applications and recurring skill gaps, both from data already stored. */
async function insights(request, env, ctx) {
  // Ten days is the default, but "quiet" means different things in different
  // markets and at different stages, so the threshold is adjustable.
  const requested = Number(new URL(request.url).searchParams.get('afterDays'));
  const afterDays = Number.isFinite(requested) && requested >= 0 && requested <= 180
    ? requested
    : FOLLOWUP_AFTER_DAYS;

  const profile = await activeProfile(env, ctx.user.id);
  const [followUps, skillGaps] = await Promise.all([
    quietApplications(env, ctx.user.id, { afterDays }),
    skillGapReport(env, ctx.user.id, profile),
  ]);
  return json({ followUps, skillGaps, followUpAfterDays: afterDays });
}

async function markFollowedUp(request, env, ctx) {
  const body = await readJson(request);
  const result = await run(
    env,
    'UPDATE jobs SET followed_up_at = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    nowIso(),
    nowIso(),
    String(body.id || ''),
    ctx.user.id
  );
  if (!(result.meta && result.meta.changes)) return notFound('Job not found.');
  return json({ ok: true });
}

// --- candidate profile (optional) ------------------------------------------

async function readProfile(request, env, ctx) {
  const profile = await getProfile(env, ctx.user.id);
  return json({
    profile,
    // The client needs to know the model is available before offering to parse
    // a CV with it, rather than offering and then failing.
    canParseWithModel: Boolean(env.ANTHROPIC_API_KEY),
  });
}

async function writeProfile(request, env, ctx) {
  const body = await readJson(request);
  const profile = await saveProfile(env, ctx.user.id, body);
  return json({ ok: true, profile });
}

/**
 * Turn pasted CV text into structured fields.
 *
 * The heuristic pass always runs, so this works with no API key at all - just
 * less well. Nothing is saved here; the extracted fields go back to the client
 * for review first, because a profile quietly populated with things you did not
 * write would be worse than an empty one.
 */
async function parseProfile(request, env, ctx) {
  const body = await readJson(request);
  const text = String(body.text || '').slice(0, 20000);
  if (text.trim().length < 40) {
    return badRequest('Paste a bit more of your CV — a few lines is not enough to read.');
  }
  if (!(await allowRate(env.API_RATE_LIMIT, `parsecv:${ctx.user.id}`))) {
    return tooMany('Give it a minute between parses.');
  }

  const heuristic = parseCvHeuristically(text);
  if (!env.ANTHROPIC_API_KEY) {
    return json({ ok: true, parsedBy: 'heuristic', profile: heuristic });
  }

  try {
    const parsed = await parseCvWithModel(env, text);
    return json({ ok: true, parsedBy: env.SCORING_MODEL || 'claude-opus-5', profile: { ...heuristic, ...parsed } });
  } catch (err) {
    // Falling back is better than failing: the heuristic result is still usable.
    return json({
      ok: true,
      parsedBy: 'heuristic',
      profile: heuristic,
      warning: `Could not read it with the model, so this is the basic pass: ${err.message}`,
    });
  }
}

/** Re-run source discovery on demand, from the board's Sources panel. */
/**
 * Research the open web for work no job board carries.
 *
 * Separate from the board's job list on purpose: these are organisations to
 * approach, not postings to apply to, and conflating the two would misrepresent
 * both. Nothing is stored - a scout run is a piece of research the user reads
 * and acts on, and persisting stale leads would be worse than re-running it.
 */
async function scoutBoard(request, env, ctx) {
  const body = await readJson(request);
  const board = await queryOne(
    env,
    'SELECT * FROM boards WHERE id = ? AND user_id = ?',
    String(body.id || ''),
    ctx.user.id
  );
  if (!board) return notFound('Board not found.');

  if (!(await allowRate(env.API_RATE_LIMIT, `scout:${ctx.user.id}`))) {
    return tooMany('Give it a minute between searches.');
  }

  const filters = parseJson(board.filters, {});
  const result = await scoutLeads(env, {
    userId: ctx.user.id,
    prompt: board.prompt,
    location: filters.locations || '',
    profile: await activeProfile(env, ctx.user.id),
  });

  if (result.leads.length > 0) {
    await saveLeads(env, { boardId: board.id, userId: ctx.user.id, leads: result.leads });
  }
  return json({ ...result, leads: await listLeads(env, board.id, ctx.user.id) });
}

/** Leads already found for a board, without spending anything to look again. */
async function readLeads(request, env, ctx) {
  const id = new URL(request.url).searchParams.get('boardId') || '';
  return json({ leads: await listLeads(env, id, ctx.user.id) });
}

async function updateLead(request, env, ctx) {
  const body = await readJson(request);
  const status = ['new', 'contacted', 'replied', 'dismissed'].includes(body.status)
    ? body.status
    : 'new';
  const result = await run(
    env,
    'UPDATE leads SET status = ?, notes = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    status,
    String(body.notes || '').slice(0, 2000),
    nowIso(),
    String(body.id || ''),
    ctx.user.id
  );
  if (!(result.meta && result.meta.changes)) return notFound('Lead not found.');
  return json({ ok: true });
}

async function curateNow(request, env, ctx) {
  const body = await readJson(request);
  const row = await ownedBoard(env, ctx.user.id, body.id);
  if (!row) return notFound('Board not found.');
  if (!(await allowRate(env.API_RATE_LIMIT, `curate:${ctx.user.id}`))) {
    return tooMany('Give it a minute between source checks.');
  }

  const selfHost = new URL(request.url).hostname;
  const summary = await curateBoard(env, boardWithFilters(row), { selfHost, force: true });
  // Pull immediately so newly connected sources show results straight away.
  if (summary.added > 0) {
    const fresh = await queryOne(env, 'SELECT * FROM boards WHERE id = ?', row.id);
    if (fresh) await refreshBoard(env, fresh, { selfHost });
  }
  return json({ ok: true, ...summary });
}

async function createBoard(request, env, ctx) {
  const body = await readJson(request);
  const name = String(body.name || '').trim().slice(0, 80);
  if (!name) return badRequest('Give the board a name.');

  const count = await queryOne(
    env,
    'SELECT COUNT(*) AS n FROM boards WHERE user_id = ?',
    ctx.user.id
  );
  if ((count && count.n) >= MAX_BOARDS) {
    return badRequest(
      `You can have ${MAX_BOARDS} boards for now. Delete one to make room, or widen an existing board's criteria.`
    );
  }

  const id = newId('brd_');
  const now = nowIso();
  await run(
    env,
    `INSERT INTO boards (id, user_id, name, prompt, filters, refresh_mode, refresh_every, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    ctx.user.id,
    name,
    String(body.prompt || '').slice(0, 4000),
    JSON.stringify(cleanFilters(body.filters, String(body.prompt || ''))),
    body.refreshMode === 'manual' ? 'manual' : 'schedule',
    clampRefreshInterval(body.refreshEvery),
    now,
    now
  );

  const created = await queryOne(env, 'SELECT * FROM boards WHERE id = ?', id);

  // Connecting sources is not the user's job. Discovery and the first pull run
  // in the background so the board is useful by the time they look at it,
  // rather than presenting an empty screen and a setup task.
  // Scouting the open web is opt-out rather than opt-in, because for whole
  // categories of work - photography, events, coaching, trades - the job boards
  // hold nothing and the leads are the entire product. It costs real money, so
  // the form says so and the flag is honoured here rather than assumed.
  const alsoScout = body.scout !== false;

  ctx.waitUntil(
    (async () => {
      const selfHost = new URL(request.url).hostname;
      await curateBoard(env, boardWithFilters(created), { selfHost });
      const fresh = await queryOne(env, 'SELECT * FROM boards WHERE id = ?', id);
      if (fresh) await refreshBoard(env, fresh, { selfHost });

      // After the refresh, not before: if the boards happen to carry this work
      // the user sees it sooner, and the scout is the expensive half.
      if (alsoScout) {
        await scoutAndStore(env, {
          boardId: id,
          userId: ctx.user.id,
          prompt: created.prompt,
          location: parseJson(created.filters, {}).locations || '',
          profile: await activeProfile(env, ctx.user.id),
        });
      }
    })().catch((err) => console.error('board bootstrap failed', err && err.stack))
  );

  return json({ ok: true, board: boardToPublic(created), provisioning: true });
}

async function updateBoard(request, env, ctx) {
  const body = await readJson(request);
  const board = await ownedBoard(env, ctx.user.id, body.id);
  if (!board) return notFound('Board not found.');

  const name = String(body.name ?? board.name).trim().slice(0, 80);
  if (!name) return badRequest('Give the board a name.');

  await run(
    env,
    `UPDATE boards SET name = ?, prompt = ?, filters = ?, refresh_mode = ?, refresh_every = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
    name,
    String(body.prompt ?? board.prompt).slice(0, 4000),
    JSON.stringify(
      cleanFilters(body.filters ?? parseJson(board.filters, {}), String(body.prompt ?? board.prompt ?? ''))
    ),
    body.refreshMode === 'manual' ? 'manual' : 'schedule',
    clampRefreshInterval(body.refreshEvery ?? board.refresh_every),
    nowIso(),
    board.id,
    ctx.user.id
  );
  return json({
    ok: true,
    board: boardToPublic(await queryOne(env, 'SELECT * FROM boards WHERE id = ?', board.id)),
  });
}

async function deleteBoard(request, env, ctx) {
  const body = await readJson(request);
  const board = await ownedBoard(env, ctx.user.id, body.id);
  if (!board) return notFound('Board not found.');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM jobs WHERE board_id = ? AND user_id = ?').bind(board.id, ctx.user.id),
    env.DB.prepare('DELETE FROM sources WHERE board_id = ? AND user_id = ?').bind(board.id, ctx.user.id),
    env.DB.prepare('DELETE FROM notification_rules WHERE board_id = ? AND user_id = ?').bind(board.id, ctx.user.id),
    env.DB.prepare('DELETE FROM boards WHERE id = ? AND user_id = ?').bind(board.id, ctx.user.id),
  ]);
  return json({ ok: true });
}

async function refreshNow(request, env, ctx) {
  const body = await readJson(request);
  const board = await ownedBoard(env, ctx.user.id, body.id);
  if (!board) return notFound('Board not found.');
  // Refreshing hits third-party APIs and possibly the model, so it gets a
  // tighter budget than ordinary reads.
  if (!(await allowRate(env.API_RATE_LIMIT, `refresh:${ctx.user.id}`))) {
    return tooMany('Give it a minute between manual refreshes.');
  }
  const selfHost = new URL(request.url).hostname;
  const summary = await refreshBoard(env, board, { selfHost });
  return json({ ok: true, summary });
}

async function rescoreBoard(request, env, ctx) {
  const body = await readJson(request);
  const row = await ownedBoard(env, ctx.user.id, body.id);
  if (!row) return notFound('Board not found.');
  if (!(await allowRate(env.API_RATE_LIMIT, `rescore:${ctx.user.id}`))) {
    return tooMany('Give it a minute between rescores.');
  }
  const result = await scoreUnscored(env, boardWithFilters(row), { force: true, limit: 60 });
  return json({ ok: true, ...result });
}

// --- sources ---------------------------------------------------------------

function normalizeIdentifier(kind, identifier, selfHost) {
  if (kind === 'rss') return validateFeedUrl(identifier, { selfHost });
  return validateSlug(identifier);
}

async function listSources(request, env, ctx) {
  const url = new URL(request.url);
  const boardId = url.searchParams.get('boardId') || '';
  const board = await ownedBoard(env, ctx.user.id, boardId);
  if (!board) return notFound('Board not found.');
  const rows = await queryAll(
    env,
    'SELECT * FROM sources WHERE board_id = ? ORDER BY created_at ASC',
    board.id
  );
  return json({
    sources: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      identifier: row.identifier,
      label: row.label,
      enabled: Boolean(row.enabled),
      auto: Boolean(row.auto),
      lastStatus: row.last_status,
      lastError: row.last_error,
      lastFetched: row.last_fetched,
      foundCount: row.found_count,
    })),
    board: { lastCurated: board.last_curated || '', curateNote: board.curate_note || '' },
  });
}

async function createSource(request, env, ctx) {
  const body = await readJson(request);
  const board = await ownedBoard(env, ctx.user.id, body.boardId);
  if (!board) return notFound('Board not found.');
  if (!SOURCE_KINDS.includes(body.kind)) return badRequest('Pick a valid source type.');

  const count = await queryOne(env, 'SELECT COUNT(*) AS n FROM sources WHERE board_id = ?', board.id);
  if ((count && count.n) >= 40) return badRequest('This board already has 40 sources.');

  let identifier;
  try {
    identifier = normalizeIdentifier(body.kind, body.identifier, new URL(request.url).hostname);
  } catch (err) {
    return badRequest(err instanceof SourceError ? err.message : 'That source is not valid.');
  }

  const duplicate = await queryOne(
    env,
    'SELECT id FROM sources WHERE board_id = ? AND kind = ? AND identifier = ?',
    board.id,
    body.kind,
    identifier
  );
  if (duplicate) return badRequest('That source is already on this board.');

  const id = newId('src_');
  await run(
    env,
    `INSERT INTO sources (id, board_id, user_id, kind, identifier, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    board.id,
    ctx.user.id,
    body.kind,
    identifier,
    String(body.label || '').slice(0, 80),
    nowIso()
  );
  return json({ ok: true, id });
}

/** Dry run: fetch without persisting, so a typo surfaces before it becomes a
 *  silently-empty source on the board. */
async function testSource(request, env, ctx) {
  const body = await readJson(request);
  if (!SOURCE_KINDS.includes(body.kind)) return badRequest('Pick a valid source type.');
  if (!(await allowRate(env.API_RATE_LIMIT, `test:${ctx.user.id}`))) return tooMany();

  try {
    const identifier = normalizeIdentifier(body.kind, body.identifier, new URL(request.url).hostname);
    const jobs = await fetchSource({ kind: body.kind, identifier }, { selfHost: new URL(request.url).hostname });
    return json({
      ok: true,
      count: jobs.length,
      sample: jobs.slice(0, 3).map((job) => ({
        title: job.title,
        location: job.location,
        remote: job.remote,
      })),
    });
  } catch (err) {
    return json({ ok: false, error: err.message || 'Could not read that source.' }, { status: 200 });
  }
}

/**
 * Suggest companies resembling the ones already on the board. Every suggestion
 * is verified against a live ATS board before it is returned, so each one can
 * be added with a single click.
 */
async function suggestSources(request, env, ctx) {
  const body = await readJson(request);
  const row = await ownedBoard(env, ctx.user.id, body.boardId);
  if (!row) return notFound('Board not found.');
  // This one costs a model call plus up to 24 outbound probes.
  if (!(await allowRate(env.API_RATE_LIMIT, `suggest:${ctx.user.id}`))) {
    return tooMany('Give it a minute between suggestion runs.');
  }

  const board = boardWithFilters(row);
  const sources = await queryAll(env, 'SELECT identifier, label FROM sources WHERE board_id = ?', board.id);
  const known = [
    ...sources.map((s) => s.label || s.identifier),
    ...String(board.filters.companies || '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean),
  ];

  try {
    const result = await suggestCompanies(env, board, {
      known,
      selfHost: new URL(request.url).hostname,
    });
    return json({ ok: true, ...result });
  } catch (err) {
    if (err.code === 'no_api_key') return json({ ok: false, error: err.message }, { status: 200 });
    return json({ ok: false, error: err.message || 'Could not suggest companies.' }, { status: 200 });
  }
}

/**
 * Answer "is the model actually reachable" with the real reason when it is not.
 *
 * The failure modes are indistinguishable from the outside: a missing secret, a
 * secret saved under the wrong name, a valid key with no credit on the account,
 * and a revoked key all end up as "ranking fell back to the heuristic". This
 * makes one small call and reports what came back.
 */
/**
 * What the Worker can actually see, by name only.
 *
 * "The secret exists in the dashboard" and "the Worker can read it" kept
 * disagreeing, and there was no way to tell which was wrong from the outside.
 * Listing the binding names settles it in one look: a typo, a key on the wrong
 * Worker, and a key that was deleted all look completely different here.
 *
 * Names only, never values, and behind an authenticated session.
 */
function visibleBindings(env) {
  const expected = [
    'ANTHROPIC_API_KEY',
    'TOTP_ENC_KEY',
    'PASSWORD_PEPPER',
    'SESSION_PEPPER',
    'RESEND_API_KEY',
  ];
  const present = {};
  for (const name of expected) present[name] = Boolean(env[name]);

  // Anything that looks like it was *meant* to be one of the above. This is
  // what catches ANTHROPIC_KEY, a trailing space, or the wrong case.
  const near = Object.keys(env).filter(
    (name) => !expected.includes(name) && /anthropic|api.?key|secret|token|pepper/i.test(name)
  );

  return {
    present,
    near,
    // Which Worker this actually ran on, so it can be compared against the one
    // being edited in the dashboard.
    worker: env.WORKER_NAME || '(unknown - redeploy to populate)',
    allNames: Object.keys(env).sort(),
  };
}

async function aiCheck(request, env, ctx) {
  const model = env.SCORING_MODEL || 'claude-opus-5';
  const bindings = visibleBindings(env);

  if (!env.ANTHROPIC_API_KEY) {
    const hint = bindings.near.length
      ? ` This Worker does have ${bindings.near.join(', ')} — if one of those was meant to be the key, the name does not match.`
      : ' This Worker has no binding with a similar name, so the value is either on a different Worker or was not saved.';
    return json({
      ok: false,
      state: 'missing',
      model,
      bindings,
      message: `No ANTHROPIC_API_KEY is visible to this Worker.${hint}`,
    });
  }

  if (!(await allowRate(env.API_RATE_LIMIT, `aicheck:${ctx.user.id}`))) {
    return tooMany('Give it a minute between checks.');
  }

  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
    });
    const text = response.content.find((block) => block.type === 'text');
    return json({
      ok: true,
      state: 'ready',
      model,
      bindings,
      message: `Connected. ${model} replied "${((text && text.text) || '').trim().slice(0, 30)}".`,
    });
  } catch (err) {
    const raw = String((err && err.message) || err);
    // Translate the two that actually happen into something actionable.
    let message = raw.slice(0, 300);
    if (/credit balance|insufficient/i.test(raw)) {
      message = 'The key works, but the Anthropic account has no credit. Add credits in the Console under Settings, Billing.';
    } else if (/authentication|invalid.*api.*key|401/i.test(raw)) {
      message = 'That key was rejected. It may have been revoked, or copied incompletely - a valid one starts with sk-ant-.';
    } else if (/model/i.test(raw) && /not.*found|does not exist/i.test(raw)) {
      message = `The account cannot reach "${model}". Set SCORING_MODEL in wrangler.jsonc to a model it can use.`;
    }
    return json({ ok: false, state: 'error', model, message });
  }
}

async function updateSource(request, env, ctx) {
  const body = await readJson(request);
  const source = await queryOne(
    env,
    'SELECT * FROM sources WHERE id = ? AND user_id = ?',
    body.id,
    ctx.user.id
  );
  if (!source) return notFound('Source not found.');
  await run(
    env,
    'UPDATE sources SET enabled = ?, label = ? WHERE id = ? AND user_id = ?',
    body.enabled === false ? 0 : 1,
    String(body.label ?? source.label).slice(0, 80),
    source.id,
    ctx.user.id
  );
  return json({ ok: true });
}

async function deleteSource(request, env, ctx) {
  const body = await readJson(request);
  const result = await run(
    env,
    'DELETE FROM sources WHERE id = ? AND user_id = ?',
    String(body.id || ''),
    ctx.user.id
  );
  if (!(result.meta && result.meta.changes)) return notFound('Source not found.');
  return json({ ok: true });
}

// --- jobs ------------------------------------------------------------------

async function listJobs(request, env, ctx) {
  const url = new URL(request.url);
  const board = await ownedBoard(env, ctx.user.id, url.searchParams.get('boardId'));
  if (!board) return notFound('Board not found.');

  const params = [board.id, ctx.user.id];
  let sql = 'SELECT * FROM jobs WHERE board_id = ? AND user_id = ?';

  const status = url.searchParams.get('status');
  if (status && JOB_STATUSES.includes(status)) {
    sql += ' AND status = ?';
    params.push(status);
  } else if (!url.searchParams.get('includeArchived')) {
    sql += " AND status <> 'archived'";
  }

  // Delisted jobs stay on the board. Knowing a role has gone is information
  // worth having, and hiding it makes the board look like it lost something.

  const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
  if (q) {
    sql += ' AND (LOWER(title) LIKE ? OR LOWER(company) LIKE ? OR LOWER(location) LIKE ?)';
    const like = `%${q.toLowerCase()}%`;
    params.push(like, like, like);
  }

  const minScore = Number(url.searchParams.get('minScore'));
  if (Number.isFinite(minScore) && minScore > 0) {
    sql += ' AND score >= ?';
    params.push(minScore);
  }

  // "Posted within N days". Undated postings are kept: a lot of feeds omit the
  // field, and excluding them would silently hide real jobs rather than old
  // ones. They sort last under "newest first" for the same reason.
  const maxAgeDays = Number(url.searchParams.get('maxAgeDays'));
  if (Number.isFinite(maxAgeDays) && maxAgeDays > 0) {
    sql += " AND (posted_at = '' OR posted_at >= ?)";
    params.push(new Date(Date.now() - maxAgeDays * 86400000).toISOString());
  }

  sql +=
    url.searchParams.get('sort') === 'newest'
      ? " ORDER BY (posted_at = '') ASC, posted_at DESC, score DESC LIMIT 400"
      : ' ORDER BY score DESC, discovered_at DESC LIMIT 400';

  const rows = await queryAll(env, sql, ...params);
  return json({ jobs: rows.map(jobToPublic), board: boardToPublic(board) });
}

/**
 * Poll endpoint for the live view. Returns only what changed since `since`,
 * so the client can patch its state instead of refetching the board.
 */
async function jobChanges(request, env, ctx) {
  const url = new URL(request.url);
  const board = await ownedBoard(env, ctx.user.id, url.searchParams.get('boardId'));
  if (!board) return notFound('Board not found.');

  const since = String(url.searchParams.get('since') || '').slice(0, 40);
  const rows = since
    ? await queryAll(
        env,
        `SELECT * FROM jobs WHERE board_id = ? AND user_id = ? AND updated_at > ?
         ORDER BY updated_at DESC LIMIT 200`,
        board.id,
        ctx.user.id,
        since
      )
    : [];

  return json({
    now: nowIso(),
    lastRefresh: board.last_refresh,
    lastError: board.last_error,
    changed: rows.map(jobToPublic),
  });
}

async function updateJob(request, env, ctx) {
  const body = await readJson(request);
  const job = await queryOne(
    env,
    'SELECT * FROM jobs WHERE id = ? AND user_id = ?',
    String(body.id || ''),
    ctx.user.id
  );
  if (!job) return notFound('Job not found.');

  const status = JOB_STATUSES.includes(body.status) ? body.status : job.status;
  // Stamp the moment it first moves to applied, and clear it if moved back -
  // the list view reports "applied N days ago" from this.
  let appliedAt = job.applied_at;
  if (status === 'applied' && job.status !== 'applied' && !appliedAt) appliedAt = nowIso();
  if (status === 'new' || status === 'saved') appliedAt = '';

  const now = nowIso();
  const statusMoved = status !== job.status;

  await run(
    env,
    `UPDATE jobs SET status = ?, notes = ?, position = ?, applied_at = ?, updated_at = ?,
       status_changed_at = ?, followed_up_at = ?
     WHERE id = ? AND user_id = ?`,
    status,
    String(body.notes ?? job.notes).slice(0, 4000),
    Number.isFinite(Number(body.position)) ? Number(body.position) : job.position,
    appliedAt,
    now,
    // Only a real move resets the silence clock. Editing notes on an
    // application that has gone quiet should not make it look fresh again.
    statusMoved ? now : job.status_changed_at || '',
    // Moving forward means they replied, so any follow-up flag is spent.
    statusMoved ? '' : job.followed_up_at || '',
    job.id,
    ctx.user.id
  );
  // Archive the transition. Done after the update so the event cannot claim a
  // move that failed to save, and never allowed to fail the request - losing a
  // history row is regrettable, losing the status change is not acceptable.
  if (statusMoved) {
    try {
      await recordStatusChange(env, {
        job,
        fromStatus: job.status,
        toStatus: status,
        note: body.eventNote,
        profile: await activeProfile(env, ctx.user.id),
      });
    } catch (err) {
      console.error('history write failed', job.id, err && err.message);
    }
  }

  return json({
    ok: true,
    job: jobToPublic(await queryOne(env, 'SELECT * FROM jobs WHERE id = ?', job.id)),
  });
}

async function jobHistoryRoute(request, env, ctx) {
  const id = new URL(request.url).searchParams.get('id') || '';
  return json({ history: await jobHistory(env, ctx.user.id, id) });
}

/** Everything applied to, read from the archive rather than the jobs table so
 *  it survives postings being delisted and boards being deleted. */
async function applicationsRoute(request, env, ctx) {
  return json({ applications: await applicationHistory(env, ctx.user.id) });
}

async function bulkUpdateJobs(request, env, ctx) {
  const body = await readJson(request);
  const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string').slice(0, 200) : [];
  if (ids.length === 0) return badRequest('No jobs selected.');
  if (!JOB_STATUSES.includes(body.status)) return badRequest('Pick a valid status.');

  const now = nowIso();
  const appliedAt = body.status === 'applied' ? now : '';
  await env.DB.batch(
    ids.map((id) =>
      env.DB.prepare(
        `UPDATE jobs SET status = ?, updated_at = ?,
           applied_at = CASE WHEN ? <> '' AND applied_at = '' THEN ? ELSE applied_at END
         WHERE id = ? AND user_id = ?`
      ).bind(body.status, now, appliedAt, appliedAt, id, ctx.user.id)
    )
  );
  return json({ ok: true, updated: ids.length });
}

// --- notification rules ----------------------------------------------------

async function listRules(request, env, ctx) {
  const rows = await queryAll(
    env,
    'SELECT * FROM notification_rules WHERE user_id = ? ORDER BY created_at ASC',
    ctx.user.id
  );
  return json({ rules: rows.map(ruleToPublic), emailVerified: Boolean(ctx.user.email_verified) });
}

function ruleFields(body, existing = {}) {
  return {
    trigger: TRIGGER_KINDS.includes(body.trigger) ? body.trigger : existing.trigger_kind || 'instant',
    minScore: Math.max(0, Math.min(100, Number(body.minScore ?? existing.min_score ?? 70))),
    keywords: String(body.keywords ?? existing.keywords ?? '').slice(0, 400),
    sendHour: Math.max(0, Math.min(23, Number(body.sendHour ?? existing.send_hour ?? 8))),
    enabled: body.enabled === undefined ? existing.enabled !== 0 : Boolean(body.enabled),
  };
}

async function createRule(request, env, ctx) {
  const body = await readJson(request);
  if (body.boardId) {
    const board = await ownedBoard(env, ctx.user.id, body.boardId);
    if (!board) return notFound('Board not found.');
  }
  const count = await queryOne(
    env,
    'SELECT COUNT(*) AS n FROM notification_rules WHERE user_id = ?',
    ctx.user.id
  );
  if ((count && count.n) >= 20) return badRequest('You have reached the limit of 20 alerts.');

  const fields = ruleFields(body);
  const id = newId('rul_');
  await run(
    env,
    `INSERT INTO notification_rules (id, user_id, board_id, channel, trigger_kind, min_score, keywords, send_hour, enabled, created_at)
     VALUES (?, ?, ?, 'email', ?, ?, ?, ?, ?, ?)`,
    id,
    ctx.user.id,
    String(body.boardId || ''),
    fields.trigger,
    fields.minScore,
    fields.keywords,
    fields.sendHour,
    fields.enabled ? 1 : 0,
    nowIso()
  );
  return json({ ok: true, id });
}

async function updateRule(request, env, ctx) {
  const body = await readJson(request);
  const rule = await queryOne(
    env,
    'SELECT * FROM notification_rules WHERE id = ? AND user_id = ?',
    String(body.id || ''),
    ctx.user.id
  );
  if (!rule) return notFound('Alert not found.');

  const fields = ruleFields(body, rule);
  await run(
    env,
    `UPDATE notification_rules SET trigger_kind = ?, min_score = ?, keywords = ?, send_hour = ?, enabled = ?
     WHERE id = ? AND user_id = ?`,
    fields.trigger,
    fields.minScore,
    fields.keywords,
    fields.sendHour,
    fields.enabled ? 1 : 0,
    rule.id,
    ctx.user.id
  );
  return json({ ok: true });
}

async function deleteRule(request, env, ctx) {
  const body = await readJson(request);
  const result = await run(
    env,
    'DELETE FROM notification_rules WHERE id = ? AND user_id = ?',
    String(body.id || ''),
    ctx.user.id
  );
  if (!(result.meta && result.meta.changes)) return notFound('Alert not found.');
  return json({ ok: true });
}

async function notificationHistory(request, env, ctx) {
  return json({ notifications: await listNotifications(env, ctx.user.id) });
}

export const APP_ROUTES = {
  'GET /api/boards': { handler: listBoards },
  'POST /api/boards/create': { handler: createBoard },
  'POST /api/boards/update': { handler: updateBoard },
  'POST /api/boards/delete': { handler: deleteBoard },
  'POST /api/boards/refresh': { handler: refreshNow },
  'POST /api/boards/rescore': { handler: rescoreBoard },
  'POST /api/boards/curate': { handler: curateNow },
  'POST /api/boards/scout': { handler: scoutBoard },
  'GET /api/leads': { handler: readLeads },
  'POST /api/leads/update': { handler: updateLead },
  'POST /api/boards/add-jobs': { handler: addJobs },

  'GET /api/sources': { handler: listSources },
  'POST /api/sources/create': { handler: createSource },
  'POST /api/sources/update': { handler: updateSource },
  'POST /api/sources/delete': { handler: deleteSource },
  'POST /api/sources/test': { handler: testSource },
  'POST /api/sources/suggest': { handler: suggestSources },
  'POST /api/account/ai-check': { handler: aiCheck },

  'GET /api/jobs': { handler: listJobs },
  'GET /api/jobs/changes': { handler: jobChanges },
  'POST /api/jobs/update': { handler: updateJob },
  'POST /api/jobs/bulk': { handler: bulkUpdateJobs },

  'GET /api/rules': { handler: listRules },
  'POST /api/rules/create': { handler: createRule },
  'POST /api/rules/update': { handler: updateRule },
  'POST /api/rules/delete': { handler: deleteRule },
  'GET /api/notifications': { handler: notificationHistory },

  'GET /api/insights': { handler: insights },
  'GET /api/jobs/history': { handler: jobHistoryRoute },
  'GET /api/applications': { handler: applicationsRoute },
  'POST /api/jobs/followed-up': { handler: markFollowedUp },

  'GET /api/profile': { handler: readProfile },
  'POST /api/profile': { handler: writeProfile },
  'POST /api/profile/parse': { handler: parseProfile },
};
