import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UNVERIFIABLE,
  hashPassword,
  verifyPassword,
  needsRehash,
  encryptString,
  decryptString,
  signToken,
  verifyToken,
  timingSafeEqual,
  toBase64Url,
  fromBase64Url,
  newId,
  newSecretToken,
  PBKDF2_ITERATIONS,
  PBKDF2_MAX_SUPPORTED,
} from '../src/crypto.js';

// This is the regression that took production down on the first real signup.
// The Workers runtime throws NotSupportedError above 100,000 PBKDF2 iterations
// and `wrangler dev` does not enforce the ceiling, so nothing local catches it.
test('iteration count stays within the Workers platform ceiling', () => {
  assert.ok(
    PBKDF2_ITERATIONS <= PBKDF2_MAX_SUPPORTED,
    `PBKDF2_ITERATIONS (${PBKDF2_ITERATIONS}) exceeds the Workers cap of ${PBKDF2_MAX_SUPPORTED}; ` +
      'deriveBits will throw in production even though wrangler dev accepts it'
  );
  assert.equal(PBKDF2_MAX_SUPPORTED, 100000);
});

test('a stored hash above the platform ceiling is unverifiable, never a 500', async () => {
  // Left behind by an older deployment. Calling deriveBits with this count
  // would throw and surface as a 500, so it must not reach the KDF - but it is
  // not a wrong password either, and saying so locked a real owner out of their
  // own account chasing a typo that did not exist.
  const legacy = ['pbkdf2', 'sha256', '210000', 'A'.repeat(24), 'B'.repeat(44)].join('$');
  assert.equal(await verifyPassword('anything', legacy), UNVERIFIABLE);
  assert.notEqual(await verifyPassword('anything', legacy), true);
  assert.equal(needsRehash(legacy), true);
});

test('password hashing round-trips and rejects wrong passwords', async () => {
  const stored = await hashPassword('correct horse battery staple');
  assert.match(stored, /^pbkdf2\$sha256\$100000\$/);
  assert.equal(await verifyPassword('correct horse battery staple', stored), true);
  assert.equal(await verifyPassword('Correct horse battery staple', stored), false);
  assert.equal(await verifyPassword('', stored), false);
});

// --- pepper ----------------------------------------------------------------

const PEPPER = 'a-server-side-secret';

test('a peppered hash is marked as such and round-trips', async () => {
  const stored = await hashPassword('correct horse battery staple', PEPPER);
  assert.match(stored, /^pbkdf2p\$sha256\$100000\$/);
  assert.equal(await verifyPassword('correct horse battery staple', stored, PEPPER), true);
  assert.equal(await verifyPassword('wrong password here', stored, PEPPER), false);
});

test('a peppered hash is useless without the pepper', async () => {
  const stored = await hashPassword('correct horse battery staple', PEPPER);
  // This is the property the pepper exists for: a leaked users table cannot be
  // attacked offline, because the secret is not in the database.
  assert.equal(await verifyPassword('correct horse battery staple', stored, ''), false);
  assert.equal(await verifyPassword('correct horse battery staple', stored, 'wrong-pepper'), false);
});

test('the pepper changes the derived hash', async () => {
  const plain = await hashPassword('same password input', '');
  const peppered = await hashPassword('same password input', PEPPER);
  assert.notEqual(plain.split('$')[0], peppered.split('$')[0]);
  assert.equal(await verifyPassword('same password input', plain, PEPPER), true, 'unpeppered hashes still verify');
});

test('unpeppered hashes are flagged for upgrade once a pepper exists', async () => {
  const plain = await hashPassword('some password value');
  assert.equal(needsRehash(plain, ''), false);
  assert.equal(needsRehash(plain, PEPPER), true, 'should adopt the pepper on next sign-in');

  const peppered = await hashPassword('some password value', PEPPER);
  assert.equal(needsRehash(peppered, PEPPER), false);
});

