// Job source connectors.
//
// Every connector hits a public, documented job-board endpoint that the ATS
// vendor publishes for exactly this purpose - no scraping of pages that forbid
// it, no logged-in endpoints. Each returns a list of normalized jobs; the
// caller decides what to persist.

import { detectSeniorityLevel } from './rank.js';
import { expandPhrase } from './synonyms.js';

const FETCH_TIMEOUT_MS = 10000;
const MAX_DESCRIPTION_CHARS = 4000;
const USER_AGENT = 'job-boards.io/1.0 (+https://job-boards.io)';

/** Per-company boards, then cross-company aggregators, then generic feeds. */
export const SOURCE_KINDS = [
  'greenhouse',
  'lever',
  'ashby',
  'smartrecruiters',
  'remotive',
  'arbeitnow',
  'remoteok',
  'himalayas',
  'themuse',
  'jobicy',
  'adzuna',
  'rss',
];

/** Platforms discovery probes when trying to locate a named company. */
export const ATS_KINDS = ['greenhouse', 'lever', 'ashby', 'smartrecruiters'];

export class SourceError extends Error {}

async function fetchJson(url) {
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new SourceError(`${res.status} ${res.statusText}`);
  try {
    return await res.json();
  } catch {
    throw new SourceError('Response was not valid JSON');
  }
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, ...(init.headers || {}) },
      redirect: 'follow',
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new SourceError('Source timed out after 10s');
    throw new SourceError(err.message || 'Network error');
  } finally {
    clearTimeout(timer);
  }
}

// --- text helpers ----------------------------------------------------------

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"',
  hellip: '...',
};

export function decodeEntities(text) {
  return String(text || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, code) => {
    if (code[0] === '#') {
      const num = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(num) && num > 0 && num < 0x110000 ? String.fromCodePoint(num) : match;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, code) ? ENTITIES[code] : match;
  });
}

/** HTML to readable plain text. Block-level tags become newlines so bullet
 *  lists survive as something a scorer and a human can both read. */
export function htmlToText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|li|tr|h[1-6]|section)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function truncate(text, max = MAX_DESCRIPTION_CHARS) {
  const value = String(text || '');
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

const REMOTE_HINT = /\b(remote|work from home|wfh|distributed|anywhere)\b/i;
const HYBRID_HINT = /\bhybrid\b/i;

export function looksRemote(...fields) {
  const text = fields.filter(Boolean).join(' ');
  if (!REMOTE_HINT.test(text)) return false;
  // "Hybrid remote" is not remote for filtering purposes.
  return !HYBRID_HINT.test(text);
}

/**
 * Pulls a salary range out of free text. Deliberately conservative: an
 * unparseable range is better left as raw text than guessed at, because the
 * number feeds a min-salary filter.
 */
export function parseSalary(text) {
  const value = String(text || '');
  const money = String.raw`\$\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?\s?[kK]|\d{4,7})`;
  const range = new RegExp(`${money}\\s*(?:-|to|\\u2013|\\u2014)\\s*${money}`);
  const match = value.match(range);
  const toNumber = (raw) => {
    if (!raw) return 0;
    const clean = raw.replace(/[$,\s]/g, '');
    if (/[kK]$/.test(clean)) return Math.round(parseFloat(clean) * 1000);
    const num = parseInt(clean, 10);
    return Number.isFinite(num) ? num : 0;
  };
  if (match) {
    const min = toNumber(match[1]);
    const max = toNumber(match[2]);
    if (min > 0 && max >= min && max < 10_000_000) {
      return { min, max, raw: match[0].trim() };
    }
  }
  const single = value.match(new RegExp(money));
  if (single) {
    const amount = toNumber(single[1]);
    // Below 10k is almost always an hourly rate or an unrelated number.
    if (amount >= 10000 && amount < 10_000_000) return { min: amount, max: 0, raw: single[0].trim() };
  }
  return { min: 0, max: 0, raw: '' };
}

/**
 * Feeds report time as ISO strings, unix seconds, and unix milliseconds -
 * sometimes two of the three in one payload. Guessing wrong puts a fresh job in
 * 1970, which the recency ranking would then bury, so the magnitude is checked
 * rather than assumed.
 */
function isoOrEmpty(value) {
  if (!value && value !== 0) return '';

  let date;
  const numeric = typeof value === 'number' ? value : /^\d{9,14}$/.test(String(value).trim()) ? Number(value) : null;

  if (numeric !== null && Number.isFinite(numeric)) {
    // Seconds and milliseconds are told apart by size: anything below ~Nov 2286
    // in ms would be before 1971 in seconds, so the boundary is unambiguous for
    // any date a job posting could carry.
    date = new Date(numeric < 1e11 ? numeric * 1000 : numeric);
  } else {
    date = new Date(String(value));
  }

  if (Number.isNaN(date.getTime())) return '';
  // A posting dated in the future is a feed bug; treat it as undated rather
  // than letting it sit at the top of a recency sort forever.
  if (date.getTime() > Date.now() + 7 * 86400000) return '';
  return date.toISOString();
}

// --- identifier validation -------------------------------------------------

/** ATS board slugs are simple identifiers; anything else is a typo or an
 *  attempt to steer the request path somewhere it should not go. */
export function validateSlug(slug) {
  const value = String(slug || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(value)) {
    throw new SourceError('Company identifier must be letters, numbers, dashes or underscores.');
  }
  return value;
}

const BLOCKED_HOSTS =
  /^(localhost$|127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|.*\.internal$|.*\.local$)/i;

/**
 * Feed URLs come from user input, so they are an SSRF surface. Require HTTPS
 * and refuse anything pointed at a private range or back at ourselves.
 */
export function validateFeedUrl(raw, { selfHost } = {}) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new SourceError('Feed URL is not a valid URL.');
  }
  if (url.protocol !== 'https:') throw new SourceError('Feed URL must use https.');
  if (BLOCKED_HOSTS.test(url.hostname)) throw new SourceError('That host is not allowed.');
  if (selfHost && url.hostname === selfHost) throw new SourceError('That host is not allowed.');
  if (url.username || url.password) throw new SourceError('Feed URL must not contain credentials.');
  return url.toString();
}

