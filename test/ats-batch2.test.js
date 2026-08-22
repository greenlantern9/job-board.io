import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSource, ATS_KINDS, SourceError } from '../src/sources.js';

// Breezy, Gem and Loxo, written from captured live responses (kmg-prestige,
// fetch/mission, loxo/career-staffing-talent). Fixtures are those captures,
// trimmed.

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

test('breezy, gem and loxo count as ATS kinds', () => {
  for (const kind of ['breezy', 'gem', 'loxo']) {
    assert.ok(ATS_KINDS.includes(kind), kind + ' is not an ATS kind');
  }
});

test('breezy postings normalize from the live shape', async (t) => {
  withFetch(t, async () =>
    respond([
      {
        id: 'abc123',
        name: 'Accounts Payable Specialist - Lansing, MI',
        url: 'https://kmg-prestige.breezy.hr/p/8518e108461b-ap-specialist',
        published_date: '2026-08-11T15:34:30.765Z',
        location: { name: 'Lansing, MI', city: 'Lansing', is_remote: false, state: { id: 'MI', name: 'Michigan' } },
        type: { id: 'fullTime', name: 'Full-Time' },
        department: 'Lansing Support Center',
        company: { name: 'KMG Prestige', friendly_id: 'kmg-prestige' },
      },
      {
        id: 'def456',
        name: 'Remote Bookkeeper',
        url: 'https://kmg-prestige.breezy.hr/p/def456-bookkeeper',
        published_date: '2026-08-01T09:00:00.000Z',
        location: { name: 'Remote', city: '', is_remote: true },
        type: { id: 'partTime', name: 'Part-Time' },
      },
    ])
  );
  const jobs = await fetchSource({ kind: 'breezy', identifier: 'kmg-prestige' });
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].company, 'KMG Prestige');
  assert.equal(jobs[0].location, 'Lansing, MI');
  assert.equal(jobs[0].remote, false, 'a named city lost to nothing at all');
  assert.equal(jobs[0].postedAt.slice(0, 10), '2026-08-11');
  assert.equal(jobs[1].remote, true);
  assert.equal(jobs[0].employment, 'Full-Time');
});

test('gem postings normalize, and a missing board is an error - not an empty one', async (t) => {
  // A bad Gem slug still answers HTTP 200; the tell is jobBoardExternal null.
  // Without that check a mistyped board would be recorded as a verified quiet
  // company forever - the exact failure the Personio redirect bug caused.
  withFetch(t, async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.variables.boardId === 'ghost') {
      return respond({ data: { oatsExternalJobPostings: { jobPostings: [] }, jobBoardExternal: null } });
    }
    return respond({
      data: {
        oatsExternalJobPostings: {
          jobPostings: [
            {
              id: 'T2F0c0pvYlBvc3Q6MjcyMjg1NA==',
              extId: '7536752003',
              title: 'Senior Android Engineer I',
              locations: [{ name: 'Remote', city: '', isoCountry: 'USA', isRemote: true }],
              job: { department: { name: 'Technology' }, locationType: 'REMOTE', employmentType: 'FULL_TIME' },
            },
          ],
        },
        jobBoardExternal: { id: 'x', teamDisplayName: 'Fetch' },
      },
    });
  });

  const jobs = await fetchSource({ kind: 'gem', identifier: 'fetch' });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].company, 'Fetch');
  assert.equal(jobs[0].remote, true);
  assert.equal(jobs[0].url, 'https://jobs.gem.com/fetch/7536752003');
  assert.equal(jobs[0].employment, 'FULL_TIME');

  await assert.rejects(
    () => fetchSource({ kind: 'gem', identifier: 'ghost' }),
    (err) => err instanceof SourceError && /No such Gem board/.test(err.message)
  );
});

test('loxo XML normalizes: CDATA, RFC-822 dates, salary from description', async (t) => {
  const xml = `<?xml version="1.0" encoding="utf-8"?><jobs><job>
  <title><![CDATA[Business Development Representative]]></title>
  <date><![CDATA[Wed, 07 Aug 2024 05:00:00 +0000]]></date>
  <referencenumber><![CDATA[369896]]></referencenumber>
  <url><![CDATA[https://app.loxo.co/job/MjU4Mi14?source_type=indeed]]></url>
  <company><![CDATA[Loxo]]></company>
  <city><![CDATA[Denver]]></city>
  <state><![CDATA[Colorado]]></state>
  <country><![CDATA[United States]]></country>
  <salary><![CDATA[]]></salary>
  <description><![CDATA[<p>Sell the platform. $60,000 - $80,000 per year plus commission.</p>]]></description>
</job></jobs>`;
  withFetch(t, async () => respond(xml, { isText: true }));
  const jobs = await fetchSource({ kind: 'loxo', identifier: 'loxo' });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'Business Development Representative');
  assert.equal(jobs[0].location, 'Denver, Colorado, United States');
  assert.equal(jobs[0].postedAt.slice(0, 10), '2024-08-07', 'the RFC-822 date did not parse');
  assert.equal(jobs[0].salaryMin, 60000);
  assert.equal(jobs[0].salaryMax, 80000);
  assert.ok(jobs[0].description.includes('Sell the platform'));
});

test('an empty loxo feed reads as quiet, which is the honest floor', async (t) => {
  // The feed is populated only when the agency enabled Indeed distribution -
  // one probed agency had 40 jobs on its HTML board and an empty feed. Quiet
  // under-covers those agencies; anything else would misreport them.
  withFetch(t, async () => respond('<?xml version="1.0" encoding="utf-8"?><jobs></jobs>', { isText: true }));
  const jobs = await fetchSource({ kind: 'loxo', identifier: 'higher-people' });
  assert.deepEqual(jobs, []);
});
