import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSource, ATS_KINDS, SourceError } from '../src/sources.js';

// Recruitee, Workable and Personio connectors, written from captured live
// responses (bunq, blueground, everphone) rather than the platforms'
// documentation. The fixtures below are those captures, trimmed.

const respond = (body, { status = 200, isText = false } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : 'Error',
  json: async () => body,
  text: async () => (isText ? body : JSON.stringify(body)),
});

const withFetch = (t, fn) => {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  t.after(() => {
    globalThis.fetch = original;
  });
};

test('the three new platforms count as ATS kinds', () => {
  // Membership decides delisting semantics: presence on the company's own
  // board proves the job is live.
  for (const kind of ['recruitee', 'workable', 'personio']) {
    assert.ok(ATS_KINDS.includes(kind), kind + ' is not an ATS kind');
  }
});

test('recruitee offers normalize, and drafts are dropped', async (t) => {
  withFetch(t, async () =>
    respond({
      offers: [
        {
          id: 1,
          title: 'Technology Risk Officer',
          status: 'published',
          company_name: 'bunq',
          location: 'Amsterdam, Noord-Holland, Netherlands',
          remote: false,
          hybrid: true,
          careers_url: 'https://careers.bunq.com/o/technology-risk-officer',
          published_at: '2026-08-10 11:14:25 UTC',
          description: '<p>Own the risk framework.</p>',
          salary: { min: null, max: null, period: null, currency: null },
        },
        { id: 2, title: 'Draft role', status: 'draft', careers_url: 'x' },
        {
          id: 3,
          title: 'Remote Support Agent',
          status: 'published',
          remote: true,
          location: '',
          careers_url: 'https://careers.bunq.com/o/support',
          created_at: '2026-08-01 08:00:00 UTC',
        },
      ],
    })
  );

  const jobs = await fetchSource({ kind: 'recruitee', identifier: 'bunq' });
  assert.equal(jobs.length, 2, 'the draft leaked through');
  assert.equal(jobs[0].company, 'bunq');
  assert.equal(jobs[0].url, 'https://careers.bunq.com/o/technology-risk-officer');
  // hybrid is not remote: the live sample showed hybrid roles with remote false.
  assert.equal(jobs[0].remote, false);
  assert.equal(jobs[1].remote, true);
  // "2026-08-10 11:14:25 UTC" must become a real ISO date, not ''.
  assert.equal(jobs[0].postedAt.slice(0, 10), '2026-08-10');
  assert.ok(jobs[0].description.includes('risk framework'));
});

test('workable jobs normalize, telecommuting is the remote flag', async (t) => {
  withFetch(t, async () =>
    respond({
      name: 'Blueground',
      jobs: [
        {
          title: 'Business Development Representative',
          shortcode: '0FD01ABC66',
          telecommuting: true,
          employment_type: 'Full-time',
          url: 'https://apply.workable.com/j/0FD01ABC66',
          published_on: '2026-08-18',
          country: 'United States',
          city: '',
          state: '',
        },
        {
          title: 'Warehouse Associate',
          shortcode: 'C32BE65B0A',
          telecommuting: false,
          url: 'https://apply.workable.com/j/C32BE65B0A',
          published_on: '2025-10-21',
          country: 'United States',
          city: 'Visalia',
          state: 'California',
        },
      ],
    })
  );

  const jobs = await fetchSource({ kind: 'workable', identifier: 'blueground' });
  assert.equal(jobs.length, 2);
  // The account's display name, not the slug: the payload carries it.
  assert.equal(jobs[0].company, 'Blueground');
  assert.equal(jobs[0].remote, true);
  assert.equal(jobs[1].remote, false);
  assert.equal(jobs[1].location, 'Visalia, California, United States');
  assert.equal(jobs[0].postedAt.slice(0, 10), '2026-08-18');
  // The widget list has no descriptions; ranking falls to the title, which is
  // the same posture as an unhydrated greenhouse posting.
  assert.equal(jobs[0].description, '');
});

test('personio XML parses: CDATA descriptions, offices, and the built URL', async (t) => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
<position>
    <id>2019718</id>
    <office>Berlin</office>
    <additionalOffices><office>Munich</office></additionalOffices>
    <department>Sales</department>
    <name>Account Executive (w/m/d)</name>
    <jobDescriptions>
        <jobDescription>
            <name>The role</name>
            <value><![CDATA[<p>Drive our &amp; expansion with a &euro;60,000 base.</p>]]></value>
        </jobDescription>
    </jobDescriptions>
    <employmentType>permanent</employmentType>
    <schedule>full-time</schedule>
    <createdAt>2025-03-17T10:00:00+01:00</createdAt>
</position>
<position>
    <id>2738983</id>
    <office>Remote</office>
    <name>Werkstudent Legal</name>
    <jobDescriptions></jobDescriptions>
    <createdAt>2026-08-03T09:00:00+02:00</createdAt>
</position>
</workzag-jobs>`;
  withFetch(t, async () => respond(xml, { isText: true }));

  const jobs = await fetchSource({ kind: 'personio', identifier: 'everphone' });
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].title, 'Account Executive (w/m/d)');
  assert.equal(jobs[0].location, 'Berlin, Munich');
  assert.equal(jobs[0].url, 'https://everphone.jobs.personio.de/job/2019718');
  assert.ok(jobs[0].description.includes('Drive our & expansion'), 'CDATA/entities not decoded');
  assert.equal(jobs[0].postedAt.slice(0, 10), '2025-03-17');
  // An office literally named Remote is the platform's only remote signal.
  assert.equal(jobs[1].remote, true);
  // Empty jobDescriptions is common on this platform (5 of 6 live everphone
  // positions) - it must produce an empty description, not a crash.
  assert.equal(jobs[1].description, '');
});

test('a missing personio tenant redirects, and reads as gone - not as garbage', async (t) => {
  // Dead tenants 307 to personio.com. Following that lands on a marketing page
  // that would read as "invalid response" and count strikes confusingly.
  withFetch(t, async () => ({ ok: false, status: 307, statusText: 'Temporary Redirect', text: async () => '', json: async () => ({}) }));
  await assert.rejects(
    () => fetchSource({ kind: 'personio', identifier: 'gone-co' }),
    (err) => err instanceof SourceError && /No such Personio board/.test(err.message) && !err.transient
  );
});

test('personio rate limiting is transient, not a strike', async (t) => {
  withFetch(t, async () => ({ ok: false, status: 429, statusText: 'Too Many Requests', text: async () => '', json: async () => ({}) }));
  await assert.rejects(
    () => fetchSource({ kind: 'personio', identifier: 'busy-co' }),
    (err) => err instanceof SourceError && err.transient === true
  );
});