/**
 * Whether a URL that arrived inside third-party data is safe to fetch or to
 * put in an href.
 *
 * Feed URLs are validated when someone adds a source, but the *job* URLs those
 * feeds return were not - and they reach two dangerous places: the link checker
 * fetches them from inside the Worker, and the client renders them as links.
 * That made an aggregator's data an SSRF vector and a javascript: URL an
 * execution vector, neither of which needs the feed to be malicious, only
 * compromised.
 *
 * Returns the normalized URL, or '' when it must not be used at all. Unlike
 * validateFeedUrl this does not throw: a bad link on one posting should drop
 * that link, not abort the whole refresh.
 */
export function safeExternalUrl(raw, { selfHost } = {}) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    return '';
  }
  // The only two schemes a job posting can legitimately live behind. This is
  // what keeps javascript:, data:, vbscript: and file: out of an href.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  if (BLOCKED_HOSTS.test(url.hostname)) return '';
  if (selfHost && url.hostname === selfHost) return '';
  if (url.username || url.password) return '';
  return url.toString();
}

// --- connectors ------------------------------------------------------------

async function fetchGreenhouse(slug) {
  const board = validateSlug(slug);
  const data = await fetchJson(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`
  );
  const jobs = Array.isArray(data && data.jobs) ? data.jobs : [];
  return jobs.map((job) => {
    const description = htmlToText(job.content);
    const location = (job.location && job.location.name) || '';
    const salary = parseSalary(description);
    return {
      direct: true,
      externalId: `greenhouse:${board}:${job.id}`,
      title: String(job.title || 'Untitled role').trim(),
      company: board,
      location,
      remote: looksRemote(location, job.title),
      employment: '',
      salaryMin: salary.min,
      salaryMax: salary.max,
      salaryRaw: salary.raw,
      url: job.absolute_url || '',
      description: truncate(description),
      postedAt: isoOrEmpty(job.updated_at || job.first_published),
    };
  });
}

async function fetchLever(slug) {
  const board = validateSlug(slug);
  const data = await fetchJson(
    `https://api.lever.co/v0/postings/${encodeURIComponent(board)}?mode=json`
  );
  const jobs = Array.isArray(data) ? data : [];
  return jobs.map((job) => {
    const categories = job.categories || {};
    const description = job.descriptionPlain || htmlToText(job.description);
    const salary = parseSalary(`${job.salaryRange ? JSON.stringify(job.salaryRange) : ''} ${description}`);
    return {
      direct: true,
      externalId: `lever:${board}:${job.id}`,
      title: String(job.text || 'Untitled role').trim(),
      company: board,
      location: categories.location || '',
      remote: looksRemote(categories.location, categories.commitment, job.workplaceType, job.text),
      employment: categories.commitment || '',
      salaryMin: salary.min,
      salaryMax: salary.max,
      salaryRaw: salary.raw,
      url: job.hostedUrl || job.applyUrl || '',
      description: truncate(description),
      postedAt: isoOrEmpty(job.createdAt),
    };
  });
}

