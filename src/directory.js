// A shared catalogue of company job boards.
//
// No applicant tracking system publishes a directory. Greenhouse has thousands
// of customers and no endpoint that lists or searches them - measured, not
// assumed: /v1/boards and /v1/jobs both 404, while /v1/boards/stripe/jobs
// returns 200. Lever and Ashby are the same. The only way in is a slug you
// already know, so the reachable universe is bounded by what we can name.
//
// Naming one costs web searches. The slug it yields is then permanent and
// identical for every user, so paying twice for the same name is pure waste.
// This table is what stops that: discovery is paid once by whoever needed it
// first, and every later board in the same category draws on it for nothing.
// The catalogue grows and the marginal cost of a new board falls toward zero.

import Anthropic from '@anthropic-ai/sdk';
import { queryAll, queryOne, run, nowIso } from './db.js';
import { newId } from './crypto.js';
import { fetchSource, validateSlug, ATS_KINDS } from './sources.js';
import { reserveCall } from './budget.js';
import { CATEGORIES, getCategory, inferCategory } from './categories.js';
import { GREENHOUSE_BOARDS } from './greenhouse-directory.js';

/** Names put forward per discovery run. Each one costs a probe, and probes are
 *  subrequests inside an already-tight budget. */
const MAX_CANDIDATES = 14;

/** Searches the model may run while looking for them. The dominant cost. */
const MAX_SEARCHES = 6;

/** Consecutive failures before a catalogue entry stops being offered. A board
 *  that has gone quiet for a while has usually been closed or renamed. */
const FAILED_STREAK_LIMIT = 3;

