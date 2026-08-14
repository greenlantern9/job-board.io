import test from 'node:test';
import assert from 'node:assert/strict';
import {
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
} from '../src/crypto.js';

test('password hashing round-trips and rejects wrong passwords', async () => {
  const stored = await hashPassword('correct horse battery staple');
  assert.match(stored, /^pbkdf2\$sha256\$210000\$/);
  assert.equal(await verifyPassword('correct horse battery staple', stored), true);
  assert.equal(await verifyPassword('Correct horse battery staple', stored), false);
  assert.equal(await verifyPassword('', stored), false);
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