async function fetchAshby(slug) {
  const board = validateSlug(slug);
  const data = await fetchJson(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=true`
  );
  const jobs = Array.isArray(data && data.jobs) ? data.jobs : [];
  return jobs.map((job) => {
    const description = job.descriptionPlain || htmlToText(job.descriptionHtml);
    const compensationText = job.compensation
      ? JSON.stringify(job.compensation.compensationTierSummary || job.compensation)
      : '';
    const salary = parseSalary(`${compensationText} ${description}`);
    return {
      direct: true,
      externalId: `ashby:${board}:${job.id}`,
      title: String(job.title || 'Untitled role').trim(),
      company: (job.organizationName || board).trim(),
      location: job.location || '',
      remote: Boolean(job.isRemote) || looksRemote(job.location, job.title),
      employment: job.employmentType || '',
      salaryMin: salary.min,
      salaryMax: salary.max,
      salaryRaw: salary.raw || (job.compensation && job.compensation.compensationTierSummary) || '',
      url: job.jobUrl || job.applyUrl || '',
      description: truncate(description),
      postedAt: isoOrEmpty(job.publishedAt || job.updatedAt),
    };
  });
}

/**
 * Generic RSS/Atom. Regex rather than a parser because Workers has no
 * DOMParser and job feeds are simple; anything it cannot read is reported as a
 * source error rather than silently yielding nothing.
 */
async function fetchRss(feedUrl, { selfHost } = {}) {
  const url = validateFeedUrl(feedUrl, { selfHost });
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/rss+xml, application/xml, text/xml' } });
  if (!res.ok) throw new SourceError(`${res.status} ${res.statusText}`);
  const xml = await res.text();

  const entries = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  if (entries.length === 0) throw new SourceError('No <item> or <entry> elements found in feed.');

  const pick = (block, tag) => {
    const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    if (!match) return '';
    return decodeEntities(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
  };

  const host = new URL(url).hostname.replace(/^www\./, '');

  return entries.map((block, index) => {
    const title = htmlToText(pick(block, 'title')) || 'Untitled role';
    // Atom puts the URL in an attribute; RSS puts it in element text.
    const linkAttr = block.match(/<link[^>]*href=["']([^"']+)["']/i);
    const link = pick(block, 'link') || (linkAttr ? decodeEntities(linkAttr[1]) : '');
    const guid = pick(block, 'guid') || pick(block, 'id') || link || `${index}`;
    const description = htmlToText(
      pick(block, 'description') || pick(block, 'summary') || pick(block, 'content')
    );
    const salary = parseSalary(`${title} ${description}`);
    return {
      direct: false,
      externalId: `rss:${host}:${guid}`.slice(0, 200),
      title,
      company: host,
      location: '',
      remote: looksRemote(title, description),
      employment: '',
      salaryMin: salary.min,
      salaryMax: salary.max,
      salaryRaw: salary.raw,
      url: link,
      description: truncate(description),
      postedAt: isoOrEmpty(pick(block, 'pubDate') || pick(block, 'updated') || pick(block, 'published')),
    };
  });
}

// --- aggregators -----------------------------------------------------------
//
// The ATS connectors above are per-company: useful, but a board only ever sees
// the dozen or so employers it happens to be pointed at. These search across
// thousands of companies in a single request, which is what stops the board
// being a keyhole view of the market.
//
// Their `identifier` is a search query rather than a company slug. Most of them
// return everything and are filtered locally; only Remotive takes a search
// parameter server-side.

/** Per-source ceiling. Aggregators can return thousands; the board filters and
 *  ranking narrow from there, but the row count has to stay bounded. */
const MAX_PER_AGGREGATOR = 200;

/**
 * Words too common on these boards to tell anything apart. "remote" matches
 * every posting on a remote-only aggregator; the rest appear in the boilerplate
 * of essentially every listing regardless of discipline.
 */
const UNDISCRIMINATING = new Set([
  'remote', 'hybrid', 'onsite', 'office', 'full', 'part', 'time', 'contract',
  'permanent', 'salary', 'benefits', 'company', 'role', 'roles', 'job', 'jobs',
  'position', 'work', 'working', 'team', 'teams', 'years', 'experience', 'new',
  'good', 'great', 'strong', 'want', 'looking', 'least', 'more', 'not',
]);

/**
 * Split on commas only, so a multi-word entry stays one phrase.
 *
 * Splitting "technical program manager" into three loose words is why a search
 * for it returned shop managers: any one of the words was enough. Kept whole,
 * it matches the role someone actually named.
 */
function queryTerms(identifier) {
  const chunks = String(identifier || '')
    .split(',')
    .map((t) => t.trim().toLowerCase().replace(/\s+/g, ' '))
    .filter(Boolean)
    // A single undiscriminating word is dropped; a phrase containing one is not,
    // because "remote" is noise alone but meaningful in "remote support lead".
    .filter((t) => t.length > 1 && !(!t.includes(' ') && UNDISCRIMINATING.has(t)));
  return [...new Set(chunks)];
}

/**
 * Word-boundary matcher.
 *
 * Substring matching is the reason an aggregator query for "go" returned shop
 * assistants: "go" is inside "category", "going", "Chicago" and a hundred other
 * words, so a two-letter language name matched most of the internet. Boundaries
 * are anchored only where the term actually starts or ends with a word
 * character, so "c++", "c#" and ".net" still match.
 */
function wordMatcher(word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const left = /^\w/.test(word) ? '\\b' : '';
  const right = /\w$/.test(word) ? '\\b' : '';
  return new RegExp(`${left}${escaped}${right}`, 'i');
}

/**
 * A term is matched when every word in it appears, in any order.
 *
 * Requiring adjacency was too brittle - "Program Manager, Technical
 * Infrastructure" is plainly the role someone meant by "technical program
 * manager", but the words are not consecutive. Requiring all of them, anywhere,
 * keeps that while still rejecting "Store Manager".
 *
 * Weight reflects how much a hit tells us: matching a multi-word term is strong
 * evidence on its own, matching the bare word "manager" is not.
 */
/** Escape a synonym for use inside a regex alternation, allowing any run of
 *  whitespace where the term has a space ("post production" / "post  production"). */
function alternationSafe(word) {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
}

function compileTerms(terms) {
  return terms.map((term) => {
    // Each slot is a family, not a word: "photographer" is satisfied by
    // "videographer", "content creator" or "visual storyteller" too, so nobody
    // has to guess the employer's vocabulary. The phrase still has to be
    // satisfied in full - expansion widens each slot, it does not drop any.
    const slots = expandPhrase(term).filter((family) => family.length > 0);
    if (slots.length === 0) return { res: [], weight: 1 };
    const res = slots.map((family) => {
      const alternatives = family
        .map(alternationSafe)
        // Longest first, so "content creator" is tried before "creator" and the
        // alternation cannot settle for the shorter prefix.
        .sort((a, b) => b.length - a.length)
        .join('|');
      return new RegExp(`(?:^|[^a-z0-9+#])(?:${alternatives})(?![a-z0-9+#])`, 'i');
    });
    return { res, weight: slots.length > 1 ? 2 : 1 };
  });
}