const CANDIDATE_SCHEMA = {
  type: 'object',
  properties: {
    companies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The employer name' },
          kind: {
            type: 'string',
            description: 'Which system hosts their board: greenhouse, lever, ashby or smartrecruiters',
          },
          identifier: {
            type: 'string',
            description:
              'The board slug exactly as it appears in their careers URL, e.g. the "stripe" in boards.greenhouse.io/stripe',
          },
          evidence: {
            type: 'string',
            description: 'The page you read it from, or empty if you did not verify it',
          },
        },
        required: ['name', 'kind', 'identifier', 'evidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['companies'],
  additionalProperties: false,
};

const SYSTEM = [
  'You find the job-board slugs of employers who hire for a particular kind of work.',
  '',
  'A slug is the identifier in a careers URL: the "stripe" in boards.greenhouse.io/stripe, the',
  '"spotify" in jobs.lever.co/spotify, the "openai" in jobs.ashbyhq.com/openai. It is frequently',
  'not the company name - it can be shortened, hyphenated, or an old trading name - which is why',
  'reading it off a real page beats guessing it from the name.',
  '',
  'Search for employers in the field described, open their careers pages, and read the slug from',
  'the URL you actually land on. Prefer smaller and mid-sized employers: the household names are',
  'already covered, and they are not where this work usually is.',
  '',
  'Published round-ups of companies using a particular platform are fair game and often faster than',
  'going company by company - a list of employers on Greenhouse gets you a dozen names at once. Read',
  'the slug from the careers URL it points at rather than trusting the list to have it right, since',
  'these lists go stale and a wrong slug costs a request and returns nothing.',
  '',
  'Report only slugs you have seen in a URL. Leave evidence empty rather than inventing a source,',
  'and omit the company entirely rather than guessing its slug - every name here is probed against',
  'the live API, so a guess costs a request and returns nothing. A short list of real slugs is more',
  'useful than a long list that mostly fails.',
].join('\n');

/** Companies already in the catalogue for a category, best-yielding first. */
export async function directoryFor(env, category, { limit = 20, exclude = [] } = {}) {
  const rows = await queryAll(
    env,
    `SELECT kind, identifier, name, job_count FROM company_directory
     WHERE category = ? AND failed_streak < ?
     ORDER BY job_count DESC, verified_at DESC
     LIMIT ?`,
    category,
    FAILED_STREAK_LIMIT,
    limit + exclude.length
  );
  const skip = new Set(exclude.map((e) => `${e.kind}:${e.identifier}`.toLowerCase()));
  return rows.filter((row) => !skip.has(`${row.kind}:${row.identifier}`.toLowerCase())).slice(0, limit);
}

/** Record a verified board so nobody pays to find it again. */
export async function remember(env, { kind, identifier, name, category, jobCount }) {
  await run(
    env,
    `INSERT INTO company_directory (id, kind, identifier, name, category, job_count, verified_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (kind, identifier) DO UPDATE SET
       name = excluded.name,
       job_count = excluded.job_count,
       verified_at = excluded.verified_at,
       failed_streak = 0`,
    newId('co_'),
    kind,
    identifier,
    String(name || identifier).slice(0, 120),
    category,
    Math.max(0, Number(jobCount) || 0),
    nowIso(),
    nowIso()
  );
}

/** Note that a catalogued board returned nothing, so it eventually drops out. */
/** Confirm a slug is real by asking its API for jobs. */
async function probe(candidate, selfHost) {
  const kind = String(candidate.kind || '').toLowerCase();
  if (!ATS_KINDS.includes(kind)) return null;

  let slug;
  try {
    slug = validateSlug(candidate.identifier);
  } catch {
    return null;
  }

  try {
    const jobs = await fetchSource({ kind, identifier: slug }, { selfHost });
    // A board that exists but lists nothing is not worth cataloguing: it is
    // either dormant or the slug belongs to something else that happens to
    // resolve.
    if (!jobs.length) return null;
    return { kind, identifier: slug, name: candidate.name || slug, jobCount: jobs.length };
  } catch {
    return null;
  }
}

/**
 * Find new company boards for a category, verify them, and add them to the
 * shared catalogue.
 *
 * Returns what it added. Always resolves - discovery failing should leave the
 * catalogue exactly as it was, not take a board creation down with it.
 */
export async function discoverCompanies(env, { userId, category, prompt, selfHost }) {
  if (!env.ANTHROPIC_API_KEY) return { added: [], searches: 0, reason: 'no-key' };

  const meta = getCategory(category);
  if (!meta || category === 'other') return { added: [], searches: 0, reason: 'no-category' };

  // Charged like any other model work, so discovery cannot quietly outspend
  // the ranking it exists to feed.
  if (!(await reserveCall(env, userId, 0))) {
    return { added: [], searches: 0, reason: 'budget' };
  }

  // Never re-propose what the catalogue already holds - that is the whole
  // point of having one.
  const known = await queryAll(
    env,
    'SELECT kind, identifier FROM company_directory WHERE category = ?',
    category
  );
  const knownList = known.map((row) => `${row.kind}:${row.identifier}`).join(', ');

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  let response;
  try {
    response = await client.beta.messages.create({
      model: env.SCORING_MODEL || 'claude-opus-5',
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: CANDIDATE_SCHEMA },
      },
      tools: [
        { type: 'web_search_20260209', name: 'web_search', max_uses: MAX_SEARCHES },
        { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 4 },
      ],
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            `Field of work: ${meta.label} — ${meta.hint}`,
            prompt ? `What the person is looking for, in their words: ${prompt}` : '',
            knownList ? `Already catalogued, do not repeat these: ${knownList}` : '',
            '',
            `Find up to ${MAX_CANDIDATES} employers in this field and report their board slugs.`,
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    });
  } catch (err) {
    return { added: [], searches: 0, reason: err.message };
  }

  const searches = response.content.filter(
    (block) => block.type === 'server_tool_use' && block.name === 'web_search'
  ).length;

  if (response.stop_reason === 'refusal') return { added: [], searches, reason: 'refused' };
  const text = response.content.find((block) => block.type === 'text');
  if (!text) return { added: [], searches, reason: 'empty' };

  let parsed;
  try {
    parsed = JSON.parse(text.text);
  } catch {
    return { added: [], searches, reason: 'unreadable' };
  }

  // Probed concurrently, but bounded: every probe is a subrequest, and the
  // Worker's allowance is shared with everything else this run needs.
  const candidates = (parsed.companies || []).slice(0, MAX_CANDIDATES);
  const results = await Promise.all(candidates.map((candidate) => probe(candidate, selfHost)));

  const added = [];
  for (const found of results) {
    if (!found) continue;
    await remember(env, { ...found, category });
    added.push(found);
  }

  return { added, searches, checked: candidates.length };
}

