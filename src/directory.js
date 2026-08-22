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
import { reserveCall, recordUsage } from './budget.js';
import { CATEGORIES, getCategory, inferCategory } from './categories.js';
import { GREENHOUSE_BOARDS } from './greenhouse-directory.js';
import { ATS_BOARDS } from './ats-directory.js';
import { expandTerm } from './synonyms.js';
import { ATS_BOARDS_2 } from './ats-directory-2.js';
import { WORKDAY_BOARDS } from './workday-directory.js';

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
            description:
              'Which system hosts their board: greenhouse, lever, ashby, smartrecruiters, recruitee, workable, personio, breezy, gem, loxo, bamboohr, rippling, zohorecruit, jobvite, workday or taleo',
          },
          identifier: {
            type: 'string',
            description:
              'The board slug exactly as it appears in their careers URL, e.g. the "stripe" in boards.greenhouse.io/stripe. Workday boards are tenant.cluster.site from {tenant}.{cluster}.myworkdayjobs.com/{site}, e.g. intel.wd1.External; taleo boards are zone.portalId.section.',
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
/**
 * Share of a board's company sources that come from outside its own field.
 *
 * Fields route sources so that a coaching search is not served engineering
 * boards, which is right for the postings but wrong for the employers: plenty
 * of roles live inside an industry that is not their own discipline. Measured
 * on live boards, eight product-classified employers carried 249 postings and
 * eight technical-programme roles between them, while seven software-classified
 * employers carried 1,242 postings and thirty-seven - so a programme-management
 * search routed purely to product was looking in the smaller half.
 *
 * Reserving part of the list for the largest employers regardless of field
 * costs nothing in precision. Out-of-field postings are capped below the
 * admission floor, so the extra breadth can only add jobs that genuinely match
 * - it cannot pad the board with the wrong discipline.
 */
const CROSS_FIELD_SHARE = 0.4;

/** How many employers are considered before the best are chosen. Wide, because
 *  the ordering that matters is on a column the database cannot rank by. */
const POOL_SIZE = 400;

export async function directoryFor(env, category, { limit = 20, exclude = [], terms = [] } = {}) {
  const skip = new Set(exclude.map((e) => `${e.kind}:${e.identifier}`.toLowerCase()));
  const picked = [];
  const seen = new Set();

  const add = (rows, max) => {
    for (const row of rows) {
      if (picked.length >= limit || max <= 0) break;
      const key = `${row.kind}:${row.identifier}`.toLowerCase();
      if (skip.has(key) || seen.has(key)) continue;
      seen.add(key);
      picked.push(row);
      max -= 1;
    }
  };

  const crossField = Math.max(1, Math.round(limit * CROSS_FIELD_SHARE));
  const inField = limit - crossField;

  // Ranked by what the employer advertises, not merely by how much of it.
  //
  // Size was the only signal here, and size does not say whether a company is
  // hiring for the role somebody searched for. The pool is drawn wide and then
  // ordered by how many of the searched-for words appear in the titles that
  // employer actually posts, which classification recorded while reading them.
  // Each searched word carries its family: "aerospace" alone matches almost
  // no employer's titles, but avionics, propulsion and spacecraft - the words
  // aerospace employers actually put in titles - stand in for it. A hit is
  // any family member present, counted once per word the user searched.
  const wanted = terms
    .map((term) => String(term || '').toLowerCase().trim())
    .filter((term) => term.length >= 3)
    .map((term) => expandTerm(term));

  const rank = (rows) => {
    if (wanted.length === 0) return rows;
    return rows
      .map((row) => {
        // Whole words. A substring test let "tech" match "technical" and
        // "technology" at every employer in the catalogue, which scored them
        // all alike and left size deciding again.
        const vocabulary = new Set(String(row.title_terms || '').split(' '));
        const hits = wanted.filter((family) => family.some((term) => vocabulary.has(term))).length;
        return { row, hits };
      })
      // Relevance, then reliability, then size. A board that keeps timing out
      // is offered last rather than not at all - it is slow, not gone, and
      // excluding it was removing the largest employers from every search.
      .sort(
        (a, b) =>
          b.hits - a.hits ||
          (a.row.timeout_streak || 0) - (b.row.timeout_streak || 0) ||
          b.row.job_count - a.row.job_count
      )
      .map(({ row }) => row);
  };

  // Both pools are read before anything is chosen from either.
  //
  // The cross-field query used to run after the in-field share had already been
  // handed out, which meant a relevance pass could not see it - and referring to
  // it early threw, leaving boards with no company sources at all.
  const [own, largestRanked] = await Promise.all([
    queryAll(
      env,
      `SELECT kind, identifier, name, job_count, title_terms, timeout_streak FROM company_directory
       WHERE category = ? AND failed_streak < ?
       ORDER BY job_count DESC, verified_at DESC
       LIMIT ?`,
      category,
      FAILED_STREAK_LIMIT,
      POOL_SIZE
    ).then(rank),
    queryAll(
      env,
      `SELECT kind, identifier, name, job_count, title_terms, timeout_streak FROM company_directory
       WHERE category <> '' AND failed_streak < ?
       ORDER BY job_count DESC, verified_at DESC
       LIMIT ?`,
      FAILED_STREAK_LIMIT,
      POOL_SIZE
    ).then(rank),
  ]);

  // Employers that advertise the words searched for come first, from either
  // pool.
  //
  // The in-field share used to be handed out before relevance was considered at
  // all, so an employer filed under the board's field but advertising none of
  // the searched words outranked one filed elsewhere advertising all of them -
  // which is how a programme-management board came to be seeded with
  // construction firms while Databricks and OpenAI sat unused.
  const hitsOf = (row) => {
    const vocabulary = new Set(String(row.title_terms || '').split(' '));
    return wanted.filter((family) => family.some((term) => vocabulary.has(term))).length;
  };

  if (wanted.length > 0) {
    add(own.filter((row) => hitsOf(row) > 0), inField);
    add(largestRanked.filter((row) => hitsOf(row) > 0), limit - picked.length);
  }

  // Then the ordinary shares, which is what happens when nothing advertises the
  // words - a catalogue still being classified, or a search nobody is hiring
  // for this week.
  add(own, Math.max(0, inField - picked.length));
  add(largestRanked, limit - picked.length);
  if (picked.length < limit) add(own, limit - picked.length);

  return picked;
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

  await recordUsage(env, userId, response.usage);

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
/** Words too common across job titles to tell one employer from another. */
const TITLE_STOPWORDS = new Set([
  'senior', 'staff', 'lead', 'principal', 'junior', 'associate', 'the', 'and', 'for', 'with',
  'of', 'to', 'in', 'at', 'a', 'an', 'i', 'ii', 'iii', 'iv', 'sr', 'jr', 'remote', 'us', 'usa',
  'intern', 'internship', 'new', 'grad', 'contract', 'full', 'part', 'time', 'level',
]);

/**
 * How many distinct title words are kept per employer.
 *
 * Generous on purpose, because the words worth keeping are the rare ones. At
 * sixty this kept each employer's most frequent title words - which is to say
 * their main line of work - and a company with ten programme-management roles
 * among eight hundred postings recorded neither "technical" nor "programme".
 * The question being asked is whether an employer posts a role at all, not
 * whether it is what they mostly do.
 */
const TITLE_TERM_LIMIT = 250;

/** The vocabulary of an employer's board, most frequent first. */
export function titleTerms(jobs) {
  const counts = new Map();
  for (const job of jobs) {
    for (const word of String(job.title || '').toLowerCase().split(/[^a-z0-9+#]+/)) {
      if (word.length < 3 || TITLE_STOPWORDS.has(word)) continue;
      counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TITLE_TERM_LIMIT)
    .map(([word]) => word)
    .join(' ');
}

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
  // Actionable backlog only. A board that was read and had no openings has no
  // titles to classify from - it stays category-less until it posts again, and
  // counting it here held this gate shut permanently once the readable rows
  // were done. Rows that failed out are equally not waiting on classification.
  const backlog = await queryOne(
    env,
    `SELECT COUNT(*) AS n FROM company_directory
     WHERE category = ''
       AND failed_streak < ?
       AND NOT (verified_at <> '' AND job_count = 0)`,
    FAILED_STREAK_LIMIT
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

/** How long before a board that answered with nothing is looked at again. An
 *  employer between hiring rounds is worth revisiting, but not every tick. */
const RECHECK_QUIET_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

/** What the winning field has to clear before it is believed: at least this
 *  many postings, and this share of the board. A24 was being filed under
 *  marketing on one vote out of seven. */
const VOTE_MIN_COUNT = 2;
const VOTE_MIN_SHARE = 0.15;

/** Rows per INSERT, bounded by D1's cap of a hundred bound parameters in one
 *  statement.
 *
 *  Seven columns per row, so fourteen rows fits with headroom. This was sized
 *  for six and adding the openings count took it to a hundred and twelve, which
 *  D1 rejects - and the batch fails as a whole, so three lists loaded nothing
 *  at all and said nothing about it. */
const BULK_ROWS_PER_STATEMENT = 14;

/**
 * Load the published lists into the catalogue, a slice per tick.
 *
 * None of the four platforms publishes a directory, so every slug used to cost
 * a web search to discover. Published lists supply nearly twelve thousand at
 * once and remove that spend entirely - what they cannot supply is which field
 * each employer hires for, which is what classifyBoards works out afterwards.
 *
 * Entries land with no category on purpose. directoryFor matches on an exact
 * category, so an unclassified row is invisible to board creation rather than
 * being offered to every board indiscriminately.
 */
export async function loadPublishedLists(env) {
  const existing = await queryAll(env, 'SELECT kind, identifier FROM company_directory');
  const have = new Set(existing.map((row) => `${row.kind}:${row.identifier}`.toLowerCase()));

  const published = [
    ...GREENHOUSE_BOARDS.map((board) => ({ kind: 'greenhouse', ...board })),
    ...ATS_BOARDS,
    ...ATS_BOARDS_2,
    ...WORKDAY_BOARDS,
  ];
  const missing = published.filter(
    (board) => !have.has(`${board.kind}:${board.identifier}`.toLowerCase())
  );
  if (!missing.length) return { inserted: 0, remaining: 0 };

  const slice = missing.slice(0, BULK_INSERT_PER_TICK);
  const now = nowIso();
  const statements = [];
  for (let i = 0; i < slice.length; i += BULK_ROWS_PER_STATEMENT) {
    const chunk = slice.slice(i, i + BULK_ROWS_PER_STATEMENT);
    const values = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
    const params = [];
    for (const board of chunk) {
      params.push(
        newId('co_'),
        board.kind,
        board.identifier,
        String(board.name).slice(0, 120),
        '',
        board.openRoles || 0,
        now
      );
    }
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO company_directory
           (id, kind, identifier, name, category, job_count, created_at)
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
  // Largest employers first.
  //
  // This had no ordering at all, so it worked through the catalogue in
  // insertion order - which is alphabetical. Source selection draws its pool by
  // job_count, so the employers a board actually connects were the last to be
  // read, and a board built during the first hours of a rollout got employers
  // that had no vocabulary yet and were therefore ranked as though they
  // advertised nothing. Starting with the biggest means the pool is covered
  // after the first tick or two rather than the last.
  //
  // Rows needing a field, and rows needing a count.
  //
  // Seeded boards were written with job_count = 0 and nothing ever updated
  // them, because this only ever looked at rows with no category. That was
  // harmless while the catalogue was small and every row scored zero. Once the
  // published list arrived and classification gave thousands of boards a real
  // count, every hand-picked seed sorted below every bulk row with a single
  // opening - directoryFor orders on job_count - so curated boards stopped
  // being offered at all and creative searches were served agencywithin
  // instead of A24.
  const pending = await queryAll(
    env,
    `SELECT kind, identifier, category FROM company_directory
     WHERE (category = '' OR job_count = 0 OR title_terms = '')
       AND failed_streak < ?
       -- Skip only the ones already checked and found empty.
       --
       -- The window applied to every pending row, so an employer that had been
       -- read but still needed a vocabulary was locked out for three days -
       -- which stalled four and a half thousand of them behind boards that had
       -- nothing to give. A row is only resting if it was checked, returned
       -- nothing, and therefore has neither a count nor any titles to record.
       AND NOT (
         verified_at <> '' AND verified_at >= ? AND job_count = 0 AND title_terms = ''
       )
     ORDER BY timeout_streak ASC, job_count DESC
     LIMIT ?`,
    FAILED_STREAK_LIMIT,
    new Date(Date.now() - RECHECK_QUIET_AFTER_MS).toISOString(),
    limit
  );
  if (!pending.length) return { classified: 0, retired: 0 };

  const readBoard = async (row) => {
    try {
      const jobs = await fetchSource({ kind: row.kind, identifier: row.identifier }, { selfHost });
      // Reachable but advertising nothing. Common and temporary - an employer
      // between hiring rounds is not an employer that has gone away - so it is
      // not counted against the row at all.
      if (!jobs.length) return { row, quiet: true };

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
      // A row that already carries a field was placed there deliberately, by
      // hand or by discovery. This pass is only here to give it a count; it
      // must not relabel it from whatever happens to be posted this week.
      const category = row.category || (confident ? winner : 'other');
      return { row, category, jobCount: jobs.length, terms: titleTerms(jobs) };
    } catch (err) {
      // Slow and gone, told apart.
      //
      // This catch took no argument, so every failure looked identical and all
      // of them incremented failed_streak. Three ticks retired the row, and the
      // pending query filters on failed_streak, so a retired row is never read
      // again and nothing can clear it. That ran 500 boards a tick against a
      // 12-second budget while the largest listings take nearly thirty seconds
      // to return - which is how the biggest employers in the catalogue were
      // removed from every search on the service.
      return { row, failed: true, transient: Boolean(err && err.transient) };
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
    if (result.quiet) {
      // It answered and had nothing. Record that it was checked.
      //
      // Otherwise it stays in the pending queue permanently - the query selects
      // on an empty title_terms, which a board with no titles can never fill -
      // and several thousand dormant boards would be re-read every five minutes
      // for ever, crowding out the ones that have something to say.
      // job_count = 0 is not bookkeeping: the rest window keys on it. The
      // seeded count was the published list's snapshot, and a row whose board
      // has since emptied kept that stale count - so it never rested, was
      // re-selected every tick, and sorted near the front on a number that was
      // no longer true. Enough of those fill the whole tick and starve the
      // queue behind them. The read is the truth; the snapshot is not.
      writes.push(
        env.DB.prepare(
          'UPDATE company_directory SET verified_at = ?, timeout_streak = 0, job_count = 0 WHERE kind = ? AND identifier = ?'
        ).bind(now, result.row.kind, result.row.identifier)
      );
      continue;
    }
    if (result.failed) {
      writes.push(
        env.DB.prepare(
          result.transient
            ? `UPDATE company_directory SET timeout_streak = timeout_streak + 1
               WHERE kind = ? AND identifier = ?`
            : `UPDATE company_directory SET failed_streak = failed_streak + 1
               WHERE kind = ? AND identifier = ?`
        ).bind(result.row.kind, result.row.identifier)
      );
      retired += 1;
      continue;
    }
    writes.push(
      env.DB.prepare(
        `UPDATE company_directory
         SET category = ?, job_count = ?, title_terms = ?, verified_at = ?, failed_streak = 0, timeout_streak = 0
         WHERE kind = ? AND identifier = ?`
      ).bind(
        result.category,
        result.jobCount,
        result.terms || '',
        now,
        result.row.kind,
        result.row.identifier
      )
    );
    classified += 1;
  }
  if (writes.length) await env.DB.batch(writes);

  return { classified, retired };
}

export { CATEGORIES };