const termHits = (matcher, text) => matcher.res.every((re) => re.test(text));

/**
 * Looser test for sources that have already narrowed things server-side.
 *
 * The Muse has no free-text search but does filter by category and level, so a
 * page of results is already "senior project management" rather than the whole
 * index. Applying the full corroboration rule on top of that filters twice and
 * returns nothing - a Project Quality Manager is a real hit for someone hunting
 * a technical program manager, even though two of the three words are absent.
 * Here a single word of the query in the title is enough.
 */
export function matchesAnyWord(title, matchers) {
  if (!matchers || matchers.length === 0) return false;
  const titleText = String(title || '');
  return matchers.some((m) => m.res.some((re) => re.test(titleText)));
}

/**
 * Local narrowing for aggregator feeds, which have no server-side search worth
 * the name.
 *
 * "Any term appears anywhere" is far too loose in practice: an aggregator
 * returns every discipline, and a word like "engineer" or "senior" shows up in
 * the boilerplate of postings that have nothing to do with the search. So a
 * posting has to earn its place either by naming something you asked for in the
 * *title*, or by hitting at least two distinct terms in the body.
 *
 * Single-term searches stay permissive - there is no second term to corroborate
 * with, and being strict there would return almost nothing.
 */
/**
 * Corroboration, not any-hit.
 *
 * One matching word out of several is what let "Store Manager" through a search
 * for a technical program manager. A title now has to hit two of the terms
 * (or the single term, when only one was given), and the weaker body-only path
 * needs three.
 */
export function matchesQuery(title, body, matchers) {
  if (!matchers || matchers.length === 0) return false; // no criteria, no basis to include

  // Never demand more corroboration than the query can supply, or a one-word
  // search would match nothing at all.
  const available = matchers.reduce((sum, m) => sum + m.weight, 0);
  const titleNeeded = Math.min(2, available);

  const titleText = String(title || '');
  let titleScore = 0;
  for (const matcher of matchers) {
    if (termHits(matcher, titleText)) titleScore += matcher.weight;
    if (titleScore >= titleNeeded) return true;
  }

  // Body-only evidence is weak - a description mentions all sorts of things -
  // so it needs two *distinct* terms as well as the higher score. That makes
  // the path unsatisfiable for a single-term query on purpose: if someone names
  // one specific role, the title is where it has to appear.
  const haystack = `${titleText} ${String(body || '')}`;
  let score = 0;
  let distinct = 0;
  for (const matcher of matchers) {
    if (termHits(matcher, haystack)) {
      score += matcher.weight;
      distinct++;
    }
    if (distinct >= 2 && score >= 3) return true;
  }
  return false;
}

async function fetchRemotive(query) {
  const search = encodeURIComponent(String(query || '').slice(0, 100));
  const data = await fetchJson(
    `https://remotive.com/api/remote-jobs?limit=${MAX_PER_AGGREGATOR}${search ? `&search=${search}` : ''}`
  );
  const jobs = Array.isArray(data && data.jobs) ? data.jobs : [];
  return jobs.map((job) => {
    const description = htmlToText(job.description);
    const salary = parseSalary(`${job.salary || ''} ${description}`);
    return {
      direct: false,
      externalId: `remotive:${job.id}`,
      title: String(job.title || 'Untitled role').trim(),
      company: String(job.company_name || '').trim(),
      location: job.candidate_required_location || '',
      remote: true, // Remotive is a remote-only board.
      employment: job.job_type || '',
      salaryMin: salary.min,
      salaryMax: salary.max,
      salaryRaw: salary.raw || job.salary || '',
      url: job.url || '',
      description: truncate(description),
      postedAt: isoOrEmpty(job.publication_date),
    };
  });
}

