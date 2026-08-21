import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { publicUser } from '../src/auth.js';

// Asking somebody to confirm an address is only reasonable if a message is
// actually sent. With no provider configured the confirmation never arrives, so
// every prompt to go and check an inbox is an instruction to do something
// impossible - which is what these tests exist to keep out.

const account = { id: 'u1', email: 'a@b.c', email_verified: 0, created_at: '2026-01-01' };

test('the payload says whether email can actually be delivered', () => {
  assert.equal(publicUser(account, { RESEND_API_KEY: 'x' }).emailDelivery, true);
  assert.equal(publicUser(account, {}).emailDelivery, false);
});

test('a missing env does not crash the payload', () => {
  // publicUser is called from six places; one forgetting to pass env should
  // degrade to "no email" rather than throwing on a sign-in path.
  assert.equal(publicUser(account).emailDelivery, false);
});

test('the payload still carries no secrets', () => {
  const shaped = publicUser(
    { ...account, password_hash: 'SECRET', totp_secret: 'SECRET', recovery_codes: '[]' },
    { RESEND_API_KEY: 'x' }
  );
  const serialized = JSON.stringify(shaped);
  assert.ok(!serialized.includes('SECRET'), 'a hash or secret reached the client payload');
});

test('every prompt to check an inbox is gated on delivery', () => {
  const app = fs.readFileSync(new URL('../public/assets/app.js', import.meta.url), 'utf8');

  assert.ok(
    app.includes('if (!user.emailVerified && user.emailDelivery)'),
    'the confirmation banner is no longer gated on delivery'
  );
  assert.ok(
    app.includes('user.emailVerified || !user.emailDelivery'),
    'the account dialog offers a resend that cannot send'
  );
  assert.ok(
    app.includes('alerts are saved but not sent'),
    'the alerts page no longer says why alerts will not arrive'
  );
});

test('no button claims to have sent a mail it did not send', () => {
  // The resend endpoint reports what it managed to do. Announcing a send it had
  // skipped is how this looked fine while doing nothing at all.
  const app = fs.readFileSync(new URL('../public/assets/app.js', import.meta.url), 'utf8');
  assert.ok(
    !app.includes("toast('Confirmation email sent');"),
    'a resend button announces success unconditionally'
  );
  assert.ok(
    app.includes("res.delivery === 'sent'"),
    'the resend result is not being checked'
  );
});

test('the alerts endpoint reports delivery alongside verification', () => {
  const routes = fs.readFileSync(new URL('../src/routes/app.js', import.meta.url), 'utf8');
  assert.ok(
    routes.includes('emailDelivery: Boolean(env.RESEND_API_KEY)'),
    'the alerts page cannot tell whether delivery is configured'
  );
});
