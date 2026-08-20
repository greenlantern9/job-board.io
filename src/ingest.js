// Board refresh: pull every enabled source, filter, persist what is new, and
// score it.

import { fetchSource, hydrateDescriptions, matchesFilters, normalizeCompany, safeExternalUrl, ATS_KINDS } from './sources.js';
import { boardQuery } from './curate.js';
import { heuristicScore } from './rank.js';
import { activeProfile } from './profile.js';
import { checkLinks, LINK_DEAD, LINK_LIVE } from './verify.js';

/**
 * Postings verified per refresh. Fetching sources already spends around thirty
 * subrequests of the fifty a Worker gets on the free plan, so this is what is
 * left to spend on checking - highest-ranked candidates first.
 */
const LINK_CHECK_BUDGET = 12;

/** Extra candidates carried past the slot count so a dead link does not cost a
 *  slot that a live posting could have taken. */
const LINK_CHECK_OVERSHOOT = 5;
import { scoreJobs } from './scoring.js';
import { queryAll, queryOne, run, nowIso, parseJson } from './db.js';
import { newId } from './crypto.js';

/** Jobs older than this are dropped at ingest - they are almost always filled. */
const MAX_AGE_DAYS = 60;

/**
 * Consecutive refreshes a job may be absent from its company board before we
 * call it gone. Two rather than one: feeds hiccup, and briefly hiding a live
 * job is worse than briefly showing a filled one.
 */
const MISSING_STREAK_LIMIT = 2;

/**
 * D1 allows at most 100 bound parameters in a single statement, and exceeding
 * it fails at runtime with "too many SQL variables" rather than at build time.
 * The chunk leaves headroom for the other bindings on the same query.
 */
export const D1_MAX_BOUND_PARAMS = 100;
export const IN_CHUNK = 90;

/** One scheduled refresh a day. See clampRefreshInterval in routes/app.js. */
export const MIN_REFRESH_MINUTES = 1440;

/**
 * A board takes on ten jobs at a time and holds fifty.
 *
 * Dumping several hundred listings on someone is the problem this product
 * exists to solve, so a refresh contributes a shortlist rather than a dump:
 * every candidate is ranked and only the best of them land. The rest are not
 * stored, and the next run re-ranks whatever is available then - which also
 * means a job passed over today can win tomorrow if nothing better turned up.
 */
export const ADD_BATCH_SIZE = 10;
export const MAX_ACTIVE_JOBS = 50;

/**
 * How relevant a posting must be to earn a place on the board.
 *
 * Deliberately just above the ceiling applied to out-of-field postings, so a
 * job from the wrong discipline cannot be admitted no matter how well it scores
 * on recency or salary. A board that stays empty because nothing good was found
 * is more useful than one padded with near-misses the reader has to filter
 * themselves.
 */
export const ADMIT_SCORE_FLOOR = 60;

/**
 * How many postings are given a description before admission is decided.
 *
 * Company boards are now read without descriptions, because downloading every
 * opening's full text was the entire cost of building a board. The shortlist
 * gets them individually instead, at about 10KB each.
 *
 * Comfortably more than the ten slots: descriptions change the ranking, so the
 * shortlist has to be wide enough that the eventual top ten is drawn from
 * postings that were all judged on the same evidence.
 */
export const HYDRATE_LIMIT = 40;

/**
 * How many active jobs one employer may hold on a board.
 *
 * A board is meant to show what is out there, and a single employer with a
 * large careers page can otherwise take every slot: a programme-management
 * board came back with its whole first page from one defence contractor, all
 * of them genuine matches and all of them the same employer.
 *
 * Applied against what the board already holds, not just the current batch, so
 * one employer cannot accumulate across refreshes. Relaxed rather than enforced
 * when nothing else clears the bar - an empty slot helps nobody, and variety is
 * a preference where relevance is a requirement.
 */
export const PER_EMPLOYER_LIMIT = 3;

/**
 * The share of a board one employer may hold once the backfill has run.
 *
 * The fair pass alone could not hold the line: a programme-management search
 * found qualifying roles at only two employers, so filling ten slots meant
 * nine from one of them however the first pass was ordered. An unbounded
 * backfill is therefore no cap at all.
 *
 * A board that shows six good jobs from a market with two employers in it is
 * telling the truth about that market. Ten, nine of them from one company, is
 * not - it reads as a broken board, which is how this was reported.
 */
export const PER_EMPLOYER_CEILING = 0.5;