async function fetchArbeitnow(query) {
  const data = await fetchJson('https://www.arbeitnow.com/api/job-board-api');
  const jobs = Array.isArray(data && data.data) ? data.data : [];
  // Compiled once per fetch rather than per posting. The regexes carry no /g
  // flag, so they hold no lastIndex state between calls.
  const matchers = compileTerms(queryTerms(query));
  const out = [];
  for (const job of jobs) {
    const description = htmlToText(job.description);
    const body = `${job.company_name} ${(job.tags || []).join(' ')} ${description}`;
    if (!matchesQuery(job.title, body, matchers)) continue;
    const salary = parseSalary(description);
    out.push({
      direct: false,
      externalId: `arbeitnow:${job.slug}`,
      title: String(job.title || 'Untitled role').trim(),
      company: String(job.company_name || '').trim(),
      location: job.location || '',
      remote: Boolean(job.remote),
      employment: (job.job_types || []).join(', '),
      salaryMin: salary.min,
      salaryMax: salary.max,
      salaryRaw: salary.raw,
      url: job.url || '',
      description: truncate(description),
      postedAt: isoOrEmpty(job.created_at),
    });
    if (out.length >= MAX_PER_AGGREGATOR) break;
  }
  return out;
}

async function fetchRemoteOk(query) {
  const data = await fetchJson('https://remoteok.com/api');
  // Index 0 is a legal/attribution notice rather than a posting.
  const jobs = Array.isArray(data) ? data.slice(1) : [];
  // Compiled once per fetch rather than per posting. The regexes carry no /g
  // flag, so they hold no lastIndex state between calls.
  const matchers = compileTerms(queryTerms(query));
  const out = [];
  for (const job of jobs) {
    const description = htmlToText(job.description);
    const body = `${job.company || ''} ${(job.tags || []).join(' ')} ${description}`;
    if (!matchesQuery(job.position, body, matchers)) continue;
    out.push({
      direct: false,
      externalId: `remoteok:${job.id || job.slug}`,
      title: String(job.position || 'Untitled role').trim(),
      company: String(job.company || '').trim(),
      location: job.location || '',
      remote: true,
      employment: '',
      salaryMin: Number(job.salary_min) || 0,
      salaryMax: Number(job.salary_max) || 0,
      salaryRaw: '',
      url: job.url || job.apply_url || '',
      description: truncate(description),
      postedAt: isoOrEmpty(job.epoch || job.date),
    });
    if (out.length >= MAX_PER_AGGREGATOR) break;
  }
  return out;
}

async function fetchHimalayas(query) {
  const data = await fetchJson(`https://himalayas.app/jobs/api?limit=${MAX_PER_AGGREGATOR}`);
  const jobs = Array.isArray(data && (data.jobs || data.data)) ? data.jobs || data.data : [];
  // Compiled once per fetch rather than per posting. The regexes carry no /g
  // flag, so they hold no lastIndex state between calls.
  const matchers = compileTerms(queryTerms(query));
  const out = [];
  for (const job of jobs) {
    const description = htmlToText(job.description || job.excerpt);
    const body = `${job.companyName} ${(job.categories || []).join(' ')} ${description}`;
    if (!matchesQuery(job.title, body, matchers)) continue;
    out.push({
      direct: false,
      externalId: `himalayas:${job.guid || `${job.companySlug}-${job.title}`}`.slice(0, 200),
      title: String(job.title || 'Untitled role').trim(),
      company: String(job.companyName || '').trim(),
      location: (job.locationRestrictions || []).join(', '),
      remote: true,
      employment: job.employmentType || '',
      salaryMin: Number(job.minSalary) || 0,
      salaryMax: Number(job.maxSalary) || 0,
      salaryRaw: '',
      url: job.applicationLink || '',
      description: truncate(description),
      postedAt: isoOrEmpty(job.pubDate),
    });
    if (out.length >= MAX_PER_AGGREGATOR) break;
  }
  return out;
}

/**
 * The Muse. No API key, and a large index - but no free-text search either, so
 * the narrowing has to happen through its own taxonomy.
 *
 * Mapping the query onto categories and a level turns "pull 100 random jobs out
 * of 400,000 and hope" into "pull 100 senior project-management jobs", which is
 * the difference between this source being useful and being noise.
 */
