// Source curation.
//
// Connecting sources used to be a setup step: create a board, then go find out
// which ATS each company you care about uses, and type in slugs. That is
// homework, and it stands between someone and the first useful screen.
//
// So the system picks the sources instead. On board creation it reads the
// criteria, proposes employers, verifies each against a live job board, and
// connects the ones that resolve. Then it revisits that choice on a schedule:
// retiring boards that have gone quiet or started failing, and topping the
// board back up with fresh candidates.
//
// Anything a user adds by hand is left alone - curation only ever prunes its
// own picks.

import { suggestCompanies } from './suggest.js';
import { queryAll, queryOne, run, nowIso, parseJson } from './db.js';
import { newId } from './crypto.js';
import { fetchSource, AGGREGATOR_KINDS, ATS_KINDS } from './sources.js';
import { extractRolePhrases } from './intent.js';
import { SEED_COMPANIES, SEED_LIMIT } from './seeds.js';

/** Enough breadth to fill a board without spending the whole refresh budget. */
export const TARGET_SOURCES = 12;

/** Consecutive empty refreshes before an auto source is retired. */
const EMPTY_STREAK_LIMIT = 4;

/** How often curation revisits a board that is healthy. */
export const RECURATE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const AGGREGATOR_LABELS = {
  themuse: 'The Muse (all companies, all locations)',
  remotive: 'Remotive (remote roles, all companies)',
  arbeitnow: 'Arbeitnow (all companies)',
  remoteok: 'RemoteOK (remote roles, all companies)',
  himalayas: 'Himalayas (remote roles, all companies)',
};

const QUERY_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'you', 'our', 'are', 'will', 'that', 'this', 'have', 'from',
  'want', 'looking', 'work', 'working', 'team', 'role', 'roles', 'job', 'jobs', 'position',
  'company', 'companies', 'experience', 'years', 'least', 'not', 'interested', 'prefer',
  'preferably', 'ideally', 'would', 'like', 'want', 'any', 'some', 'more', 'than', 'also',
]);

/**
 * The search string handed to aggregators. Their identifier is a query rather
 * than a company, so it has to come from the criteria - and it has to stay in
 * step when those criteria change.
 */
export function boardQuery(board) {
  const filters = board.filters || {};
  if (filters.keywords && filters.keywords.trim()) return filters.keywords.trim().slice(0, 120);

  // Role phrases first. "technical program manager" kept whole is a completely
  // different search from those three words scattered, which each match on
  // their own and drag in store managers.
  const phrases = extractRolePhrases(board.prompt);

  const words = String(board.prompt || '')
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((w) => w.length > 2 && !QUERY_STOPWORDS.has(w))
    // Words already carried by a phrase would only dilute it.
    .filter((w) => !phrases.some((p) => p.split(' ').includes(w)));

  const terms = [...phrases, ...new Set(words)];
  return terms.slice(0, 6).join(', ');
}

/**
 * Every board gets the cross-company aggregators. Without them a board only
 * ever sees the dozen employers discovery happened to pick, which quietly caps
 * what the user can find no matter how good the ranking is.
 */
async function ensureAggregators(env, board, existing) {
  const query = boardQuery(board);
  let added = 0;

  // With nothing to search for, an aggregator matches everything and the board
  // fills with a few hundred unrelated postings. Better to connect none and let
  // the criteria arrive first - the UI requires them, so this is the guard for
  // boards created before that rule or through the API directly.
  if (!query) return 0;

  for (const kind of AGGREGATOR_KINDS) {
    const current = existing.find((s) => s.kind === kind);
    if (current) {
      // Criteria drift otherwise leaves the aggregators searching for whatever
      // the board used to be about.
      if (current.identifier !== query) {
        await run(env, 'UPDATE sources SET identifier = ? WHERE id = ?', query, current.id);
      }
      continue;
    }
    const inserted = await insertSource(env, board, {
      kind,
      identifier: query,
      label: AGGREGATOR_LABELS[kind],
      auto: 1,
    });
    if (inserted) added++;
  }
  return added;
}

function boardCompanies(board) {
  return String((board.filters || {}).companies || '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * Retire auto-picked sources that are no longer earning their slot: erroring
 * repeatedly, or returning nothing several refreshes running. A board that has
 * simply paused hiring comes back through the next discovery pass, so dropping
 * it is cheap and keeps the refresh fast.
 */
async function pruneDeadSources(env, board) {
  const sources = await queryAll(
    env,
    'SELECT * FROM sources WHERE board_id = ? AND auto = 1',
    board.id
  );

  const doomed = sources.filter(
    // Aggregators are the safety net and are never retired. A quiet week means
    // the query matched nothing, not that the source is dead, and deleting one
    // would silently narrow the board back to whatever companies it knows.
    (s) =>
      !AGGREGATOR_KINDS.includes(s.kind) &&
      (s.last_status === 'error' || (s.empty_streak || 0) >= EMPTY_STREAK_LIMIT)
  );
  if (doomed.length === 0) return { removed: 0, names: [] };

  await env.DB.batch(
    doomed.map((s) => env.DB.prepare('DELETE FROM sources WHERE id = ?').bind(s.id))
  );
  return { removed: doomed.length, names: doomed.map((s) => s.label || s.identifier) };
}

/**
 * Re-check the company list the user curated by hand. When they name employers
 * we have no source for, find one - that is the whole promise of not making
 * them look up ATS slugs.
 */
async function connectNamedCompanies(env, board, existing, selfHost) {
  const named = boardCompanies(board);
  if (named.length === 0) return { added: 0, names: [] };

  const have = new Set(existing.map((s) => String(s.identifier).toLowerCase()));
  const missing = named.filter(
    (name) => !have.has(name.toLowerCase().replace(/[^a-z0-9]/g, ''))
  );
  if (missing.length === 0) return { added: 0, names: [] };

  const added = [];
  for (const name of missing.slice(0, 6)) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!slug) continue;
    for (const kind of ATS_KINDS) {
      try {
        const jobs = await fetchSource({ kind, identifier: slug }, { selfHost });
        if (jobs.length === 0) continue;
        await insertSource(env, board, { kind, identifier: slug, label: name, auto: 1 });
        added.push(name);
        break;
      } catch {
        // Not this platform. Try the next.
      }
    }
  }
  return { added: added.length, names: added };
}

