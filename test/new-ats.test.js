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
  // Dead tenants 307 to personio.com. The stub honours init.redirect the way
  // real fetch does: manual surfaces the 307; follow lands on a 200 marketing
  // page with no <position> blocks. The first version of this test returned
  // the 307 unconditionally - which passed while attempt() was clobbering the
  // connector's redirect:'manual' in production, so dead tenants were being
  // recorded as verified empty boards. A stub must not be more obedient than
  // the thing it stands in for.
  withFetch(t, async (url, init) => {
    if (init && init.redirect === 'manual') {
      return { ok: false, status: 307, statusText: 'Temporary Redirect', text: async () => '', json: async () => ({}) };
    }
    return { ok: true, status: 200, statusText: 'OK', text: async () => '<html><body>Marketing page</body></html>', json: async () => ({}) };
  });
  await assert.rejects(
    () => fetchSource({ kind: 'personio', identifier: 'gone-co' }),
    (err) => err instanceof SourceError && /No such Personio board/.test(err.message) && !err.transient
  );
});

test('a monthly recruitee salary is annualized, not stored as its face value', async (t) => {
  // European boards declare monthly figures. 3500/month stored as 3500/year
  // failed every salary floor - publishing a salary was strictly worse than
  // publishing none.
  withFetch(t, async () =>
    respond({
      offers: [
        {
          id: 7,
          title: 'Backend Engineer',
          status: 'published',
          careers_url: 'https://x/o/be',
          salary: { min: 3500, max: 4200, period: 'monthly', currency: 'EUR' },
        },
        {
          id: 8,
          title: 'Data Engineer',
          status: 'published',
          careers_url: 'https://x/o/de',
          // No period and a sub-10k number: too ambiguous to trust as annual.
          salary: { min: 4000, max: null, period: null, currency: null },
        },
        {
          id: 9,
          title: 'Platform Engineer',
          status: 'published',
          careers_url: 'https://x/o/pe',
          salary: { min: 95000, max: 120000, period: 'yearly', currency: 'EUR' },
        },
      ],
    })
  );
  const jobs = await fetchSource({ kind: 'recruitee', identifier: 'euro-co' });
  assert.equal(jobs[0].salaryMin, 42000, 'monthly minimum was not annualized');
  assert.equal(jobs[0].salaryMax, 50400, 'monthly maximum was not annualized');
  assert.ok(jobs[0].salaryRaw.includes('per monthly') || jobs[0].salaryRaw.includes('per month'), 'the raw string hides the true period');
  assert.equal(jobs[1].salaryMin, 0, 'an ambiguous sub-10k figure entered the annual filter');
  assert.equal(jobs[2].salaryMin, 95000);
  assert.equal(jobs[2].salaryMax, 120000);
});

test('a remote flag does not beat a named city', async (t) => {
  // The house rule every connector follows (remoteFrom): if the employer says
  // remote and also says Amsterdam, the specific claim is the actionable one.
  withFetch(t, async () =>
    respond({
      offers: [
        { id: 1, title: 'Engineer', status: 'published', remote: true, city: 'Amsterdam', location: 'Amsterdam, Netherlands', careers_url: 'https://x/o/1' },
        // A remote flag with only a country is remote-within-a-country, the
        // most common real shape - the country must not defeat the flag.
        { id: 2, title: 'Engineer', status: 'published', remote: true, country: 'Netherlands', location: 'Netherlands', careers_url: 'https://x/o/2' },
      ],
    })
  );
  const jobs = await fetchSource({ kind: 'recruitee', identifier: 'guard-co' });
  assert.equal(jobs[0].remote, false, 'a named city lost to the remote flag');
  assert.equal(jobs[1].remote, true, 'a flag with nowhere to contradict it should stand');
});

test('personio offices decode entities uniformly and survive a self-closing office', async (t) => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
<position>
    <id>1</id>
    <office/>
    <additionalOffices><office>Research &amp; Development Hub</office><office>D&#252;sseldorf</office></additionalOffices>
    <name>Engineer</name>
    <jobDescriptions></jobDescriptions>
</position>
</workzag-jobs>`;
  withFetch(t, async () => respond(xml, { isText: true }));
  const jobs = await fetchSource({ kind: 'personio', identifier: 'multi-co' });
  assert.equal(jobs.length, 1);
  // The old extraction let pick()'s lazy match run from <office/> through to
  // the next closing tag, capturing literal <additionalOffices> markup; the
  // extras also skipped decodeEntities, leaking &amp; and &#252; to readers.
  assert.equal(jobs[0].location, 'Research & Development Hub, D\u00fcsseldorf');
  assert.ok(!jobs[0].location.includes('<'), 'literal markup leaked into the location');
  assert.ok(!jobs[0].location.includes('&amp;'), 'XML escapes leaked into the location');
});

test('the euro sign and umlauts survive personio descriptions', async (t) => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
<position>
    <id>2</id>
    <office>M&uuml;nchen</office>
    <name>Engineer</name>
    <jobDescriptions><jobDescription><name>Pay</name>
    <value><![CDATA[<p>Bis zu 80.000 &euro; f&uuml;r erfahrene Bewerber.</p>]]></value>
    </jobDescription></jobDescriptions>
</position>
</workzag-jobs>`;
  withFetch(t, async () => respond(xml, { isText: true }));
  const jobs = await fetchSource({ kind: 'personio', identifier: 'de-co' });
  assert.equal(jobs[0].location, 'M\u00fcnchen');
  assert.ok(jobs[0].description.includes('80.000 \u20ac'), 'the euro entity survived undecoded');
  assert.ok(jobs[0].description.includes('f\u00fcr'), 'the umlaut entity survived undecoded');
});

test('personio rate limiting is transient, not a strike', async (t) => {
  withFetch(t, async () => ({ ok: false, status: 429, statusText: 'Too Many Requests', text: async () => '', json: async () => ({}) }));
  await assert.rejects(
    () => fetchSource({ kind: 'personio', identifier: 'busy-co' }),
    (err) => err instanceof SourceError && err.transient === true
  );
});
