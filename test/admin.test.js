import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { adminGate } from '../src/admin.js';

const OWNER = 'kyle.kortum@gmail.com';
const env = { ADMIN_EMAIL: OWNER };
const request = new Request('https://job-boards.io/admin');

// The account and session that should get in, so each test can spoil exactly
// one property and show that property is what carries the decision.
const ok = (over = {}) => ({
  user: { email: OWNER, totp_enabled: 1, is_admin: 1, ...over.user },
  session: { mfa_satisfied: 1, ...over.session },
});

test('the owner, with 2FA on and the admin flag, gets in', async () => {
  const result = await adminGate(env, request, ok());
  assert.equal(result.ok, true);
});

test('2FA alone is not enough - a different account is refused', async () => {
  // The thing being guarded against: any signed-in, 2FA-enabled account.
  const result = await adminGate(env, request, ok({ user: { email: 'someone@else.com', is_admin: 0 } }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-owner');
});

test('holding the admin address without the flag is refused', async () => {
  // The re-registration path: the old account was deleted, someone else signed
  // up with the address. Same email, different account, no flag.
  const result = await adminGate(env, request, ok({ user: { is_admin: 0 } }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-owner');
});

test('holding the flag without the address is refused', async () => {
  // Defence in depth: a stale flag left on an account cannot outlive a change
  // of owner.
  const result = await adminGate(env, request, ok({ user: { email: 'stale@example.com' } }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-owner');
});

test('the owner without 2FA switched on is refused', async () => {
  const result = await adminGate(env, request, ok({ user: { totp_enabled: 0 } }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'needs-2fa');
});

test('a half-authenticated session cannot reach admin', async () => {
  // Signed in but still owing a second factor.
  const result = await adminGate(env, request, ok({ session: { mfa_satisfied: 0 } }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'signed-out');
});

test('a signed-out visitor is refused', async () => {
  assert.equal((await adminGate(env, request, { user: null, session: null })).ok, false);
});

test('an unset ADMIN_EMAIL locks everyone out rather than letting anyone in', async () => {
  const result = await adminGate({}, request, ok());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-owner');
});

test('the address comparison ignores case and surrounding spaces', async () => {
  const result = await adminGate(
    { ADMIN_EMAIL: '  KYLE.KORTUM@Gmail.com ' },
    request,
    ok({ user: { email: 'Kyle.Kortum@GMAIL.com' } })
  );
  assert.equal(result.ok, true);
});

test('every sources endpoint is owner-only', async () => {
  // Hiding the sidebar button is presentation. These flags are the restriction,
  // and losing one would quietly reopen the whole surface to every account.
  const { APP_ROUTES } = await import('../src/routes/app.js');
  const sources = Object.entries(APP_ROUTES).filter(([key]) => key.includes('/api/sources'));
  assert.ok(sources.length >= 6, 'expected the sources routes to be present');
  const open = sources.filter(([, route]) => route.admin !== true).map(([key]) => key);
  assert.deepEqual(open, [], 'these sources routes are not owner-gated');
});

test('every profile endpoint is owner-only', async () => {
  // Same reasoning as sources, with one addition: /api/profile/parse spends a
  // model call on an uploaded CV, so an ungated one is a bill anybody can run
  // up as well as a surface nobody has tested yet.
  const { APP_ROUTES } = await import('../src/routes/app.js');
  const profile = Object.entries(APP_ROUTES).filter(([key]) => key.includes('/api/profile'));
  assert.ok(profile.length >= 3, 'expected the profile routes to be present');
  const open = profile.filter(([, route]) => route.admin !== true).map(([key]) => key);
  assert.deepEqual(open, [], 'these profile routes are not owner-gated');
});

test('the profile entry is not offered to everyone', async () => {
  // The button and the gate have to move together. If the entry point returns
  // to the list every account gets, ordinary users see a button that 403s.
  const app = fs.readFileSync(new URL('../public/assets/app.js', import.meta.url), 'utf8');
  assert.ok(
    !app.includes("navButton('Profile', openProfile),"),
    'Profile is back in the nav list every account receives'
  );
  assert.ok(
    app.includes("['profile-btn', 'Profile', openProfile]"),
    'Profile is missing from the owner-only entries'
  );
});

test('the unreleased views are owner-only, endpoints included', async () => {
  // Alerts, Insights and Applications are held back until they have been tested
  // and rolled out deliberately. Each route below is reached from exactly one of
  // those views and nowhere else, which is what makes gating them safe.
  const { APP_ROUTES } = await import('../src/routes/app.js');
  const held = [
    'GET /api/rules',
    'POST /api/rules/create',
    'POST /api/rules/update',
    'POST /api/rules/delete',
    'GET /api/notifications',
    'GET /api/insights',
    'GET /api/jobs/history',
    'GET /api/applications',
    'POST /api/jobs/followed-up',
  ];
  const open = held.filter((key) => {
    const route = APP_ROUTES[key];
    assert.ok(route, key + ' has gone missing from the routes table');
    return route.admin !== true;
  });
  assert.deepEqual(open, [], 'these routes are reachable by any signed-in account');
});

test('holding those views back does not touch the board itself', async () => {
  // The counterpart, and the one that matters most: a board has to keep working
  // for an ordinary account. Marking a job applied goes through
  // POST /api/jobs/update, which must not have been swept up in the gating.
  const { APP_ROUTES } = await import('../src/routes/app.js');
  for (const key of ['GET /api/jobs', 'POST /api/jobs/update', 'POST /api/jobs/bulk', 'GET /api/jobs/changes']) {
    assert.ok(APP_ROUTES[key], key + ' has gone missing');
    assert.notEqual(APP_ROUTES[key].admin, true, key + ' is gated but ordinary use needs it');
  }
});

test('the sidebar is built from the session, not at boot', async () => {
  // boot() runs before the session is known, so anything appended there is
  // offered to every account regardless of who they are. The held-back
  // destinations must not reappear at that point.
  const app = fs.readFileSync(new URL('../public/assets/app.js', import.meta.url), 'utf8');
  for (const label of ['Applications', 'Insights', 'Alerts', 'Sources', 'Profile']) {
    assert.ok(
      !app.includes(`navButton('${label}', open`),
      label + ' is being appended without checking the account'
    );
  }
  for (const id of ['applications-btn', 'insights-btn', 'alerts-btn', 'sources-btn', 'profile-btn']) {
    assert.ok(app.includes(`'${id}'`), id + ' is missing from the owner-only list');
  }
  assert.ok(
    app.includes("const everyone = [['feedback-btn', 'Send feedback', openFeedback]]"),
    'Send feedback should stay available to every account'
  );
});

test('ordinary board endpoints are not owner-gated', async () => {
  // The counterpart: the gate must not have been applied so broadly that normal
  // use needs admin.
  const { APP_ROUTES } = await import('../src/routes/app.js');
  assert.notEqual(APP_ROUTES['GET /api/boards'].admin, true);
  assert.notEqual(APP_ROUTES['POST /api/boards/create'].admin, true);
});

test('every connected platform is tracked, present or not', async () => {
  // The per-platform table is built from a GROUP BY over company_directory,
  // which silently omits any kind with no rows - and absent reads as 'not
  // connected', the wrong answer for a live connector waiting on employer
  // lists. The server merges ATS_KINDS in as zero rows; losing that merge
  // makes new platforms invisible exactly when someone asks whether they work.
  const admin = fs.readFileSync(new URL('../src/admin.js', import.meta.url), 'utf8');
  assert.ok(admin.includes("import { ATS_KINDS } from './sources.js'"), 'the kind roster import is gone');
  assert.ok(admin.includes('ATS_KINDS.filter((kind) => !seen.has(kind))'), 'zero-row platforms are omitted again');
  for (const metric of ['SUM(job_count) AS jobs', 'MAX(verified_at) AS last_read', 'AS quiet', 'AS slow']) {
    assert.ok(admin.includes(metric), 'per-platform metric missing: ' + metric);
  }
  const html = fs.readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
  assert.ok(html.includes('<th>Jobs live</th><th>Last read</th>'), 'the catalogue table lost its tracking columns');
});

test('field coverage includes every category, gaps most of all', async () => {
  // The visualization exists to show gaps, and a GROUP BY omits exactly those
  // rows - a field with no employers vanishes instead of being flagged, which
  // is how 'registered nurse returned nothing' stayed invisible. The server
  // merges the full CATEGORIES roster with the counted rows; the client names
  // the two gap kinds differently because they are different problems.
  const admin = fs.readFileSync(new URL('../src/admin.js', import.meta.url), 'utf8');
  assert.ok(admin.includes("import { CATEGORIES } from './categories.js'"), 'the category roster import is gone');
  assert.ok(admin.includes('CATEGORIES.map((cat) =>'), 'empty categories are omitted from coverage again');
  assert.ok(admin.includes('SUM(job_count) AS jobs FROM company_directory'), 'coverage lost its live-jobs measure');
  const client = fs.readFileSync(new URL('../public/assets/admin.js', import.meta.url), 'utf8');
  assert.ok(client.includes('no live openings'), 'the employers-but-no-jobs gap lost its label');
  assert.ok(client.includes('no employers at all'), 'the empty-field gap lost its label');
  const html = fs.readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
  assert.ok(html.includes('id="coverage"'), 'the coverage section is gone from the page');
});
