// Confirm a posting still exists before it reaches the board.
//
// Presence-reaping already retires jobs a company board stops listing, but that
// only works for per-company sources and only on the *next* refresh. A link
// check catches the other cases immediately: aggregator entries that outlived
// the posting, and jobs already filled by the time we first see them.
//
// The budget is the constraint. A Worker gets 50 subrequests per invocation on
// the free plan, and fetching sources already spends around thirty, so every
// job cannot be checked on the run that discovers it. Checks are therefore
// spent on the jobs most likely to be read - highest ranked first - and the
// rest are checked on later refreshes.

const CHECK_TIMEOUT_MS = 6000;
const CONCURRENCY = 6;

/** Statuses that mean the posting is definitively gone. */
const DEAD_STATUSES = new Set([404, 410]);

export const LINK_LIVE = 'live';
export const LINK_DEAD = 'dead';
export const LINK_UNKNOWN = 'unknown';

/**
 * Check one URL.
 *
 * Anything that is not a clear 404/410 counts as unknown rather than dead.
 * Sites rate-limit, block unfamiliar clients, and time out; treating any of
 * that as "this job is gone" would delete real listings. Being wrong in the
 * cautious direction shows a stale job, being wrong the other way hides a live
 * one - and the second is worse.
 */
/**
 * The identifying tail of a job URL - the segment that names *this* posting
 * rather than the board it sits on.
 */
function jobIdentifier(url) {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '');
    const last = path.split('/').filter(Boolean).pop() || '';
    return last.toLowerCase();
  } catch {
    return '';
  }
}

export async function checkLink(url) {
  if (!url || !/^https?:\/\//i.test(url)) return LINK_UNKNOWN;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        // Some ATS hosts return 403 to unfamiliar clients, and a few 404 on
        // HEAD while serving GET fine - hence GET with a browser-ish accept.
        'User-Agent': 'job-boards.io/1.0 (+https://job-boards.io)',
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      },
    });

    if (DEAD_STATUSES.has(res.status)) return LINK_DEAD;
    if (res.status < 200 || res.status >= 400) return LINK_UNKNOWN;

    // Status alone is not enough. Greenhouse answers a deleted posting by
    // redirecting to the company's board index, which is a perfectly healthy
    // 200 - so checking the status would report a filled job as live, which is
    // worse than not checking at all. If the posting's own identifier is gone
    // from the final URL, we landed somewhere else.
    const wanted = jobIdentifier(url);
    if (wanted && wanted.length > 3 && res.url) {
      const landed = String(res.url).toLowerCase();
      if (!landed.includes(wanted)) return LINK_DEAD;
    }

    return LINK_LIVE;
  } catch {
    return LINK_UNKNOWN;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check up to `budget` URLs with bounded concurrency, returning a Map of url to
 * status. Order matters: callers pass the most important jobs first, because
 * the budget runs out before the list does.
 */
export async function checkLinks(urls, { budget = 12 } = {}) {
  const unique = [...new Set(urls.filter(Boolean))].slice(0, budget);
  const results = new Map();
  let cursor = 0;

  const worker = async () => {
    while (cursor < unique.length) {
      const url = unique[cursor++];
      results.set(url, await checkLink(url));
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, unique.length) }, worker));
  return results;
}
