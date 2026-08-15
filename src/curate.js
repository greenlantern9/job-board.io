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
import { fetchSource } from './sources.js';

/** Enough breadth to fill a board without spending the whole refresh budget. */
export const TARGET_SOURCES = 12;

/** Consecutive empty refreshes before an auto source is retired. */
const EMPTY_STREAK_LIMIT = 4;

/** How often curation revisits a board that is healthy. */
export const RECURATE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

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
    (s) => s.last_status === 'error' || (s.empty_streak || 0) >= EMPTY_STREAK_LIMIT
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
    for (const kind of ['greenhouse', 'lever', 'ashby']) {
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

    const named = await connectNamedCompanies(env, board, existing, selfHost);
    summary.added += named.added;
    if (named.added) existing = await queryAll(env, 'SELECT * FROM sources WHERE board_id = ?', board.id);

    // In "limit" mode the user has told us exactly which employers matter.
    // Suggesting others would be working against them.
    const limited = (board.filters || {}).companyMode === 'limit' && boardCompanies(board).length > 0;
    const shortfall = TARGET_SOURCES - existing.length;

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
