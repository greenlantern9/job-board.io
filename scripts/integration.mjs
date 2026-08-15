// End-to-end smoke test against a running dev server.
//
// Lives outside test/ on purpose: node --test treats everything under that
// directory as a unit test, and this one needs a running server and talks to
// the real Greenhouse API. Run it alongside `npx wrangler dev`:
//
//   npm run test:e2e
//
// It exercises the whole path a person walks on day one: sign up, create a
// board, connect a source, pull and rank real jobs, move one through the
// pipeline, turn on 2FA, sign out, sign back in through the TOTP challenge,
// create an alert, then delete the account.

import { totp } from '../src/totp.js';

const BASE = process.env.JB_BASE || 'http://localhost:8787';
const email = `test-${Date.now()}@example.com`;
const password = 'integration-test-password-1';

let cookie = '';
let passed = 0;
const failures = [];
const state = { boardsMade: 1 };

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      // The Worker requires a same-origin Origin header on mutations.
      Origin: BASE,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  let payload = {};
  try {
    payload = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, payload };
}

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? ` :: ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
  }
}

const section = (name) => console.log(`\n${name}`);

// --- run -------------------------------------------------------------------

section('accounts');
{
  const weak = await call('/api/auth/signup', { method: 'POST', body: { email, password: 'short' } });
  check('a short password is rejected', weak.status === 400, weak.payload);

  const bad = await call('/api/auth/signup', { method: 'POST', body: { email: 'nope', password } });
  check('an invalid email is rejected', bad.status === 400, bad.payload);

  const signup = await call('/api/auth/signup', { method: 'POST', body: { email, password } });
  check('signup succeeds', signup.status === 200 && signup.payload.user, signup.payload);
  check('signup returns no secrets', !JSON.stringify(signup.payload).includes('pbkdf2'));

  const session = await call('/api/auth/session');
  check('session resolves to the new user', session.payload.user?.email === email, session.payload);

  // Signing up again with the same address must not confirm it is taken.
  const saved = cookie;
  cookie = '';
  const dupe = await call('/api/auth/signup', { method: 'POST', body: { email, password } });
  check('a duplicate signup does not reveal the account exists', dupe.status === 200 && !dupe.payload.user, dupe.payload);
  cookie = saved;
}

section('csrf + authorization');
{
  const res = await fetch(`${BASE}/api/boards/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.test', Cookie: cookie },
    body: JSON.stringify({ name: 'x' }),
  });
  check('a cross-origin mutation is refused', res.status === 403);

  const noJson = await fetch(`${BASE}/api/boards/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE, Cookie: cookie },
    body: 'name=x',
  });
  check('a form-encoded mutation is refused', noJson.status === 400);

  const anon = await fetch(`${BASE}/api/boards`, { headers: { Accept: 'application/json' } });
  check('boards require a session', anon.status === 401);
}

let boardId;
section('boards');
{
  const created = await call('/api/boards/create', {
    method: 'POST',
    body: {
      name: 'Integration board',
      prompt: 'Senior backend and infrastructure roles. Remote preferred. Go, Rust, or TypeScript.',
      filters: { remoteOnly: false, minSalary: 0, seniority: 3 },
      refreshMode: 'manual',
    },
  });
  boardId = created.payload.board?.id;
  check('board created', created.status === 200 && boardId, created.payload);

  const list = await call('/api/boards');
  check('board appears in the list', list.payload.boards?.some((b) => b.id === boardId));

  const foreign = await call('/api/boards/update', { method: 'POST', body: { id: 'brd_not_mine', name: 'x' } });
  check("another user's board id is rejected", foreign.status === 404, foreign.payload);

  // The ceiling is what bounds cost, so it is worth proving rather than
  // trusting the dropdown.
  const listed = await call('/api/boards');
  const max = listed.payload.maxBoards;
  check('the board ceiling is advertised to the client', max === 3, listed.payload);

  const extras = [];
  for (let i = state.boardsMade || 1; i < max; i++) {
    const made = await call('/api/boards/create', {
      method: 'POST',
      body: { name: `Filler ${i}`, prompt: 'backend engineering roles, remote' },
    });
    extras.push(made.status);
  }
  check('boards up to the ceiling are accepted', extras.every((s) => s === 200), extras);

  const overflow = await call('/api/boards/create', {
    method: 'POST',
    body: { name: 'One too many', prompt: 'backend engineering roles, remote' },
  });
  check('creating past the ceiling is refused', overflow.status === 400, overflow.payload);
  check(
    'the refusal says what to do about it',
    /delete one/i.test(overflow.payload.error || ''),
    overflow.payload
  );

  // Put the account back to one board so the rest of the run is unaffected.
  const all = await call('/api/boards');
  for (const b of (all.payload.boards || []).filter((b) => b.id !== boardId)) {
    await call('/api/boards/delete', { method: 'POST', body: { id: b.id } });
  }
}

section('sources');
{
  const bad = await call('/api/sources/create', {
    method: 'POST',
    body: { boardId, kind: 'rss', identifier: 'https://127.0.0.1/feed' },
  });
  check('an SSRF feed URL is refused', bad.status === 400, bad.payload);

  const probe = await call('/api/sources/test', {
    method: 'POST',
    body: { kind: 'greenhouse', identifier: 'gitlab' },
  });
  check('a live Greenhouse board can be reached', probe.payload.ok === true, probe.payload);
  if (probe.payload.ok) console.log(`       -> ${probe.payload.count} open roles`);

  const added = await call('/api/sources/create', {
    method: 'POST',
    body: { boardId, kind: 'greenhouse', identifier: 'gitlab', label: 'GitLab' },
  });
  check('source added', added.status === 200, added.payload);

  const dupe = await call('/api/sources/create', {
    method: 'POST',
    body: { boardId, kind: 'greenhouse', identifier: 'gitlab' },
  });
  check('a duplicate source is refused', dupe.status === 400, dupe.payload);
}

section('ingest + ranking');
{
  const refreshed = await call('/api/boards/refresh', { method: 'POST', body: { id: boardId } });
  check('refresh completes', refreshed.status === 200, refreshed.payload);
  const summary = refreshed.payload.summary || {};
  console.log(`       -> fetched ${summary.fetched}, added ${summary.added}, filtered ${summary.filteredOut}`);
  check('jobs were ingested', summary.added > 0, summary);

  const jobs = await call(`/api/jobs?boardId=${boardId}`);
  const rows = jobs.payload.jobs || [];
  check('jobs are readable', rows.length > 0);
  check('every job is scored 0-100', rows.every((j) => j.score >= 0 && j.score <= 100));
  check('every job has a reason', rows.every((j) => j.scoreReason.length > 0));
  check(
    'jobs come back highest score first',
    rows.every((j, i) => i === 0 || rows[i - 1].score >= j.score)
  );

  const first = rows[0];
  if (first) {
    console.log(`       -> top: ${first.score} ${first.title} (${first.scoredBy})`);
    const moved = await call('/api/jobs/update', { method: 'POST', body: { id: first.id, status: 'applied' } });
    check('a job can be moved to applied', moved.payload.job?.status === 'applied', moved.payload);
    check('applied_at is stamped', Boolean(moved.payload.job?.appliedAt));

    const noted = await call('/api/jobs/update', { method: 'POST', body: { id: first.id, notes: 'spoke to recruiter' } });
    check('notes persist', noted.payload.job?.notes === 'spoke to recruiter');

    const changes = await call(`/api/jobs/changes?boardId=${boardId}&since=1970-01-01T00:00:00.000Z`);
    check('the changes feed returns updated rows', (changes.payload.changed || []).length > 0);
  }
}

section('alerts');
{
  const rule = await call('/api/rules/create', {
    method: 'POST',
    body: { boardId, trigger: 'digest_daily', minScore: 80, sendHour: 9 },
  });
  check('alert rule created', rule.status === 200, rule.payload);

  const rules = await call('/api/rules');
  check('alert appears in the list', (rules.payload.rules || []).length === 1);
  check('alerts are gated on a confirmed address', rules.payload.emailVerified === false);
}

section('two-factor');
{
  const start = await call('/api/account/mfa/start', { method: 'POST', body: {} });
  check('enrollment returns a secret and a QR', Boolean(start.payload.secret && start.payload.qrSvg), start.payload);
  check('the QR is an inline SVG with no script', start.payload.qrSvg?.startsWith('<svg') && !start.payload.qrSvg.includes('<script'));

  const secret = start.payload.secret;

  const wrong = await call('/api/account/mfa/confirm', { method: 'POST', body: { code: '000000' } });
  check('a wrong code does not enable 2FA', wrong.status === 400);

  const confirmed = await call('/api/account/mfa/confirm', {
    method: 'POST',
    body: { code: await totp(secret) },
  });
  check('the right code enables 2FA', confirmed.status === 200, confirmed.payload);
  const recoveryCodes = confirmed.payload.recoveryCodes || [];
  check('ten recovery codes are issued', recoveryCodes.length === 10);

  await call('/api/auth/logout', { method: 'POST', body: {} });
  const afterLogout = await call('/api/auth/session');
  check('logout clears the session', afterLogout.status === 401);

  const login = await call('/api/auth/login', { method: 'POST', body: { email, password } });
  check('login now demands a second factor', login.payload.mfaRequired === true, login.payload);

  const blocked = await call('/api/boards');
  check('a half-authenticated session cannot read data', blocked.status === 401, blocked.payload);

  const badCode = await call('/api/auth/mfa', { method: 'POST', body: { code: '111111' } });
  check('a wrong second factor is refused', badCode.status === 401);

  const verified = await call('/api/auth/mfa', { method: 'POST', body: { code: await totp(secret) } });
  check('the TOTP challenge completes the sign-in', verified.payload.user?.email === email, verified.payload);

  const nowOk = await call('/api/boards');
  check('data is readable once MFA is satisfied', nowOk.status === 200);

  // And a recovery code works as the fallback path.
  await call('/api/auth/logout', { method: 'POST', body: {} });
  await call('/api/auth/login', { method: 'POST', body: { email, password } });
  const viaRecovery = await call('/api/auth/mfa', {
    method: 'POST',
    body: { code: recoveryCodes[0], useRecoveryCode: true },
  });
  check('a recovery code signs in', viaRecovery.payload.user?.email === email, viaRecovery.payload);

  await call('/api/auth/logout', { method: 'POST', body: {} });
  await call('/api/auth/login', { method: 'POST', body: { email, password } });
  const reused = await call('/api/auth/mfa', {
    method: 'POST',
    body: { code: recoveryCodes[0], useRecoveryCode: true },
  });
  check('a recovery code cannot be reused', reused.status === 401, reused.payload);
  await call('/api/auth/mfa', { method: 'POST', body: { code: await totp(secret) } });
}

section('deletion');
{
  const wrongPassword = await call('/api/account/delete', {
    method: 'POST',
    body: { password: 'not-the-password', confirm: 'delete my account' },
  });
  check('deletion requires the real password', wrongPassword.status === 400);

  const noConfirm = await call('/api/account/delete', { method: 'POST', body: { password, confirm: 'yes' } });
  check('deletion requires the typed confirmation', noConfirm.status === 400);

  const deleted = await call('/api/account/delete', {
    method: 'POST',
    body: { password, confirm: 'delete my account' },
  });
  check('account deleted', deleted.status === 200, deleted.payload);

  cookie = '';
  const gone = await call('/api/auth/login', { method: 'POST', body: { email, password } });
  check('the deleted account can no longer sign in', gone.status === 401);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
