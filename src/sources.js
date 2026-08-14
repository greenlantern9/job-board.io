// Job source connectors.
//
// Every connector hits a public, documented job-board endpoint that the ATS
// vendor publishes for exactly this purpose - no scraping of pages that forbid
// it, no logged-in endpoints. Each returns a list of normalized jobs; the
// caller decides what to persist.

const FETCH_TIMEOUT_MS = 10000;
const MAX_DESCRIPTION_CHARS = 4000;
const USER_AGENT = 'job-boards.io/1.0 (+https://job-boards.io)';

export const SOURCE_KINDS = ['greenhouse', 'lever', 'ashby', 'rss'];

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

function isoOrEmpty(value) {
  if (!value) return '';
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
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

export async function fetchSource(source, options = {}) {
  switch (source.kind) {
    case 'greenhouse':
      return fetchGreenhouse(source.identifier);
    case 'lever':
      return fetchLever(source.identifier);
    case 'ashby':
      return fetchAshby(source.identifier);
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
 * Applies a board's filters to a normalized job. Filters run before scoring so
 * the model is never asked about roles the user has already ruled out.
 */
export function matchesFilters(job, filters = {}) {
  const haystack = `${job.title} ${job.company} ${job.location} ${job.description}`.toLowerCase();

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

  return true;
}
