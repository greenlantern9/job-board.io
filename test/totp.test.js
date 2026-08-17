import test from 'node:test';
import assert from 'node:assert/strict';
import {
  base32Encode,
  base32Decode,
  totp,
  verifyTotp,
  generateSecret,
  otpauthUri,
} from '../src/totp.js';

// RFC 6238 appendix B uses the ASCII secret "12345678901234567890".
const RFC_SECRET = base32Encode(new TextEncoder().encode('12345678901234567890'));

test('base32 round-trips', () => {
  const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x11]);
  assert.deepEqual(Array.from(base32Decode(base32Encode(bytes))), Array.from(bytes));
  assert.equal(base32Encode(new TextEncoder().encode('Hello!')), 'JBSWY3DPEE======');
});

test('base32 rejects invalid characters', () => {
  assert.throws(() => base32Decode('ABC1'), /invalid base32/);
});

test('TOTP matches RFC 6238 test vectors (SHA-1, 6 digits)', async () => {
  const vectors = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ];
  for (const [seconds, expected] of vectors) {
    assert.equal(await totp(RFC_SECRET, seconds * 1000), expected, `at t=${seconds}`);
  }
});

test('verification accepts adjacent windows and rejects distant ones', async () => {
  const now = 1111111109 * 1000;
  const current = await totp(RFC_SECRET, now);
  assert.equal(await verifyTotp(RFC_SECRET, current, { atMs: now }), true);

  // One step earlier and later are accepted (clock drift).
  const previous = await totp(RFC_SECRET, now - 30000);
  const next = await totp(RFC_SECRET, now + 30000);
  assert.equal(await verifyTotp(RFC_SECRET, previous, { atMs: now }), true);
  assert.equal(await verifyTotp(RFC_SECRET, next, { atMs: now }), true);

  // Two steps away is not.
  const stale = await totp(RFC_SECRET, now - 90000);
  assert.equal(await verifyTotp(RFC_SECRET, stale, { atMs: now }), false);
});

test('verification rejects malformed input without throwing', async () => {
  for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined, '12 34 56']) {
    assert.equal(await verifyTotp(RFC_SECRET, bad, { atMs: Date.now() }), false, String(bad));
  }
});

test('generated secrets are 160-bit and usable', async () => {
  const secret = generateSecret();
  assert.equal(base32Decode(secret).length, 20);
  const code = await totp(secret);
  assert.match(code, /^\d{6}$/);
  assert.equal(await verifyTotp(secret, code), true);
});

test('otpauth URI carries the parameters authenticators expect', () => {
  const uri = otpauthUri({
    issuer: 'job-boards.io',
    account: 'person@example.com',
    secret: 'JBSWY3DPEHPK3PXP',
  });
  assert.ok(uri.startsWith('otpauth://totp/job-boards.io%3Aperson%40example.com?'));
  const params = new URLSearchParams(uri.split('?')[1]);
  assert.equal(params.get('secret'), 'JBSWY3DPEHPK3PXP');
  assert.equal(params.get('issuer'), 'job-boards.io');
  assert.equal(params.get('digits'), '6');
  assert.equal(params.get('period'), '30');
});