const MUSE_CATEGORIES = [
  [/(software|backend|back-end|frontend|front-end|fullstack|full-stack|developer|engineer|golang|rust|python|java|typescript|node)/, 'Software Engineering'],
  [/(program|project|delivery|tpm|pmo|scrum)/, 'Project Management'],
  [/(product)/, 'Product Management'],
  [/(data|analytics|analyst|machine learning|ml|scientist)/, 'Data Science'],
  [/(devops|sre|infrastructure|platform|cloud|security|network|systems)/, 'IT'],
  [/(design|designer|ux|ui)/, 'Design'],
  [/(sales|account executive|business development)/, 'Sales'],
  [/(marketing|growth|seo|content)/, 'Marketing'],
  [/(operations|ops|supply)/, 'Business Operations'],
  [/(finance|accounting|controller)/, 'Accounting'],
  // Verified against the live API as returning results. The creative
  // categories a photographer or videographer would want - Creative & Design,
  // Editorial, Media - all return zero, so there is nothing to map them to
  // here and they fall through to keyword matching instead.
  [/(customer service|support|troubleshoot|troubleshooting|helpdesk|help desk|client success)/, 'Customer Service'],
  [/(retail|store|shop|merchandis)/, 'Retail'],
  [/(teacher|tutor|instructor|coach|education|training|curriculum)/, 'Education'],
];

const MUSE_LEVELS = [
  [/\b(director|vp|vice president|head of|chief|executive)\b/, 'Management'],
  [/\b(senior|staff|principal|lead|sr)\b/, 'Senior Level'],
  [/\b(junior|entry|graduate|new grad|intern)\b/, 'Entry Level'],
];

/** How many 20-job pages to walk. Four is enough to fill a board without
 *  hammering an endpoint we are using unauthenticated. */
const MUSE_PAGES = 4;

async function fetchTheMuse(query) {
  const text = String(query || '').toLowerCase();

  const categories = MUSE_CATEGORIES.filter(([re]) => re.test(text)).map(([, name]) => name);
  const level = (MUSE_LEVELS.find(([re]) => re.test(text)) || [])[1];

  const matchers = compileTerms(queryTerms(query));
  const out = [];

  for (let page = 1; page <= MUSE_PAGES; page++) {
    const params = new URLSearchParams({ page: String(page) });
    // Repeated keys are how The Muse expresses OR across categories.
    for (const category of categories.slice(0, 3)) params.append('category', category);
    if (level) params.append('level', level);

    let data;
    try {
      data = await fetchJson(`https://www.themuse.com/api/public/jobs?${params.toString()}`);
    } catch (err) {
      // A later page failing should not discard the pages that worked.
      if (page === 1) throw err;
      break;
    }

    const jobs = Array.isArray(data && data.results) ? data.results : [];
    if (jobs.length === 0) break;

    for (const job of jobs) {
      const description = htmlToText(job.contents);
      const location = (job.locations || []).map((l) => l.name).join(', ');
      const body = `${(job.company && job.company.name) || ''} ${(job.categories || [])
        .map((c) => c.name)
        .join(' ')} ${description}`;

      // When the taxonomy filter did the narrowing, one query word in the title
      // is enough. When it did not, fall back to the full rule.
      const kept = categories.length
        ? matchesAnyWord(job.name, matchers)
        : matchesQuery(job.name, body, matchers);
      if (!kept) continue;

      const salary = parseSalary(description);
      out.push({
        direct: false,
        externalId: `themuse:${job.id}`,
        title: String(job.name || 'Untitled role').trim(),
        company: (job.company && job.company.name) || '',
        location,
        remote: looksRemote(location, job.name),
        employment: (job.levels || []).map((l) => l.name).join(', '),
        salaryMin: salary.min,
        salaryMax: salary.max,
        salaryRaw: salary.raw,
        url: (job.refs && job.refs.landing_page) || '',
        description: truncate(description),
        postedAt: isoOrEmpty(job.publication_date),
      });
      if (out.length >= MAX_PER_AGGREGATOR) return out;
    }

    if (data.page_count && page >= data.page_count) break;
  }

  return out;
}

async function fetchSmartRecruiters(slug) {
  const board = validateSlug(slug);
  const data = await fetchJson(
    `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(board)}/postings?limit=100`
  );
  const jobs = Array.isArray(data && data.content) ? data.content : [];
  return jobs.map((job) => {
    const location = [job.location && job.location.city, job.location && job.location.country]
      .filter(Boolean)
      .join(', ');
    return {
      direct: true,
      externalId: `smartrecruiters:${board}:${job.id}`,
      title: String(job.name || 'Untitled role').trim(),
      company: (job.company && job.company.name) || board,
      location,
      remote: Boolean(job.location && job.location.remote) || looksRemote(location, job.name),
      employment: (job.typeOfEmployment && job.typeOfEmployment.label) || '',
      salaryMin: 0,
      salaryMax: 0,
      salaryRaw: '',
      url: job.ref || `https://jobs.smartrecruiters.com/${board}/${job.id}`,
      description: '',
      postedAt: isoOrEmpty(job.releasedDate || job.createdOn),
    };
  });
}

/** Kinds whose identifier is a search query, not a company. */
export const AGGREGATOR_KINDS = ['adzuna', 'themuse', 'jobicy', 'remotive', 'arbeitnow', 'remoteok', 'himalayas'];

/** Exposed so the matching rules can be tested without hitting a live feed. */
export function _compileQuery(identifier) {
  return compileTerms(queryTerms(identifier));
}