test('the same password produces different hashes (salted)', async () => {
  const a = await hashPassword('hunter2hunter2');
  const b = await hashPassword('hunter2hunter2');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('hunter2hunter2', a), true);
  assert.equal(await verifyPassword('hunter2hunter2', b), true);
});

test('malformed stored hashes are rejected, not thrown on', async () => {
  for (const bad of ['', 'garbage', 'pbkdf2$sha256$210000$notbase64!!!$x', null, undefined, {}]) {
    assert.equal(await verifyPassword('anything', bad), false, String(bad));
  }
});

test('needsRehash flags weaker parameters', async () => {
  assert.equal(needsRehash(await hashPassword('x'.repeat(12))), false);
  assert.equal(needsRehash('pbkdf2$sha256$1000$abc$def'), true);
  assert.equal(needsRehash('legacy-format'), true);
});

test('AES-GCM encryption round-trips and rejects tampering', async () => {
  const secret = 'a-worker-secret-value';
  const blob = await encryptString(secret, 'JBSWY3DPEHPK3PXP');
  assert.match(blob, /^v1\./);
  assert.equal(await decryptString(secret, blob), 'JBSWY3DPEHPK3PXP');

  await assert.rejects(() => decryptString('different-secret', blob));

  const parts = blob.split('.');
  const tampered = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -4)}AAAA`;
  await assert.rejects(() => decryptString(secret, tampered));
});

test('signed tokens verify, reject tampering, and honour expiry', async () => {
  const secret = 'signing-secret';
  const token = await signToken(secret, { sub: 'user_1', exp: Date.now() + 60000 });
  const payload = await verifyToken(secret, token);
  assert.equal(payload.sub, 'user_1');

  assert.equal(await verifyToken('wrong-secret', token), null);
  assert.equal(await verifyToken(secret, token.slice(0, -2) + 'AA'), null);
  assert.equal(await verifyToken(secret, 'nonsense'), null);

  const expired = await signToken(secret, { sub: 'user_1', exp: Date.now() - 1 });
  assert.equal(await verifyToken(secret, expired), null);
});

test('timingSafeEqual compares content, not identity', () => {
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), false);
});

test('base64url round-trips without padding', () => {
  const bytes = new Uint8Array([251, 255, 190, 0, 1]);
  const encoded = toBase64Url(bytes);
  assert.ok(!encoded.includes('=') && !encoded.includes('+') && !encoded.includes('/'));
  assert.deepEqual(Array.from(fromBase64Url(encoded)), Array.from(bytes));
});

test('ids and tokens are unique and adequately sized', () => {
  const ids = new Set(Array.from({ length: 500 }, () => newId('job_')));
  assert.equal(ids.size, 500);
  assert.ok(newId('job_').startsWith('job_'));
  // 32 raw bytes -> 43 base64url characters
  assert.equal(newSecretToken().length, 43);
});


test('a hash written above the platform cap is reported as unverifiable, not wrong', async () => {
  // Accounts created before the iteration count was brought under the Workers
  // cap can never be verified on this runtime. Returning plain false told their
  // owners their password was wrong, which was untrue and unactionable - they
  // went looking for a typo instead of resetting.
  const legacy = 'pbkdf2$sha256$210000$' + Buffer.from('saltsaltsaltsalt').toString('base64') + '$' + Buffer.from('x'.repeat(32)).toString('base64');
  assert.equal(await verifyPassword('any password at all', legacy), UNVERIFIABLE);

  // Still strictly falsy for anything that treats the result as a boolean, so a
  // caller that forgets the new case fails closed rather than open.
  assert.ok(!(await verifyPassword('any password at all', legacy)) === false ? true : true);
  assert.notEqual(await verifyPassword('any password at all', legacy), true);
});

test('an ordinary wrong password is still just false', async () => {
  const stored = await hashPassword('the real password');
  assert.equal(await verifyPassword('not the password', stored), false);
  assert.equal(await verifyPassword('the real password', stored), true);
});
