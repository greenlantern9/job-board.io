import test from 'node:test';
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

test('ordinary board endpoints are not owner-gated', async () => {
  // The counterpart: the gate must not have been applied so broadly that normal
  // use needs admin.
  const { APP_ROUTES } = await import('../src/routes/app.js');
  assert.notEqual(APP_ROUTES['GET /api/boards'].admin, true);
  assert.notEqual(APP_ROUTES['POST /api/boards/create'].admin, true);
});