// Declared before matchesFilters uses it; function declarations hoist, but the
// dependency is worth stating since the two live far apart in this file.
export { compileTerms as _compileTerms };

/**
 * Jobicy. No key, and its tag filter genuinely narrows - unlike most of the
 * free feeds, which ignore every parameter you send them.
 */
async function fetchJobicy(query) {
  const matchers = compileTerms(queryTerms(query));
  const text = String(query || '').toLowerCase();

  // Its tags are a small fixed vocabulary; mapping onto them narrows
  // server-side, which is the difference between this source being useful and
  // being another hundred rows of the same remote engineering jobs.
  // Verified against the live API. Stems rather than whole words, because
  // photo never matches "photographer" - which is exactly how the first
  // attempt returned nothing for every creative search.
  const TAGS = [
    [/photograph|photo|camera/, 'photography'],
    [/video|videograph|film|cinema|footage|editw*s+video/, 'video'],
    [/creative|storytell|art direct/, 'creative'],
    [/design|designer|ux|ui|brand/, 'design'],
    [/support|customer service|client success|troubleshoot|helpdesk|help desk/, 'support'],
    [/copywrit|writer|writing|editor|content/, 'copywriting'],
    [/market|growth|seo|social media/, 'marketing'],
    [/sales|account executive|business development/, 'sales'],
    [/data|analytics|analyst/, 'data-science'],
  ];
  const tag = (TAGS.find(([re]) => re.test(text)) || [])[1];

  const params = new URLSearchParams({ count: String(Math.min(50, MAX_PER_AGGREGATOR)) });
  if (tag) params.set('tag', tag);

  const data = await fetchJson(`https://jobicy.com/api/v2/remote-jobs?${params.toString()}`);
  const jobs = Array.isArray(data && data.jobs) ? data.jobs : [];
  const out = [];

  for (const job of jobs) {
    const description = htmlToText(job.jobExcerpt || job.jobDescription);
    const title = job.jobTitle || '';
    const body = `${job.companyName || ''} ${(job.jobIndustry || []).join(' ')} ${description}`;
    // The tag already narrowed; require only a single word when it did.
    const kept = tag ? matchesAnyWord(title, matchers) : matchesQuery(title, body, matchers);
    if (!kept) continue;

    const salary = parseSalary(`${job.annualSalaryMin || ''} ${job.annualSalaryMax || ''} ${description}`);
    out.push({
      direct: false,
      externalId: `jobicy:${job.id}`,
      title: String(title).trim(),
      company: job.companyName || '',
      location: (job.jobGeo || '').replace(/,s*$/, ''),
      remote: true,
      employment: (job.jobType || []).join(', '),
      salaryMin: Number(job.annualSalaryMin) || salary.min,
      salaryMax: Number(job.annualSalaryMax) || salary.max,
      salaryRaw: salary.raw,
      url: job.url || '',
      description: truncate(description),
      postedAt: isoOrEmpty(job.pubDate),
    });
    if (out.length >= MAX_PER_AGGREGATOR) break;
  }
  return out;
}

/**
 * Adzuna. The only source here that searches a large general index rather than
 * a remote-tech niche - hourly, local, contract and trade work included - and
 * the only one where the keyword, salary and recency filters run against the
 * whole corpus instead of a window we pulled.
 *
 * Needs a free app id and key. Without them the source reports that plainly
 * rather than silently returning nothing.
 */
async function fetchAdzuna(query, env) {
  const appId = env && env.ADZUNA_APP_ID;
  const appKey = env && env.ADZUNA_APP_KEY;
  if (!appId || !appKey) {
    throw new SourceError('Adzuna needs ADZUNA_APP_ID and ADZUNA_APP_KEY set as Worker secrets.');
  }

  // The identifier carries "query @ country", so one connector serves any
  // market Adzuna covers.
  const [rawQuery, rawCountry] = String(query || '').split('@');
  const country = (rawCountry || 'us').trim().toLowerCase().slice(0, 2);
  const what = rawQuery.trim();

  const params = new URLSearchParams({
    app_id: appId,
    app_key: appKey,
    results_per_page: '50',
    what: what,
    max_days_old: '30',
    sort_by: 'date',
    'content-type': 'application/json',
  });

  const data = await fetchJson(
    `https://api.adzuna.com/v1/api/jobs/${encodeURIComponent(country)}/search/1?${params.toString()}`
  );
  const jobs = Array.isArray(data && data.results) ? data.results : [];

  return jobs.slice(0, MAX_PER_AGGREGATOR).map((job) => {
    const description = htmlToText(job.description);
    const location = (job.location && job.location.display_name) || '';
    return {
      direct: false,
      externalId: `adzuna:${job.id}`,
      title: String(job.title || 'Untitled role').replace(/<[^>]+>/g, '').trim(),
      company: (job.company && job.company.display_name) || '',
      location,
      remote: looksRemote(location, job.title, description),
      employment: [job.contract_time, job.contract_type].filter(Boolean).join(', '),
      // Adzuna normalises salary itself, which most sources do not.
      salaryMin: Math.round(Number(job.salary_min) || 0),
      salaryMax: Math.round(Number(job.salary_max) || 0),
      salaryRaw: '',
      url: job.redirect_url || '',
      description: truncate(description),
      postedAt: isoOrEmpty(job.created),
    };
  });
}