/**
 * Put the built-in companies into the catalogue.
 *
 * Cheap and idempotent, so the shared table starts populated rather than empty
 * on a fresh database - the first board should not have to pay for discovery
 * just to reach the companies we already knew about.
 */
export async function seedDirectory(env, seeds) {
  // Insert what is missing, rather than skipping when the table is non-empty.
  //
  // The first version bailed out if the catalogue had any rows at all, so seeds
  // added later never appeared on a database that had already been through it
  // once - which is every deployment after the first. Creative, teaching and
  // support boards found nothing while the entries they needed sat unwritten
  // in the source file.
  const existing = await queryAll(env, 'SELECT kind, identifier FROM company_directory');
  const have = new Set(existing.map((row) => `${row.kind}:${row.identifier}`.toLowerCase()));

  const missing = seeds.filter((seed) => !have.has(`${seed.kind}:${seed.identifier}`.toLowerCase()));
  for (const seed of missing) {
    await remember(env, {
      kind: seed.kind,
      identifier: seed.identifier,
      name: seed.label || seed.identifier,
      // Each seed carries its own field. Assuming software would have put
      // Duolingo and A24 in front of an engineering board and nowhere near the
      // teaching and creative boards they belong to.
      category: seed.category || 'software',
      jobCount: 0,
    });
  }
  return missing.length;
}



/**
 * How many company boards a field should hold before it stops being topped up.
 *
 * The point of a target is that this finishes. Growing the catalogue on a timer
 * with no end would bill for searches forever; growing it to a number means the
 * work is bounded, mostly happens once, and then costs nothing. Fifteen is
 * comfortably more than the twelve a single board connects.
 */
export const CATALOGUE_TARGET = 15;

/** How long before a field is worth searching again. Long, because a field that
 *  came up short is unlikely to be different an hour later. */
export const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Top up the thinnest field that is below target, if any.
 *
 * Called from the cron so the catalogue fills in the background rather than
 * while somebody waits for their board. Discovery used to run only on a
 * shortfall at board creation, which meant the first person to want a field
 * paid for it and waited - and a field nobody had asked for yet stayed empty
 * however obvious it was that it would be needed.
 *
 * Does one field per tick at most. There is no hurry, and a burst of searches
 * is both a worse bill and a worse neighbour.
 */