/**
 * Statuses that do not consume a slot.
 *
 * Rejecting or archiving is the user saying "not this one", and that decision
 * should free the space rather than permanently spend it - otherwise triaging a
 * board would gradually fill it with things already dismissed.
 */
const INACTIVE_STATUSES = ['rejected', 'archived', 'delisted'];

/**
 * Jobs currently occupying a slot.
 *
 * A delisted job is no longer applicable to, so it does not hold a slot either
 * - it stays visible as a record of what happened, but it should not stop a
 * live opening taking its place.
 */
export async function activeJobCount(env, boardId) {
  const row = await queryOne(
    env,
    `SELECT COUNT(*) AS n FROM jobs WHERE board_id = ? AND status NOT IN ('rejected', 'archived', 'delisted')`,
    boardId
  );
  return (row && row.n) || 0;
}

/** How many active jobs the board already holds from each employer. */
async function activeByCompany(env, boardId) {
  const rows = await queryAll(
    env,
    `SELECT LOWER(TRIM(company)) AS company, COUNT(*) AS n FROM jobs
     WHERE board_id = ? AND status NOT IN ('rejected', 'archived', 'delisted')
     GROUP BY LOWER(TRIM(company))`,
    boardId
  );
  return new Map(rows.map((row) => [row.company, row.n]));
}

function isTooOld(job) {
  if (!job.postedAt) return false;
  const age = (Date.now() - new Date(job.postedAt).getTime()) / 86400000;
  return Number.isFinite(age) && age > MAX_AGE_DAYS;
}

/**
 * How many sources are read at once.
 *
 * Chosen against the Worker's subrequest ceiling rather than for raw speed:
 * concurrency does not change how many requests are made, only how long they
 * take in total, but a large fan-out makes a slow source harder to attribute
 * and gives third parties a burst they did not ask for. Eight collapses the
 * wait without any of that.
 */
/**
 * How many sources are read at once.
 *
 * Measured on a board with 27 sources: fetching took 8.2 seconds of an 8.5
 * second refresh, while filtering and ranking all 11,753 postings it returned
 * took 290ms. The work was never the bottleneck - the queue was, at four waves
 * of eight.
 *
 * A typical board has 27 sources, so this is one wave rather than two and the
 * refresh is bounded by its slowest source instead of by the queue behind it.
 * Not raised further: most of those sources are Greenhouse boards, so a wave
 * lands on one host, and the background classifier is reading that same host on
 * the same tick.
 */
const FETCH_CONCURRENCY = 24;

/**
 * Read every source concurrently, returning results in the original order.
 *
 * Never rejects: a source that fails comes back carrying its error, because one
 * dead company page must not stop the rest of the board from updating - the
 * same guarantee the sequential version made.
 */
async function fetchAllSources(sources, options) {
  const results = new Array(sources.length);
  let next = 0;

  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= sources.length) return;
      const source = sources[index];
      try {
        results[index] = { source, jobs: await fetchSource(source, options) };
      } catch (error) {
        results[index] = { source, jobs: [], error };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, sources.length) }, worker)
  );
  return results;
}

export function boardWithFilters(row) {
  return { ...row, filters: parseJson(row.filters, {}) };
}

/**
 * Filters plus the board's derived search string, so every source is held to
 * the same relevance bar. Without this, per-company boards bypass the query
 * entirely and dump their whole listing set onto the board.
 */
function filtersWithQuery(board) {
  return { ...(board.filters || {}), query: boardQuery(board) };
}

/**
 * Refreshes one board. Never throws: a failing source is recorded against that
 * source row and the others still run, because one dead company page should
 * not stop the whole board from updating.
 */