export async function fetchSource(source, options = {}) {
  switch (source.kind) {
    case 'greenhouse':
      return fetchGreenhouse(source.identifier);
    case 'lever':
      return fetchLever(source.identifier);
    case 'ashby':
      return fetchAshby(source.identifier);
    case 'smartrecruiters':
      return fetchSmartRecruiters(source.identifier);
    case 'remotive':
      return fetchRemotive(source.identifier);
    case 'arbeitnow':
      return fetchArbeitnow(source.identifier);
    case 'remoteok':
      return fetchRemoteOk(source.identifier);
    case 'himalayas':
      return fetchHimalayas(source.identifier);
    case 'themuse':
      return fetchTheMuse(source.identifier);
    case 'jobicy':
      return fetchJobicy(source.identifier);
    case 'adzuna':
      return fetchAdzuna(source.identifier, options.env);
    case 'rss':
      return fetchRss(source.identifier, options);
    default:
      throw new SourceError(`Unknown source type: ${source.kind}`);
  }
}

// --- filtering -------------------------------------------------------------

function terms(value) {
  return String(value || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Company names arrive in three shapes for the same employer: the ATS slug
 * ("acme-corp"), the display name ("Acme Corp, Inc."), and whatever the user
 * typed. Strip everything that varies so the three compare equal.
 */
export function normalizeCompany(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|gmbh|co|plc|sa|ag|bv|nv)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export function companyMatches(company, list) {
  const target = normalizeCompany(company);
  if (!target) return false;
  return list.some((entry) => {
    const candidate = normalizeCompany(entry);
    if (!candidate) return false;
    // Substring either way, so "Stripe" matches "Stripe Payments" and a slug
    // like "stripeinc" matches "Stripe".
    return target === candidate || target.includes(candidate) || candidate.includes(target);
  });
}

/**
 * Applies a board's filters to a normalized job. Filters run before scoring so
 * the model is never asked about roles the user has already ruled out.
 */
export function matchesFilters(job, filters = {}) {
  const haystack = `${job.title} ${job.company} ${job.location} ${job.description}`.toLowerCase();

  // Relevance gate for sources that cannot search their own index.
  //
  // Company boards return every opening the employer has - 809 at one company
  // alone - and previously all of them were stored, because only aggregators
  // were relevance-checked. That is why a board about program management filled
  // up with warehouse and sales roles. `query` is the board's derived search,
  // passed in by the caller.
  if (filters.query) {
    const matchers = _compileQuery(filters.query);
    if (matchers.length > 0 && !matchesQuery(job.title, job.description, matchers)) return false;
  }

  const exclude = terms(filters.exclude);
  if (exclude.some((term) => haystack.includes(term))) return false;

  const include = terms(filters.keywords);
  if (include.length > 0 && !include.some((term) => haystack.includes(term))) return false;

  if (filters.remoteOnly && !job.remote) return false;

  const locations = terms(filters.locations);
  if (locations.length > 0) {
    const where = `${job.location}`.toLowerCase();
    // A remote job satisfies any location filter - that is the point of remote.
    if (!job.remote && !locations.some((term) => where.includes(term))) return false;
  }

  const minSalary = Number(filters.minSalary) || 0;
  if (minSalary > 0) {
    const best = Math.max(job.salaryMax || 0, job.salaryMin || 0);
    // Unknown salary is kept: dropping every listing that omits a range would
    // discard most of the market.
    if (best > 0 && best < minSalary) return false;
  }

  // Age ceiling at ingest. Undated postings are kept - many feeds omit the
  // field entirely, and dropping them would discard real jobs rather than old
  // ones.
  const maxAgeDays = Number(filters.maxAgeDays);
  if (Number.isFinite(maxAgeDays) && maxAgeDays > 0 && job.postedAt) {
    const age = (Date.now() - new Date(job.postedAt).getTime()) / 86400000;
    if (Number.isFinite(age) && age > maxAgeDays) return false;
  }

  // A title that states no level is kept, for the same reason. Plenty of
  // genuinely senior roles are titled just "Software Engineer".
  const minSeniority = Number(filters.minSeniority);
  if (Number.isFinite(minSeniority) && minSeniority >= 0) {
    const stated = detectSeniorityLevel(job.title);
    if (stated !== null && stated < minSeniority) return false;
  }

  // "limit" makes the company list a hard allowlist; "prioritize" leaves it to
  // the ranking, which boosts these instead of excluding everyone else.
  const companies = terms(filters.companies);
  if (companies.length > 0 && filters.companyMode === 'limit') {
    if (!companyMatches(job.company, companies)) return false;
  }

  return true;
}
