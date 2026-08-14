import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSalary,
  htmlToText,
  decodeEntities,
  looksRemote,
  matchesFilters,
  validateSlug,
  validateFeedUrl,
  truncate,
  SourceError,
} from '../src/sources.js';

test('salary ranges are parsed from common formats', () => {
  assert.deepEqual(parseSalary('$120,000 - $150,000 per year'), {
    min: 120000,
    max: 150000,
    raw: '$120,000 - $150,000',
  });
  assert.equal(parseSalary('$180k to $220k').min, 180000);
  assert.equal(parseSalary('$180k to $220k').max, 220000);
  assert.equal(parseSalary('Base: $95000–$130000').min, 95000);
});

test('a single figure is treated as a floor, not a range', () => {
  const result = parseSalary('Starting at $145,000');
  assert.equal(result.min, 145000);
  assert.equal(result.max, 0);
});

test('salary parsing ignores numbers that are not salaries', () => {
  // An hourly rate, a headcount, and a funding figure must not become a salary.
  assert.deepEqual(parseSalary('$45 per hour'), { min: 0, max: 0, raw: '' });
  assert.deepEqual(parseSalary('We are a team of 250 people'), { min: 0, max: 0, raw: '' });
  assert.deepEqual(parseSalary('no compensation listed'), { min: 0, max: 0, raw: '' });
  // Absurd values are rejected rather than corrupting a min-salary filter.
  assert.equal(parseSalary('$50,000,000 - $60,000,000').min, 0);
});

test('HTML is reduced to readable text with list structure intact', () => {
  const html = '<div><p>We need:</p><ul><li>Go</li><li>Rust</li></ul></div>';
  assert.equal(htmlToText(html), 'We need:\n- Go\n- Rust');
});

test('scripts and styles are dropped, not rendered as text', () => {
  const html = '<p>Real</p><script>alert("x")</script><style>.a{color:red}</style>';
  const text = htmlToText(html);
  assert.equal(text.includes('alert'), false);
  assert.equal(text.includes('color:red'), false);
  assert.ok(text.includes('Real'));
});

test('entities decode, including numeric and hex forms', () => {
  assert.equal(decodeEntities('Ben &amp; Jerry&#39;s'), "Ben & Jerry's");
  assert.equal(decodeEntities('caf&#233;'), 'café');
  assert.equal(decodeEntities('&#x2014;'), '—');
  // An unknown entity is left alone rather than mangled.
  assert.equal(decodeEntities('&notreal;'), '&notreal;');
});

test('remote detection ignores hybrid roles', () => {
  assert.equal(looksRemote('Remote - US'), true);
  assert.equal(looksRemote('Work from home'), true);
  assert.equal(looksRemote('Hybrid remote, 3 days in office'), false);
  assert.equal(looksRemote('New York, NY'), false);
});

test('truncate marks elision and leaves short text alone', () => {
  assert.equal(truncate('short', 20), 'short');
  const long = truncate('x'.repeat(50), 10);
  assert.equal(long.length, 10);
  assert.ok(long.endsWith('…'));
});

// --- filters ---------------------------------------------------------------

const job = (over = {}) => ({
  title: 'Senior Backend Engineer',
  company: 'acme',
  location: 'Remote - US',
  description: 'Go and Postgres. Series B.',
  remote: true,
  salaryMin: 180000,
  salaryMax: 220000,
  ...over,
});

test('exclusion beats inclusion', () => {
  assert.equal(matchesFilters(job(), { keywords: 'backend', exclude: 'postgres' }), false);
});

test('any included keyword is enough', () => {
  assert.equal(matchesFilters(job(), { keywords: 'frontend, backend' }), true);
  assert.equal(matchesFilters(job(), { keywords: 'frontend, mobile' }), false);
});

test('remoteOnly filters non-remote roles', () => {
  assert.equal(matchesFilters(job(), { remoteOnly: true }), true);
  assert.equal(matchesFilters(job({ remote: false }), { remoteOnly: true }), false);
});

test('a remote job satisfies any location filter', () => {
  assert.equal(matchesFilters(job(), { locations: 'berlin' }), true);
  assert.equal(
    matchesFilters(job({ remote: false, location: 'Austin, TX' }), { locations: 'berlin' }),
    false
  );
  assert.equal(
    matchesFilters(job({ remote: false, location: 'Berlin, DE' }), { locations: 'berlin' }),
    true
  );
});

test('a salary floor keeps jobs that publish no range', () => {
  assert.equal(matchesFilters(job(), { minSalary: 200000 }), true);
  assert.equal(matchesFilters(job(), { minSalary: 250000 }), false);
  // Unknown salary is kept - dropping these would discard most of the market.
  assert.equal(matchesFilters(job({ salaryMin: 0, salaryMax: 0 }), { minSalary: 250000 }), true);
});

test('an empty filter set matches everything', () => {
  assert.equal(matchesFilters(job(), {}), true);
  assert.equal(matchesFilters(job({ remote: false, location: '' }), {}), true);
});

// --- identifier validation -------------------------------------------------

test('board slugs accept real identifiers and reject path tricks', () => {
  assert.equal(validateSlug('stripe'), 'stripe');
  assert.equal(validateSlug('acme-corp_2'), 'acme-corp_2');
  for (const bad of ['../etc', 'a/b', 'has space', '', 'x'.repeat(70), 'https://evil.test']) {
    assert.throws(() => validateSlug(bad), SourceError, `should reject ${bad}`);
  }
});

test('feed URLs must be https and must not point inward', () => {
  assert.equal(
    validateFeedUrl('https://example.com/jobs.rss'),
    'https://example.com/jobs.rss'
  );
  for (const bad of [
    'http://example.com/jobs.rss', // plaintext
    'file:///etc/passwd',
    'https://localhost/jobs',
    'https://127.0.0.1/jobs',
    'https://10.0.0.5/jobs',
    'https://192.168.1.1/jobs',
    'https://172.16.0.1/jobs',
    'https://169.254.169.254/latest/meta-data/', // cloud metadata
    'https://build.internal/jobs',
    'https://user:pass@example.com/jobs',
    'not a url',
  ]) {
    assert.throws(() => validateFeedUrl(bad), SourceError, `should reject ${bad}`);
  }
});

test('a feed URL cannot be aimed back at our own host', () => {
  assert.throws(
    () => validateFeedUrl('https://job-board.io/api/jobs', { selfHost: 'job-board.io' }),
    SourceError
  );
});
