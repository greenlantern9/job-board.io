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
  safeExternalUrl,
  truncate,
  normalizeCompany,
  companyMatches,
  fetchSource,
  matchesQuery,
  _compileQuery,
  SOURCE_KINDS,
  ATS_KINDS,
  AGGREGATOR_KINDS,
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

test('double-encoded markup does not survive as visible text', () => {
  // A feed sending &lt;div&gt; has no literal tags to strip, so a single
  // strip-then-decode pass turned it back into markup the user could see in the
  // job description. Two passes are required, and this pins that.
  assert.equal(htmlToText('&lt;div class="x"&gt;Real text&lt;/div&gt;'), 'Real text');
  assert.equal(htmlToText('&lt;style&gt;.a{color:red}&lt;/style&gt;Real text'), 'Real text');
  assert.equal(htmlToText('Before &lt;script&gt;alert(1)&lt;/script&gt; after'), 'Before after');
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

// --- minimum seniority -----------------------------------------------------

test('minimum level drops titles that state a lower one', () => {
  assert.equal(matchesFilters(job({ title: 'Junior Backend Engineer' }), { minSeniority: 3 }), false);
  assert.equal(matchesFilters(job({ title: 'Backend Engineering Intern' }), { minSeniority: 3 }), false);
  assert.equal(matchesFilters(job({ title: 'Senior Backend Engineer' }), { minSeniority: 3 }), true);
  assert.equal(matchesFilters(job({ title: 'Staff Backend Engineer' }), { minSeniority: 3 }), true);
  assert.equal(matchesFilters(job({ title: 'Principal Engineer' }), { minSeniority: 3 }), true);
});

test('a title stating no level survives the minimum', () => {
  // The important case: plenty of senior roles are titled just this, and
  // dropping them would gut the board.
  assert.equal(matchesFilters(job({ title: 'Software Engineer' }), { minSeniority: 3 }), true);
  assert.equal(matchesFilters(job({ title: 'Backend Engineer' }), { minSeniority: 5 }), true);
});

test('a minimum of zero excludes nothing', () => {
  assert.equal(matchesFilters(job({ title: 'Engineering Intern' }), { minSeniority: 0 }), true);
});

// --- curated companies -----------------------------------------------------

test('company names match across slug, display name, and legal suffix', () => {
  assert.equal(normalizeCompany('Acme Corp, Inc.'), 'acme');
  assert.equal(companyMatches('gitlab', ['GitLab']), true);
  assert.equal(companyMatches('GitLab Inc.', ['gitlab']), true);
  assert.equal(companyMatches('stripe', ['Stripe Payments']), true);
  assert.equal(companyMatches('1Password', ['1password']), true);
  assert.equal(companyMatches('shopify', ['Stripe', 'Linear']), false);
  assert.equal(companyMatches('', ['Stripe']), false);
});

test('limit mode makes the company list an allowlist', () => {
  const filters = { companies: 'Stripe, Linear', companyMode: 'limit' };
  assert.equal(matchesFilters(job({ company: 'stripe' }), filters), true);
  assert.equal(matchesFilters(job({ company: 'linear' }), filters), true);
  assert.equal(matchesFilters(job({ company: 'acme' }), filters), false);
});

test('prioritize mode excludes nobody', () => {
  const filters = { companies: 'Stripe, Linear', companyMode: 'prioritize' };
  assert.equal(matchesFilters(job({ company: 'acme' }), filters), true);
  assert.equal(matchesFilters(job({ company: 'stripe' }), filters), true);
});

test('an empty company list never filters, whatever the mode', () => {
  assert.equal(matchesFilters(job({ company: 'acme' }), { companies: '', companyMode: 'limit' }), true);
  assert.equal(matchesFilters(job({ company: 'acme' }), { companies: '  ,  ', companyMode: 'limit' }), true);
});

// --- posting age -----------------------------------------------------------

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

test('age ceiling drops old postings but keeps undated ones', () => {
  assert.equal(matchesFilters(job({ postedAt: daysAgo(3) }), { maxAgeDays: 7 }), true);
  assert.equal(matchesFilters(job({ postedAt: daysAgo(20) }), { maxAgeDays: 7 }), false);
  // Many feeds omit the date entirely; excluding them would hide real jobs.
  assert.equal(matchesFilters(job({ postedAt: '' }), { maxAgeDays: 7 }), true);
  assert.equal(matchesFilters(job({ postedAt: daysAgo(200) }), {}), true);
});

// --- source coverage -------------------------------------------------------

test('the connector set covers per-company boards and cross-company aggregators', () => {
  // The aggregators are what stop a board being limited to the dozen employers
  // discovery happened to pick.
  for (const kind of ['greenhouse', 'lever', 'ashby', 'smartrecruiters']) {
    assert.ok(SOURCE_KINDS.includes(kind), `${kind} should be a source kind`);
    assert.ok(ATS_KINDS.includes(kind), `${kind} should be probed during discovery`);
  }
  for (const kind of AGGREGATOR_KINDS) {
    assert.ok(SOURCE_KINDS.includes(kind), `${kind} should be a source kind`);
    assert.ok(!ATS_KINDS.includes(kind), `${kind} is not a per-company board`);
  }
  assert.ok(SOURCE_KINDS.includes('rss'));
});

test('an unknown source kind is rejected rather than silently returning nothing', async () => {
  await assert.rejects(
    () => fetchSource({ kind: 'nonsense', identifier: 'x' }),
    /Unknown source type/
  );
});

// --- aggregator query matching ---------------------------------------------
// These pin the rules that stopped a search for a technical program manager
// returning shop assistants.

const q = (query) => _compileQuery(query);
const hits = (query, title, body = '') => matchesQuery(title, body, q(query));

test('a single query word must appear as a word, not a substring', () => {
  // "go" inside "category"/"Chicago" is what made short terms match everything.
  assert.equal(hits('go', 'Go Engineer'), true);
  assert.equal(hits('go', 'Category Manager'), false);
  assert.equal(hits('go', 'Chicago Sales Lead'), false);
});

test('a multi-word term needs all its words, in any order', () => {
  assert.equal(hits('technical program manager', 'Technical Program Manager'), true);
  // Adjacency is not required - this is plainly the same role.
  assert.equal(hits('technical program manager', 'Program Manager, Technical Infrastructure'), true);
  // One word of three is not a match.
  assert.equal(hits('technical program manager', 'Store Manager'), false);
  assert.equal(hits('technical program manager', 'Senior Product Manager'), false);
});

test('one word out of several is never enough on its own', () => {
  assert.equal(hits('senior, backend, engineer, golang', 'Senior Account Executive'), false);
  assert.equal(hits('senior, backend, engineer, golang', 'Store Manager'), false);
  assert.equal(hits('senior, backend, engineer, golang', 'Senior Backend Engineer'), true);
});

test('a single-term query still matches on the title alone', () => {
  assert.equal(hits('engineer', 'Security Engineer'), true);
  assert.equal(hits('engineer', 'Store Manager'), false);
});

test('body text alone cannot carry a single-term query', () => {
  // Otherwise every posting whose description happens to say the words wins.
  assert.equal(
    hits('technical program manager', 'Commercial Account Executive', 'our technical program manager will...'),
    false
  );
});

test('body text needs several corroborating signals to carry a query', () => {
  // Deliberately strict. A description mentions all sorts of things in passing,
  // so a generic title plus body hits has to clear a higher bar than a title
  // match: two distinct terms AND a combined weight of three.
  const body = (text) => hits('backend, golang, kubernetes', 'Software Engineer', text);
  assert.equal(body('Golang and Kubernetes on our backend services.'), true, 'three signals');
  assert.equal(body('You will write Golang against Kubernetes.'), false, 'two is not enough');
  assert.equal(body('You will write Golang.'), false, 'one is certainly not');

  // A multi-word term is worth more, so it needs only one word alongside it.
  assert.equal(
    hits('senior backend engineer, kubernetes', 'Software Engineer', 'A senior backend engineer working on Kubernetes.'),
    true
  );
});

test('undiscriminating words are dropped, but not inside a phrase', () => {
  // "remote" matches every posting on a remote-only board.
  assert.equal(q('remote').length, 0);
  assert.equal(q('remote support lead').length, 1);
  assert.equal(q('remote, backend').length, 1);
});

test('an empty query matches nothing rather than everything', () => {
  assert.equal(matchesQuery('Anything At All', 'body', []), false);
  assert.equal(hits('', 'Anything At All'), false);
});

test('terms with punctuation survive escaping', () => {
  assert.equal(hits('c++', 'C++ Engineer'), true);
  assert.equal(hits('.net', '.NET Developer'), true);
  assert.equal(hits('c++', 'Java Engineer'), false);
});

// --- platform limits -------------------------------------------------------

test('IN-clause chunks stay inside D1 bound-parameter cap', async () => {
  // D1 rejects more than 100 bound parameters per statement at runtime, not at
  // build time - a chunk of exactly 100 plus one board id is what broke this.
  const { D1_MAX_BOUND_PARAMS, IN_CHUNK } = await import('../src/ingest.js');
  assert.equal(D1_MAX_BOUND_PARAMS, 100);
  assert.ok(IN_CHUNK < D1_MAX_BOUND_PARAMS, 'chunk must leave room for other bindings');
});

// --- refresh cadence -------------------------------------------------------

test('scheduled refresh cannot be scheduled more than once a day', async () => {
  const { MIN_REFRESH_MINUTES } = await import('../src/ingest.js');
  assert.equal(MIN_REFRESH_MINUTES, 1440);
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

// --- URLs arriving inside third-party data ---------------------------------
// Job links come from feeds, get fetched by the link checker, and get rendered
// as anchors. Both are execution surfaces if the scheme is not constrained.

test('only http(s) job URLs survive sanitising', () => {
  assert.equal(safeExternalUrl('https://boards.greenhouse.io/x/jobs/1'), 'https://boards.greenhouse.io/x/jobs/1');
  assert.ok(safeExternalUrl('http://example.com/job').startsWith('http://'));

  for (const bad of [
    'javascript:alert(document.cookie)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'vbscript:msgbox(1)',
    '',
    null,
    undefined,
    'not a url',
  ]) {
    assert.equal(safeExternalUrl(bad), '', `should reject ${String(bad).slice(0, 30)}`);
  }
});

test('a job URL cannot point at a private address', () => {
  // The link checker fetches these from inside the Worker, so an aggregator
  // could otherwise use its own data as an SSRF primitive.
  for (const bad of [
    'http://localhost:8787/api/boards',
    'http://127.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.1.2.3/',
    'http://192.168.0.1/',
    'http://172.16.5.4/',
    'https://build.internal/secrets',
    'https://user:pass@example.com/job',
  ]) {
    assert.equal(safeExternalUrl(bad), '', `should reject ${bad}`);
  }
});

test('a job URL cannot be aimed back at this deployment', () => {
  assert.equal(
    safeExternalUrl('https://job-boards.io/api/account/delete', { selfHost: 'job-boards.io' }),
    ''
  );
});

test('a feed URL cannot be aimed back at our own host', () => {
  assert.throws(
    () => validateFeedUrl('https://job-boards.io/api/jobs', { selfHost: 'job-boards.io' }),
    SourceError
  );
});
