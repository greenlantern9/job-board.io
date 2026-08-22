import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSource, ATS_KINDS, SourceError } from '../src/sources.js';

// Workday and Taleo, written from captured live responses (intel/ctran/nc,
// percepta/starbucks/fao). Both use compound identifiers because neither
// platform is addressable by one slug - and both were probed with wrong parts
// to pin what each failure looks like.

const respond = (body, { status = 200 } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: 'X',
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const withFetch = (t, fn) => {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  t.after(() => {
    globalThis.fetch = original;
  });
};

test('workday and taleo count as ATS kinds', () => {
  for (const kind of ['workday', 'taleo']) {
    assert.ok(ATS_KINDS.includes(kind), kind + ' is not an ATS kind');
  }
});

test('workday pages at twenty and reads total only from the first page', async (t) => {
  // limit > 20 is a hard 400 on this API, and deep pages were observed
  // returning total: 0 beside real postings - trusting a later total would end
  // the walk early.
  const calls = [];
  withFetch(t, async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    assert.equal(body.limit, 20, 'limit above twenty is a hard 400 in production');
    const page = body.offset / 20;
    const make = (i) => ({
      title: 'Engineer ' + i,
      externalPath: '/job/US/Engineer_' + i,
      locationsText: 'Phoenix, AZ',
      postedOn: 'Posted Yesterday',
    });
    if (page === 0) return respond({ total: 45, jobPostings: Array.from({ length: 20 }, (_, i) => make(i)) });
    if (page === 1) return respond({ total: 0, jobPostings: Array.from({ length: 20 }, (_, i) => make(20 + i)) });
    return respond({ total: 0, jobPostings: Array.from({ length: 5 }, (_, i) => make(40 + i)) });
  });

  const jobs = await fetchSource({ kind: 'workday', identifier: 'intel.wd1.External' });
  assert.equal(jobs.length, 45, 'the deep-page total:0 quirk ended the walk early');
  assert.equal(calls.length, 3);
  assert.equal(jobs[0].url, 'https://intel.wd1.myworkdayjobs.com/External/job/US/Engineer_0');
  assert.equal(jobs[0].postedAt.slice(0, 10), new Date(Date.now() - 86400000).toISOString().slice(0, 10));
});

test('workday failure modes are distinct: wrong cluster vs wrong site', async (t) => {
  // Wildcard DNS makes every {tenant}.{wdN} host resolve, so the cluster can
  // only be judged by the answer: 422 means wrong tenant/cluster, 404 means
  // the tenant is real and the site is not.
  withFetch(t, async (url) => {
    if (String(url).includes('.wd5.')) return respond({}, { status: 422 });
    return respond({}, { status: 404 });
  });
  await assert.rejects(
    () => fetchSource({ kind: 'workday', identifier: 'intel.wd5.External' }),
    (e) => e instanceof SourceError && /tenant on this cluster/.test(e.message)
  );
  await assert.rejects(
    () => fetchSource({ kind: 'workday', identifier: 'intel.wd1.Nope' }),
    (e) => e instanceof SourceError && /site on this tenant/.test(e.message)
  );
});

test('workday rejects a malformed identifier before fetching anything', async (t) => {
  withFetch(t, async () => {
    throw new Error('should not fetch');
  });
  await assert.rejects(
    () => fetchSource({ kind: 'workday', identifier: 'intel' }),
    (e) => e instanceof SourceError && /tenant\.cluster\.site/.test(e.message)
  );
});

test('taleo reads tenant-configured columns and sends the load-bearing header', async (t) => {
  let sawTz = false;
  withFetch(t, async (url, init) => {
    // Without a timezone header the real server answers 500 "An Error
    // Occurred in TEE" - the one non-obvious requirement.
    sawTz = Boolean(init.headers.tzname || init.headers.tz);
    return respond({
      pagingData: { currentPageNo: 1, pageSize: 25, totalCount: 2 },
      requisitionList: [
        {
          jobId: '494026',
          contestNo: '40854',
          column: ['Simulation Senior Professional', '["Colorado Springs"]', 'Aug 21, 2026'],
          linkedColumn: 0,
          locationsColumns: [1],
        },
        {
          jobId: '494027',
          contestNo: '40855',
          column: ['Field Tech', 'Multiple Locations', 'Aug 20, 2026'],
          linkedColumn: 0,
          locationsColumns: [1],
        },
      ],
    });
  });

  const jobs = await fetchSource({ kind: 'taleo', identifier: 'cu.101430233.2' });
  assert.ok(sawTz, 'the timezone header is gone - production answers 500 without it');
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].title, 'Simulation Senior Professional');
  // JSON-encoded location arrays and plain text both occur across tenants.
  assert.equal(jobs[0].location, 'Colorado Springs');
  assert.equal(jobs[1].location, 'Multiple Locations');
  assert.equal(jobs[0].postedAt.slice(0, 10), '2026-08-21');
  assert.ok(jobs[0].url.includes('/careersection/2/jobdetail.ftl?job=494026'));
});

test('a wrong taleo portal is a 200 with a flag, and reads as gone', async (t) => {
  withFetch(t, async () => respond({ requisitionList: null, careerSectionUnAvailable: true }));
  await assert.rejects(
    () => fetchSource({ kind: 'taleo', identifier: 'percepta.999999.2' }),
    (e) => e instanceof SourceError && /career section unavailable/.test(e.message)
  );
});
