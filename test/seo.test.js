import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const ld = (html) => {
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(m, 'no JSON-LD block found');
  return JSON.parse(m[1]); // throws if malformed - which is the test
};

test('the landing page carries valid structured data', () => {
  const graph = ld(read('../public/index.html'))['@graph'];
  const types = graph.map((n) => n['@type']);
  assert.ok(types.includes('WebSite'), 'WebSite node missing');
  assert.ok(types.includes('SoftwareApplication'), 'SoftwareApplication node missing');
  const app = graph.find((n) => n['@type'] === 'SoftwareApplication');
  assert.equal(app.offers.price, '0', 'the free offer is the searchable claim - keep it machine-readable');
});

test('social cards have an image that actually exists', () => {
  // Without og:image a shared link renders as bare text in every chat app and
  // feed - and shares are most of how a site this size gets seen.
  const idx = read('../public/index.html');
  assert.ok(idx.includes('og:image'), 'og:image gone from the landing page');
  assert.ok(idx.includes('summary_large_image'), 'twitter card gone');
  const png = fs.readFileSync(new URL('../public/assets/og.png', import.meta.url));
  assert.equal(png.slice(0, 8).toString('hex'), '89504e470d0a1a0a', 'og.png is not a PNG');
  assert.equal(png.readUInt32BE(16), 1200, 'og.png is not 1200 wide');
});

test('every FAQ schema answer appears in the visible page', () => {
  // Google's rule for FAQPage markup: the schema must mirror what a person
  // sees. Divergence is how rich results get revoked.
  const html = read('../public/faq.html');
  const visible = html.slice(0, html.indexOf('application/ld+json')).replace(/\s+/g, ' ');
  for (const q of ld(html).mainEntity) {
    assert.equal(q['@type'], 'Question');
    assert.ok(
      visible.includes(q.name.replace(/\\"/g, '"').replace(/\s+/g, ' ')),
      `question not visible on the page: ${q.name}`
    );
    const opening = q.acceptedAnswer.text.replace(/\\"/g, '"').replace(/\s+/g, ' ').slice(0, 60);
    assert.ok(visible.includes(opening), `answer diverges from the page: ${opening}`);
  }
});

test('the FAQ is routed, linked, and in the sitemap', () => {
  // html_handling is "none", so a page without a worker route 404s no matter
  // what links to it; a page without links is invisible to crawlers; a page
  // absent from the sitemap is discovered late or never.
  assert.ok(read('../worker.js').includes("url.pathname === '/faq'"), 'no worker route for /faq');
  assert.ok((read('../public/index.html').match(/href="\/faq"/g) || []).length >= 2, 'landing no longer links the FAQ');
  assert.ok(read('../public/sitemap.xml').includes('https://job-boards.io/faq</loc>'), 'FAQ missing from sitemap');
});

test('private surfaces stay out of the index the right way', () => {
  // The app carries noindex, so robots.txt must NOT disallow it: a crawler
  // that may not fetch a page can never see its noindex, and the bare URL can
  // be indexed anyway ("indexed, though blocked").
  const robots = read('../public/robots.txt');
  assert.ok(!/Disallow: \/app\b/.test(robots), '/app is disallowed again - its noindex becomes invisible');
  assert.ok(robots.includes('Disallow: /api/'), 'the API is open to crawlers');
  assert.ok(robots.includes('Sitemap: https://job-boards.io/sitemap.xml'), 'sitemap line gone');
  assert.ok(read('../public/app.html').includes('noindex'), 'app page lost its noindex');
  assert.ok(read('../public/admin.html').includes('noindex'), 'admin page lost its noindex');
});

test('no page is reachable as a raw .html file', () => {
  // The fallback hands any path naming a real file to the literal file server,
  // and the admin gate matches only the exact path '/admin' - so /admin.html
  // served the admin shell around the gate, live, until the fallback learned
  // to refuse .html outright. Losing this guard reopens that hole silently.
  const w = read('../worker.js');
  assert.ok(
    w.includes("url.pathname.endsWith('.html')"),
    'the fallback serves raw .html files again - /admin.html bypasses the gate'
  );
});

test('worker-rendered pages carry noindex themselves', () => {
  // Every htmlPage response is an error state, a token endpoint, or a 404.
  // robots.txt only stops the crawl, not the indexing - and token URLs arrive
  // in inboxes, where forwarding leaks them.
  assert.ok(
    read('../worker.js').includes('<meta name="robots" content="noindex">'),
    'htmlPage lost its noindex'
  );
});

test('account deletion removes every table that carries the user id', () => {
  // "Delete means delete" is published on the landing page and the FAQ. Four
  // tables were surviving it - job_events snapshots the profile headline and
  // skills into every application record, and profiles is the CV itself.
  const auth = read('../src/routes/auth.js');
  const batch = auth.slice(auth.indexOf('async function deleteAccount'));
  for (const table of [
    'jobs', 'sources', 'boards', 'notification_rules', 'notifications',
    'email_tokens', 'job_events', 'profiles', 'leads', 'feedback', 'sessions',
  ]) {
    assert.ok(
      batch.includes(`DELETE FROM ${table} WHERE user_id`),
      `deleteAccount no longer clears ${table} - the published promise is "delete means delete"`
    );
  }
});

test('title and description fit what a search result renders', () => {
  const idx = read('../public/index.html');
  const title = idx.match(/<title>([^<]*)<\/title>/)[1];
  const desc = idx.match(/name="description"\s+content="([^"]*)"/)[1];
  assert.ok(title.length <= 60, `title is ${title.length} chars; the SERP clips around 60`);
  assert.ok(desc.length <= 160, `description is ${desc.length} chars; Google truncates around 160`);
});