export async function topUpCatalogue(env, { selfHost } = {}) {
  if (!env.ANTHROPIC_API_KEY) return { skipped: 'no-key' };

  // Never pay to search for boards while unclassified ones are still queued.
  //
  // Discovery costs web searches to find a slug. Classification finds the same
  // thing for the price of a fetch, out of a list that is already on disk. So
  // long as that backlog exists, buying slugs would be spending money on work
  // already done.
  const backlog = await queryOne(
    env,
    "SELECT COUNT(*) AS n FROM company_directory WHERE category = ''"
  );
  if (backlog && backlog.n > 0) return { skipped: 'classification-backlog', backlog: backlog.n };

  const counts = await queryAll(
    env,
    `SELECT category, COUNT(*) AS n FROM company_directory
     WHERE failed_streak < ? GROUP BY category`,
    FAILED_STREAK_LIMIT
  );
  const held = new Map(counts.map((row) => [row.category, row.n]));

  const attempts = await queryAll(env, 'SELECT category, attempted_at FROM discovery_attempts');
  const lastTried = new Map(attempts.map((row) => [row.category, Date.parse(row.attempted_at) || 0]));

  const now = Date.now();
  const candidates = CATEGORIES.filter((category) => category.id !== 'other')
    .map((category) => ({ id: category.id, n: held.get(category.id) || 0 }))
    .filter((entry) => entry.n < CATALOGUE_TARGET)
    .filter((entry) => now - (lastTried.get(entry.id) || 0) > RETRY_AFTER_MS)
    // Thinnest first: the field with nothing in it benefits most.
    .sort((a, b) => a.n - b.n);

  if (candidates.length === 0) return { skipped: 'nothing-below-target' };

  const target = candidates[0];
  const result = await discoverCompanies(env, {
    // Background work is charged to its own budget rather than to whichever
    // user happened to trigger the tick, so one person's daily allowance is
    // never quietly spent filling a shared catalogue.
    userId: 'system:catalogue',
    category: target.id,
    prompt: '',
    selfHost,
  });

  await run(
    env,
    `INSERT INTO discovery_attempts (category, attempted_at, found) VALUES (?, ?, ?)
     ON CONFLICT (category) DO UPDATE SET attempted_at = excluded.attempted_at, found = excluded.found`,
    target.id,
    nowIso(),
    result.added.length
  );

  return { category: target.id, had: target.n, added: result.added.length, searches: result.searches };
}



/** Rows written per tick while loading the bulk Greenhouse list. Local work
 *  against D1, no outbound requests, so this is only about keeping any single
 *  tick short - the whole list lands in two. */
const BULK_INSERT_PER_TICK = 2500;

/**
 * Boards fetched per tick when working out what field they hire for.
 *
 * Sized against the Workers subrequest ceiling, which is a hard cap per
 * invocation rather than a bill: exceed it and the tick fails outright. The
 * paid plan allows a thousand, and the same tick already spends roughly two
 * hundred refreshing and curating boards, so five hundred leaves headroom
 * without leaving throughput on the table.
 *
 * The binding constraint is the five-minute cron, not the tick: two hundred
 * boards took under seven seconds, so the work per tick was never the limit -
 * how many ticks it takes to get through the list is.
 */
const CLASSIFY_PER_TICK = 500;

/** Boards read at once. Unbounded parallelism would open two hundred sockets
 *  in one breath and get us throttled at the other end for no gain. */
const CLASSIFY_CONCURRENCY = 20;

/** What the winning field has to clear before it is believed: at least this
 *  many postings, and this share of the board. A24 was being filed under
 *  marketing on one vote out of seven. */
const VOTE_MIN_COUNT = 2;
const VOTE_MIN_SHARE = 0.15;

/** Bound parameters D1 allows in one statement, minus headroom. Six columns
 *  per row, so sixteen rows fits. */
const BULK_ROWS_PER_STATEMENT = 16;

/**
 * Load the published Greenhouse list into the catalogue, a slice per tick.
 *
 * Greenhouse publishes no directory, so every slug used to cost a web search
 * to discover. A published list supplies thousands at once and removes that
 * spend for this platform entirely - what it cannot supply is which field each
 * employer hires for, which is what classifyBoards works out afterwards.
 *
 * Entries land with no category on purpose. directoryFor matches on an exact
 * category, so an unclassified row is invisible to board creation rather than
 * being offered to every board indiscriminately.
 */
