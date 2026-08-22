import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSource, ATS_KINDS, SourceError } from '../src/sources.js';

// BambooHR, Rippling, Zoho Recruit and Jobvite, written from captured live
// responses (ebm, dgrsystems/trustlayer-inc, bruntwork/thehireboost,
// thriftbooks). Fixtures are those captures, trimmed.

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

test('the four new platforms count as ATS kinds', () => {
  for (const kind of ['bamboohr', 'rippling', 'zohorecruit', 'jobvite']) {
    assert.ok(ATS_KINDS.includes(kind), kind + ' is not an ATS kind');
  }
});

test('bamboohr normalizes, and a missing tenant redirect reads as gone', async (t) => {
  // Same trap as Personio: a missing tenant 302s to the marketing site rather
  // than 404ing. The stub honours init.redirect the way real fetch does.
  withFetch(t, async (url, init) => {
    if (String(url).includes('no-such')) {
      if (init && init.redirect === 'manual') {
        return { ok: false, status: 302, statusText: 'Found', json: async () => ({}), text: async () => '' };
      }
      return respond('<html>marketing</html>', { isText: true });
    }
    return respond({
      meta: { totalCount: 2 },
      result: [
        {
          id: '50',
          jobOpeningName: 'Ag Construction Crew/Millwright',
          departmentLabel: 'Construction',
          employmentStatusLabel: 'Full-Time',
          location: { city: 'Norfolk', state: 'Nebraska' },
          isRemote: null,
        },
        {
          id: '61',
          jobOpeningName: 'Data Analyst',
          employmentStatusLabel: 'Full-Time',
          location: { city: 'REMOTE', state: '' },
          isRemote: null,
        },
      ],
    });
  });

  const jobs = await fetchSource({ kind: 'bamboohr', identifier: 'ebm' });
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].location, 'Norfolk, Nebraska');
  assert.equal(jobs[0].url, 'https://ebm.bamboohr.com/careers/50');
  assert.equal(jobs[0].remote, false);
  // Some boards write REMOTE into the city instead of setting the flag.
  assert.equal(jobs[1].remote, true);
  assert.equal(jobs[0].employment, 'Full-Time');

  await assert.rejects(
    () => fetchSource({ kind: 'bamboohr', identifier: 'no-such-tenant' }),
    (err) => err instanceof SourceError && /No such BambooHR board/.test(err.message)
  );
});

test('rippling merges duplicate rows into one job with every location', async (t) => {
  // Multi-location jobs arrive as duplicate array entries sharing a uuid, one
  // per workLocation - measured live on trustlayer-inc.
  withFetch(t, async () =>
    respond([
      {
        uuid: 'aaa-111',
        name: 'Architect - AD Solutions',
        department: { label: 'Professional Services' },
        url: 'https://ats.rippling.com/dgrsystems/jobs/aaa-111',
        workLocation: { label: 'Remote (Tampa, Florida, US)' },
      },
      {
        uuid: 'aaa-111',
        name: 'Architect - AD Solutions',
        department: { label: 'Professional Services' },
        url: 'https://ats.rippling.com/dgrsystems/jobs/aaa-111',
        workLocation: { label: 'Remote (Atlanta, Georgia, US)' },
      },
      {
        uuid: 'bbb-222',
        name: 'Field Engineer',
        url: 'https://ats.rippling.com/dgrsystems/jobs/bbb-222',
        workLocation: { label: 'Tampa, Florida' },
      },
    ])
  );
  const jobs = await fetchSource({ kind: 'rippling', identifier: 'dgrsystems' });
  assert.equal(jobs.length, 2, 'duplicate uuid rows were not merged');
  assert.equal(jobs[0].location, 'Remote (Tampa, Florida, US), Remote (Atlanta, Georgia, US)');
  assert.equal(jobs[0].remote, true, 'the Remote(...) label is the only remote signal');
  assert.equal(jobs[1].remote, false);
});

test('zoho recruit filters locked openings and reads its US-format dates', async (t) => {
  withFetch(t, async () =>
    respond({
      code: 'success',
      data: [
        {
          id: '655395000258269177',
          Posting_Title: 'Contracts Analyst (Healthcare)',
          Remote_Job: 'Yes',
          Is_Locked: false,
          City: '',
          Job_Type: 'Full time',
          $url: 'https://bruntwork.zohorecruit.com/jobs/Careers/655395000258269177/x',
          Date_Opened: '08/17/2026',
          Job_Description: '<p>Review healthcare contracts. $30,000 - $40,000 per year.</p>',
        },
        {
          id: '999',
          Posting_Title: 'Filled Role',
          Is_Locked: true,
          $url: 'https://bruntwork.zohorecruit.com/jobs/Careers/999/y',
        },
      ],
    })
  );
  const jobs = await fetchSource({ kind: 'zohorecruit', identifier: 'bruntwork' });
  assert.equal(jobs.length, 1, 'a locked (filled) opening leaked through');
  assert.equal(jobs[0].remote, true);
  assert.equal(jobs[0].postedAt.slice(0, 10), '2026-08-17', 'the MM/DD/YYYY date did not parse');
  assert.equal(jobs[0].salaryMin, 30000);
  assert.ok(jobs[0].description.includes('Review healthcare contracts'));
});

test('jobvite runs its two-step flow and a wrong slug reads as gone', async (t) => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><result><job><id>oHJ45fwj</id><title>Warehouse Associate - Shipper</title><jobtype>Full-Time</jobtype><location>Aurora, IL, United States</location><date>5/28/2021</date><detail-url><![CDATA[https://app.jobvite.com/j?aj=oHJ45fwj]]></detail-url><description><![CDATA[<p>Ship the books. Pay: $18 - $22 per hour.</p>]]></description></job></result>`;
  withFetch(t, async (url, init) => {
    const u = String(url);
    if (u.includes('jobs.jobvite.com/no-such-board')) {
      return { ok: false, status: 302, statusText: 'Found', json: async () => ({}), text: async () => '' };
    }
    if (u.includes('jobs.jobvite.com/thriftbooks')) {
      return respond('<html><script>function getCompanyId() { return \'qIwaVfw3\'; }</script></html>', { isText: true });
    }
    if (u.includes('Xml.aspx?c=qIwaVfw3')) {
      return respond(xml, { isText: true });
    }
    throw new Error('unexpected url: ' + u);
  });

  const jobs = await fetchSource({ kind: 'jobvite', identifier: 'thriftbooks' });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'Warehouse Associate - Shipper');
  assert.equal(jobs[0].location, 'Aurora, IL, United States');
  assert.equal(jobs[0].postedAt.slice(0, 10), '2021-05-28');
  assert.equal(jobs[0].url, 'https://app.jobvite.com/j?aj=oHJ45fwj');
  assert.ok(jobs[0].description.includes('Ship the books'));

  await assert.rejects(
    () => fetchSource({ kind: 'jobvite', identifier: 'no-such-board' }),
    (err) => err instanceof SourceError && /No such Jobvite board/.test(err.message)
  );
});
