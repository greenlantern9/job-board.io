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
import { CATEGORIES, getCategory } from './categories.js';

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
export async function noteFailure(env, kind, identifier) {
  await run(
    env,
    `UPDATE company_directory SET failed_streak = failed_streak + 1
     WHERE kind = ? AND identifier = ?`,
    kind,
    identifier
  );
}

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

export { CATEGORIES };