export async function refreshBoard(env, boardRow, { selfHost, batchSize = ADD_BATCH_SIZE } = {}) {
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
    duplicates: 0,
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

  const activeFilters = filtersWithQuery(board);
  const toInsert = [];
  const toUpdate = [];
  const seen = new Set();
  const seenIdentities = new Set();
  // Sources that both succeeded and list their entire set of openings. Only
  // these can tell us that a job is gone by not mentioning it.
  const reapable = [];

  // Fetching runs concurrently; processing stays in source order.
  //
  // Twenty-six sources fetched one after another meant a board creation took
  // longer than the client was willing to wait for it, so a board that was
  // working perfectly well looked stuck until the user refreshed by hand. The
  // work was never the problem - the waiting in series was.
  //
  // Order still matters after the fetch: the first source to report a job wins
  // it, so results are walked in the original source order regardless of which
  // network call happened to return first. Same corpus, same winner, same
  // ranking - only the waiting is different.
  const fetchStarted = Date.now();
  const fetched = await fetchAllSources(sources, {
    selfHost,
    category: activeFilters.category,
  });
  summary.fetchMs = Date.now() - fetchStarted;
  const processStarted = Date.now();

  // Counted here and reported once, below, rather than one line per source.
  // A refresh reads dozens of them, and a reader handed a list of internal
  // slugs and stack-adjacent text cannot do anything with it - the detail that
  // matters for debugging is kept on the source row either way.
  let transientFailures = 0;

  const catalogueFailures = [];

  for (const { source, jobs, error } of fetched) {
    if (error) {
      summary.sourcesFailed++;
      if (error.transient) transientFailures++;
      // Tell the shared catalogue, not just this board.
      //
      // Pruning happens during curation, which revisits a board weekly, so a
      // board that cannot be read in time went on costing every refresh for
      // days - and every new board in that field picked it up again, because
      // nothing had recorded that it was unreadable. One employer's listing
      // takes 28 seconds to return three and a half megabytes of titles; it is
      // not worth a wave of the fetch queue on anybody's board.
      if (error.transient && ATS_KINDS.includes(source.kind)) {
        catalogueFailures.push({ kind: source.kind, identifier: source.identifier });
      }
      await run(
        env,
        `UPDATE sources SET last_status = 'error', last_error = ?, last_fetched = ? WHERE id = ?`,
        String(error.message).slice(0, 300),
        nowIso(),
        source.id
      );
      continue;
    }

    summary.sourcesRun++;
    if (ATS_KINDS.includes(source.kind)) reapable.push(source);

    let kept = 0;
    for (const job of jobs) {
      summary.fetched++;
      // A job can legitimately appear in two sources; first one wins.
      if (seen.has(job.externalId)) continue;
      seen.add(job.externalId);

      // The same opening genuinely appears on several aggregators, and some
      // feeds repeat it under different ids of their own. Identity is the role
      // at the employer, not whatever key the source happened to mint.
      // Normalise the link the moment it enters the system, so a javascript:
      // or private-network URL from a feed is neutralised once rather than at
      // every place that later reads it.
      job.url = safeExternalUrl(job.url, { selfHost });

      const identity = `${job.title.trim().toLowerCase().replace(/\s+/g, ' ')}|${normalizeCompany(job.company)}`;
      if (seenIdentities.has(identity)) {
        summary.duplicates++;
        continue;
      }
      seenIdentities.add(identity);

      if (isTooOld(job) || !matchesFilters(job, activeFilters)) {
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

  // Establish that each posting still exists before it reaches the board.
  //
  // For a company board this is already settled and costs nothing: the job was
  // in that employer's current listing seconds ago, which is a stronger
  // guarantee than any link check could give. Fetching the page would in fact
  // be *worse* - Ashby serves its single-page shell with a 200 for any job id
  // at all, so a deleted posting looks perfectly healthy.
  //
  // Aggregator entries are the ones that need checking, since they can outlive
  // the posting they describe. Even then the check is honest about its limits:
  // their links point at the aggregator's own page, so a 200 proves the
  // aggregator still lists it, not that the employer is still hiring. Those
  // stay "unknown" rather than claiming more than we know.
  // Rank every candidate and keep only the best that fit the free slots.
  //
  // This is what makes a refresh a shortlist rather than a dump. Candidates
  // that miss the cut are simply not stored - the next run re-ranks whatever is
  // available then, so today's near-miss can win tomorrow if nothing better
  // turns up. A few extra are carried through link checking so that a dead one
  // does not cost a slot.
  if (catalogueFailures.length > 0) {
    await env.DB.batch(
      catalogueFailures.map((entry) =>
        env.DB.prepare(
          `UPDATE company_directory SET failed_streak = failed_streak + 1
           WHERE kind = ? AND identifier = ?`
        ).bind(entry.kind, entry.identifier)
      )
    );
  }

  if (transientFailures > 0) {
    summary.warnings.push(
      transientFailures === 1
        ? 'One source was slow to respond and was skipped this time.'
        : `${transientFailures} sources were slow to respond and were skipped this time.`
    );
  }

  summary.processMs = Date.now() - processStarted;

  const activeBefore = await activeJobCount(env, board.id);
  const slots = Math.max(0, Math.min(batchSize, MAX_ACTIVE_JOBS - activeBefore));
  summary.activeBefore = activeBefore;
  summary.slots = slots;
  summary.candidates = toInsert.length;

  if (slots === 0 && toInsert.length > 0) {
    summary.boardFull = true;
    summary.warnings.push(
      `This board is holding its maximum of ${MAX_ACTIVE_JOBS} jobs. Reject or archive some to make room.`
    );
    toInsert.length = 0;
  } else if (toInsert.length > 0) {
    // Relevance decides admission, not just ordering.
    //
    // Passing the filters used to be enough to get onto the board, so weak
    // matches were added and then shown with a low score - leaving the reader
    // to do the sorting the board exists to do. Ranking every candidate first
    // and refusing the ones below the bar means a board holds jobs worth
    // looking at, and an empty board honestly reports that nothing good was
    // found rather than padding itself.
    //
    // The bar sits just above the out-of-field ceiling, so a posting from the
    // wrong discipline can never be admitted however well it scores otherwise.
    const ranked = toInsert
      .map((entry) => {
        const scored = heuristicScore(entry.job, { prompt: board.prompt, filters: activeFilters });
        return { entry, score: scored.score, reason: scored.reason };
      })
      .sort((a, b) => b.score - a.score);

    // Descriptions arrive here, for the shortlist only.
    //
    // Ranking above ran on titles, which is what decides the shortlist. The
    // text then settles the order within it, and can still disqualify a posting
    // outright - an exclusion term the user set may only appear in the body,
    // and it has to be honoured wherever it appears.
    // Taken as a spread across employers, not as the top forty.
    //
    // An exact title match scores 100, and a search like "technical program
    // manager" returns dozens of them. Sorting leaves those ties in fetch
    // order, so the first employers read filled the shortlist and every other
    // employer's identical roles never entered it - the employer cap then had
    // nothing else to choose, and a board that could have drawn on eight
    // employers showed two. Rounds of one-each keep the shortlist as wide as
    // the corpus is before quality is judged within it.
    const byEmployer = new Map();
    for (const item of ranked) {
      const key = String(item.entry.job.company || '').trim().toLowerCase();
      if (!byEmployer.has(key)) byEmployer.set(key, []);
      byEmployer.get(key).push(item);
    }
    const queues = [...byEmployer.values()];
    const shortlist = [];
    for (let round = 0; shortlist.length < HYDRATE_LIMIT; round += 1) {
      let placed = 0;
      for (const queue of queues) {
        if (shortlist.length >= HYDRATE_LIMIT) break;
        if (round < queue.length) {
          shortlist.push(queue[round]);
          placed += 1;
        }
      }
      if (placed === 0) break;
    }
    shortlist.sort((a, b) => b.score - a.score);
    summary.hydrated = await hydrateDescriptions(shortlist.map(({ entry }) => entry.job));

    const rescored = shortlist
      .filter(({ entry }) => matchesFilters(entry.job, activeFilters))
      .map(({ entry }) => {
        const scored = heuristicScore(entry.job, { prompt: board.prompt, filters: activeFilters });
        return { entry, score: scored.score, reason: scored.reason };
      })
      .sort((a, b) => b.score - a.score);

    const relevant = rescored.filter(({ score }) => score >= ADMIT_SCORE_FLOOR);
    summary.belowBar = rescored.length - relevant.length;
    summary.passedOver = Math.max(0, relevant.length - slots);

    // Overshoot deliberately: link checking drops some, and trimming to exactly
    // `slots` afterwards means a dead posting does not silently cost a slot.
    const want = slots + LINK_CHECK_OVERSHOOT;
    const held = await activeByCompany(env, board.id);
    const employer = (entry) => String(entry.job.company || '').trim().toLowerCase();

    const chosen = [];
    const taken = new Set();
    for (const item of relevant) {
      if (chosen.length >= want) break;
      const key = employer(item.entry);
      // An employer with no name cannot be spread against, so it is not capped.
      if (key && (held.get(key) || 0) >= PER_EMPLOYER_LIMIT) continue;
      chosen.push(item);
      taken.add(item);
      if (key) held.set(key, (held.get(key) || 0) + 1);
    }

    // Fill what is left, but never past the ceiling. Leaving a slot empty is
    // the lesser harm: the jobs excluded here are still findable by refreshing
    // once the board has room, and a board dominated by one employer hides the
    // market rather than showing it.
    if (chosen.length < want) {
      // Measured against the board it is building, not against one batch.
      //
      // Taking half of "slots" meant half of ten however big the board already
      // was, so an employer that had filled a new board's first batch was at
      // its ceiling permanently: a later refresh found seven more jobs that
      // cleared the bar and admitted none of them, and the board stayed at five
      // for good. Half of what the board will hold once this batch lands keeps
      // the original guarantee on a new board - five of ten - while letting an
      // established one keep growing.
      const capacity = activeBefore + slots;
      const ceiling = Math.max(PER_EMPLOYER_LIMIT, Math.ceil(capacity * PER_EMPLOYER_CEILING));
      for (const item of relevant) {
        if (chosen.length >= want) break;
        if (taken.has(item)) continue;
        const key = employer(item.entry);
        if (key && (held.get(key) || 0) >= ceiling) continue;
        chosen.push(item);
        if (key) held.set(key, (held.get(key) || 0) + 1);
      }
    }
    summary.employersHeld = new Set(chosen.map((item) => employer(item.entry)).filter(Boolean)).size;

    toInsert.length = 0;
    // The score that decided admission is written with the row.
    //
    // The insert used to omit it, leaving every new job at the column default
    // of zero until a separate pass filled it in. That pass is the expensive
    // one, so any refresh that ran out of time - or hit its budget, or failed
    // its model call - left a board of real jobs all showing zero, which reads
    // as broken scoring rather than as scoring that has not happened yet.
    for (const { entry, score, reason } of chosen) {
      entry.heuristic = { score, reason };
    }
    toInsert.push(...chosen.map(({ entry }) => entry));
  }

  if (toInsert.length > 0) {
    for (const entry of toInsert) {
      if (entry.job.direct) entry.linkStatus = LINK_LIVE;
    }

    const needChecking = toInsert
      .filter((entry) => !entry.job.direct && entry.job.url)
      .sort(
        (a, b) =>
          heuristicScore(b.job, { prompt: board.prompt, filters: activeFilters }).score -
          heuristicScore(a.job, { prompt: board.prompt, filters: activeFilters }).score
      );

    if (needChecking.length > 0) {
      const statuses = await checkLinks(
        needChecking.map((entry) => entry.job.url),
        { budget: LINK_CHECK_BUDGET, selfHost }
      );
      for (const entry of needChecking) {
        const status = statuses.get(entry.job.url);
        if (status) entry.linkStatus = status;
      }
    }

    const before = toInsert.length;
    const alive = toInsert.filter((entry) => entry.linkStatus !== LINK_DEAD);
    summary.deadOnArrival = before - alive.length;
    toInsert.length = 0;
    // Trim to the slot count only now, after the dead have been removed.
    toInsert.push(...alive.slice(0, slots));
  }

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
      toInsert.map(({ id, sourceId, job, linkStatus, heuristic }) =>
        env.DB.prepare(
          `INSERT INTO jobs (id, board_id, user_id, source_id, external_id, title, company, location,
             remote, employment, salary_min, salary_max, salary_raw, url, description, posted_at,
             discovered_at, updated_at, link_direct, link_status, link_checked_at,
             score, score_reason, scored_by, scored_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          now,
          job.direct ? 1 : 0,
          linkStatus || '',
          linkStatus ? now : '',
          (heuristic && heuristic.score) || 0,
          (heuristic && heuristic.reason) || '',
          'heuristic',
          now
        )
      )
    );
    summary.added = toInsert.length;
  }

  Object.assign(summary, await reapClosedJobs(env, board, { reapable, seen, now }));

  // Spend when there is something worth ranking - not merely when something
  // arrived.
  //
  // The rule started as "only if this run added jobs", after a refresh that
  // matched nothing was billed for ranking leftovers and showed the user
  // nothing for it. But that also blocked the case where a key has since become
  // reachable and the board is still carrying heuristic scores from when it was
  // not: the board would stay permanently worse with no way back except a
  // manual rescore.
  //
  // So: rank when new jobs arrived, or when there is anything left that the
  // model has never seen. Both change what the user is looking at, which is the
  // test that matters. A run that changes nothing still spends nothing, and any
  // spend is reported in the summary rather than discovered on a bill.
  const pending = await queryOne(
    env,
    env.ANTHROPIC_API_KEY
      ? `SELECT COUNT(*) AS n FROM jobs WHERE board_id = ? AND status <> 'archived'
           AND (scored_at = '' OR scored_by = 'heuristic')`
      : `SELECT COUNT(*) AS n FROM jobs WHERE board_id = ? AND scored_at = ''`,
    board.id
  );
  const worthRanking = (pending && pending.n) || 0;

  if (summary.added > 0 || worthRanking > 0) {
    const scoring = await scoreUnscored(env, board);
    summary.warnings.push(...scoring.warnings);
    summary.scored = scoring.scored;
    summary.modelCalls = scoring.modelCalls || 0;
  } else {
    summary.scored = 0;
    summary.modelCalls = 0;
  }

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
 * Retire jobs their employer has stopped listing.
 *
 * A company board returns *every* opening it has, so a job that was there last
 * time and is not there now has been filled or pulled. That inference only
 * holds for the per-company connectors: aggregators return a rolling window of
 * recent postings, so a job falling out of one means nothing at all and reaping
 * on their say-so would delete half the board.
 *
 * Done by presumption and rebuttal rather than a giant NOT IN: bump every job
 * belonging to a source that just ran, then clear the ones actually seen. That
 * also means a job which still exists but no longer passes the board's filters
 * keeps its streak reset, instead of being mistaken for a closed one.
 */
async function reapClosedJobs(env, board, { reapable, seen, now }) {
  const result = { closed: 0, reopened: 0 };
  if (reapable.length === 0) return result;

  await env.DB.batch(
    reapable.map((source) =>
      env.DB.prepare(
        'UPDATE jobs SET missing_streak = missing_streak + 1 WHERE board_id = ? AND source_id = ?'
      ).bind(board.id, source.id)
    )
  );

  // Chunked so the bound-parameter list stays within D1's limits.
  const seenIds = [...seen];
  for (let i = 0; i < seenIds.length; i += IN_CHUNK) {
    const chunk = seenIds.slice(i, i + IN_CHUNK);
    await env.DB.prepare(
      `UPDATE jobs SET missing_streak = 0, closed_at = ''
       WHERE board_id = ? AND external_id IN (${chunk.map(() => '?').join(',')})`
    )
      .bind(board.id, ...chunk)
      .run();
  }

  const closed = await run(
    env,
    `UPDATE jobs SET closed_at = ?, updated_at = ?
     WHERE board_id = ? AND closed_at = '' AND missing_streak >= ?`,
    now,
    now,
    board.id,
    MISSING_STREAK_LIMIT
  );
  result.closed = (closed.meta && closed.meta.changes) || 0;

  // Move untouched jobs to "No longer listed" rather than archiving them out of
  // sight. Knowing a role you were considering has gone is useful information;
  // silently hiding it just makes the board look like it lost something.
  //
  // Anything the user acted on keeps its status - a job you applied to is still
  // a job you applied to, and overwriting that would destroy your own record of
  // the pipeline. Those are marked by closed_at instead, which drives the same
  // red row.
  await run(
    env,
    `UPDATE jobs SET status = 'delisted', updated_at = ?
     WHERE board_id = ? AND closed_at <> '' AND status IN ('new', 'saved')`,
    now,
    board.id
  );

  return result;
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
  // Jobs ranked while no API key was reachable keep a heuristic score forever,
  // because nothing re-scores a job that already has one. That is how a board
  // built during an outage stays permanently worse than the one built after it
  // - the fix arrived and the existing rows never felt it.
  //
  // So when a key is present, previously heuristic-scored jobs are eligible
  // again, after the never-scored ones. Ordering matters: new arrivals are
  // ranked first, and the upgrade uses whatever batch and budget capacity is
  // left over rather than competing for it.
  const upgradeStale = Boolean(env.ANTHROPIC_API_KEY) && !force;

  const rows = await queryAll(
    env,
    force
      ? `SELECT * FROM jobs WHERE board_id = ? AND status <> 'archived' ORDER BY discovered_at DESC LIMIT ?`
      : upgradeStale
        ? `SELECT * FROM jobs WHERE board_id = ? AND status <> 'archived'
             AND (scored_at = '' OR scored_by = 'heuristic')
           ORDER BY (scored_at <> '') ASC, score DESC, discovered_at DESC LIMIT ?`
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

  // Null unless the user has a profile and has switched it on, so ranking with
  // no profile behaves exactly as it did before profiles existed.
  const profile = await activeProfile(env, board.user_id);
  const { results, warnings, usedModel } = await scoreJobs(env, jobs, board, { profile });
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

  return { scored: results.size, warnings, modelCalls: usedModel ? 1 : 0 };
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