export async function loadGreenhouseList(env) {
  const existing = await queryAll(
    env,
    "SELECT identifier FROM company_directory WHERE kind = 'greenhouse'"
  );
  const have = new Set(existing.map((row) => row.identifier.toLowerCase()));
  const missing = GREENHOUSE_BOARDS.filter((board) => !have.has(board.identifier.toLowerCase()));
  if (!missing.length) return { inserted: 0, remaining: 0 };

  const slice = missing.slice(0, BULK_INSERT_PER_TICK);
  const now = nowIso();
  const statements = [];
  for (let i = 0; i < slice.length; i += BULK_ROWS_PER_STATEMENT) {
    const chunk = slice.slice(i, i + BULK_ROWS_PER_STATEMENT);
    const values = chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
    const params = [];
    for (const board of chunk) {
      params.push(newId('co_'), 'greenhouse', board.identifier, board.name.slice(0, 120), '', now);
    }
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO company_directory
           (id, kind, identifier, name, category, created_at)
         VALUES ${values}`
      ).bind(...params)
    );
  }

  await env.DB.batch(statements);
  return { inserted: slice.length, remaining: missing.length - slice.length };
}

/**
 * Work out what field a catalogued board hires for, from the jobs on it.
 *
 * Deliberately free: the titles a board is already advertising say what it
 * hires for far more reliably than its name does, and reading them costs a
 * fetch rather than a model call. "Acme Corp" tells you nothing; thirty
 * postings for nurses tell you everything.
 *
 * Takes the field with the most postings rather than the first match, since
 * almost every company has some engineering roles and first-match would file
 * the entire catalogue under software.
 */
export async function classifyBoards(env, { selfHost, limit = CLASSIFY_PER_TICK } = {}) {
  const pending = await queryAll(
    env,
    `SELECT kind, identifier FROM company_directory
     WHERE category = '' AND failed_streak < ?
     LIMIT ?`,
    FAILED_STREAK_LIMIT,
    limit
  );
  if (!pending.length) return { classified: 0, retired: 0 };

  const readBoard = async (row) => {
    try {
      const jobs = await fetchSource({ kind: row.kind, identifier: row.identifier }, { selfHost });
      if (!jobs.length) return { row, empty: true };

      const votes = new Map();
      for (const job of jobs) {
        const id = inferCategory(job.title);
        votes.set(id, (votes.get(id) || 0) + 1);
      }
      // 'other' is the fallback inferCategory returns when nothing matched, so
      // it should never win over a field that genuinely did.
      const ranked = [...votes].sort((a, b) => {
        if (a[0] === 'other') return 1;
        if (b[0] === 'other') return -1;
        return b[1] - a[1];
      });
      const [winner, count] = ranked[0];
      // A board whose titles say nothing definite is filed as 'other', which is
      // true, rather than as whatever scraped a single match. Guessing is worse
      // than admitting it: 'other' still gets searched, while a wrong field puts
      // the board in front of the wrong people.
      const confident =
        winner !== 'other' && count >= VOTE_MIN_COUNT && count / jobs.length >= VOTE_MIN_SHARE;
      return { row, category: confident ? winner : 'other', jobCount: jobs.length };
    } catch {
      return { row, empty: true };
    }
  };

  // Bounded fan-out: a fixed number of workers pulling from a shared cursor.
  const results = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CLASSIFY_CONCURRENCY, pending.length) }, async () => {
      while (cursor < pending.length) {
        const row = pending[cursor++];
        results.push(await readBoard(row));
      }
    })
  );

  // One round trip for every update rather than one per board. At two hundred
  // boards a tick the sequential version spent far longer talking to the
  // database than it did reading the boards.
  const now = nowIso();
  const writes = [];
  let classified = 0;
  let retired = 0;
  for (const result of results) {
    if (result.empty) {
      writes.push(
        env.DB.prepare(
          `UPDATE company_directory SET failed_streak = failed_streak + 1
           WHERE kind = ? AND identifier = ?`
        ).bind(result.row.kind, result.row.identifier)
      );
      retired += 1;
      continue;
    }
    writes.push(
      env.DB.prepare(
        `UPDATE company_directory
         SET category = ?, job_count = ?, verified_at = ?, failed_streak = 0
         WHERE kind = ? AND identifier = ?`
      ).bind(result.category, result.jobCount, now, result.row.kind, result.row.identifier)
    );
    classified += 1;
  }
  if (writes.length) await env.DB.batch(writes);

  return { classified, retired };
}

export { CATEGORIES };