async function insertSource(env, board, { kind, identifier, label, auto }) {
  const duplicate = await queryOne(
    env,
    'SELECT id FROM sources WHERE board_id = ? AND kind = ? AND identifier = ?',
    board.id,
    kind,
    identifier
  );
  if (duplicate) return false;

  await run(
    env,
    `INSERT INTO sources (id, board_id, user_id, kind, identifier, label, auto, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    newId('src_'),
    board.id,
    board.user_id,
    kind,
    identifier,
    label || identifier,
    auto ? 1 : 0,
    nowIso()
  );
  return true;
}

/**
 * Bring a board's sources up to date. Safe to call at any time: it prunes what
 * has died, honours any companies the user named, and fills the remaining slots
 * with verified suggestions.
 *
 * Never throws. Curation failing is not a reason for board creation or a cron
 * tick to fail - the board still works with whatever sources it already has.
 */
export async function curateBoard(env, board, { selfHost, force = false } = {}) {
  const summary = { pruned: 0, added: 0, note: '', ok: true };

  try {
    const pruned = await pruneDeadSources(env, board);
    summary.pruned = pruned.removed;

    let existing = await queryAll(env, 'SELECT * FROM sources WHERE board_id = ?', board.id);

    // Widest net first, and it needs no API key - so even a board that cannot
    // run discovery still pulls from thousands of companies.
    summary.added += await ensureAggregators(env, board, existing);
    existing = await queryAll(env, 'SELECT * FROM sources WHERE board_id = ?', board.id);

    // Seed company boards. These are where senior and specialised roles
    // actually get posted, and unlike discovery they need no API key - so the
    // free path is not left with aggregators alone.
    const haveCompany = existing.filter((s) => !AGGREGATOR_KINDS.includes(s.kind));
    if (haveCompany.length === 0) {
      for (const seed of SEED_COMPANIES.slice(0, SEED_LIMIT)) {
        if (await insertSource(env, board, { ...seed, auto: 1 })) summary.added++;
      }
      existing = await queryAll(env, 'SELECT * FROM sources WHERE board_id = ?', board.id);
    }

    const named = await connectNamedCompanies(env, board, existing, selfHost);
    summary.added += named.added;
    if (named.added) existing = await queryAll(env, 'SELECT * FROM sources WHERE board_id = ?', board.id);

    // In "limit" mode the user has told us exactly which employers matter.
    // Suggesting others would be working against them. The aggregators stay:
    // the company filter drops anything off-list at ingest, so they can only
    // add postings at the named companies that the ATS boards missed.
    const limited = (board.filters || {}).companyMode === 'limit' && boardCompanies(board).length > 0;
    // Aggregators are not companies, so they must not count toward the company
    // target - otherwise four of them would satisfy it and discovery would
    // never run.
    const companyCount = existing.filter((s) => !AGGREGATOR_KINDS.includes(s.kind)).length;
    const shortfall = TARGET_SOURCES - companyCount;

    if (!limited && (force || shortfall > 0)) {
      const known = [
        ...existing.map((s) => s.label || s.identifier),
        ...boardCompanies(board),
      ];
      const suggested = await suggestCompanies(env, board, { known, selfHost });
      for (const company of suggested.companies.slice(0, Math.max(shortfall, force ? 4 : 0))) {
        const inserted = await insertSource(env, board, {
          kind: company.kind,
          identifier: company.identifier,
          label: company.name,
          auto: 1,
        });
        if (inserted) summary.added++;
      }
    }

    const parts = [];
    if (summary.added) parts.push(`connected ${summary.added}`);
    if (summary.pruned) parts.push(`retired ${summary.pruned}`);
    summary.note = parts.length ? `Sources ${parts.join(', ')}.` : 'Sources checked, no changes needed.';
  } catch (err) {
    summary.ok = false;
    // The common case by far is no ANTHROPIC_API_KEY, which is a configuration
    // state rather than a fault - say so plainly instead of "curation failed".
    summary.note =
      err.code === 'no_api_key'
        ? 'Automatic source discovery needs an Anthropic API key. Add companies by hand until then.'
        : `Could not refresh the source list: ${err.message}`;
  }

  await run(
    env,
    'UPDATE boards SET last_curated = ?, curate_note = ?, updated_at = ? WHERE id = ?',
    nowIso(),
    summary.note.slice(0, 300),
    nowIso(),
    board.id
  );

  return summary;
}

/** Boards whose source list is stale, or that have none at all. */
export async function boardsDueForCuration(env, { limit = 3 } = {}) {
  const rows = await queryAll(
    env,
    `SELECT b.*, (SELECT COUNT(*) FROM sources s WHERE s.board_id = b.id) AS source_count
     FROM boards b ORDER BY b.last_curated ASC LIMIT ?`,
    limit * 4
  );

  const now = Date.now();
  return rows
    .filter((board) => {
      if (board.source_count === 0) return true; // never got off the ground
      if (!board.last_curated) return true;
      return now - new Date(board.last_curated).getTime() >= RECURATE_AFTER_MS;
    })
    .slice(0, limit)
    .map((board) => ({ ...board, filters: parseJson(board.filters, {}) }));
}
