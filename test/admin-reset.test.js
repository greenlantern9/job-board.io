import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mintResetLink } from '../src/admin.js';

// The owner-minted reset link. With email delivery off, the mail flow cannot
// send its link anywhere, so this is the only recovery path on the service -
// which is exactly why its token handling must match the mail flow precisely.

const fakeEnv = (rows, log) => ({
  SITE_URL: 'https://job-boards.io',
  DB: {
    prepare(sql) {
      return {
        bind: (...params) => ({
          first: async () => {
            log.push({ sql, params });
            if (/SELECT id, email FROM users/.test(sql)) return rows.user || null;
            return null;
          },
          run: async () => {
            log.push({ sql, params });
            return {};
          },
          all: async () => ({ results: [] }),
        }),
      };
    },
    batch: async (stmts) => stmts,
  },
});

test('the raw token reaches the URL and never the database', async () => {
  const log = [];
  const env = fakeEnv({ user: { id: 'u9', email: 'erik.kortum@gmail.com' } }, log);
  const out = await mintResetLink(env, { userId: 'u9' });

  assert.equal(out.ok, true);
  const token = new URL(out.url).searchParams.get('token');
  assert.ok(token && token.length >= 40, 'token missing from the link or too short');

  const insert = log.find((l) => /INSERT INTO email_tokens/.test(l.sql));
  assert.ok(insert, 'no token row was written');
  assert.ok(!insert.params.includes(token), 'the raw token was stored - only its hash may rest');
  assert.ok(
    insert.params.some((p) => typeof p === 'string' && /^[0-9a-f]{64}$/.test(p)),
    'no sha256 hash among the insert parameters'
  );
  assert.ok(/'reset'/.test(insert.sql), 'the token is not kind reset, so resetPassword will refuse it');
});

test('minting kills the account’s earlier unused reset links first', async () => {
  const log = [];
  const env = fakeEnv({ user: { id: 'u9', email: 'e@x.y' } }, log);
  await mintResetLink(env, { userId: 'u9' });

  const kill = log.findIndex((l) => /UPDATE email_tokens SET used_at/.test(l.sql));
  const insert = log.findIndex((l) => /INSERT INTO email_tokens/.test(l.sql));
  assert.ok(kill !== -1, 'earlier links are left alive');
  assert.ok(kill < insert, 'the new link is minted before the old ones die');
  assert.ok(/used_at = ''/.test(log[kill].sql), 'already-used tokens should not be touched');
});

test('an unknown account mints nothing', async () => {
  const log = [];
  const out = await mintResetLink(fakeEnv({}, log), { userId: 'ghost' });
  assert.equal(out.error, 'No such account.');
  assert.ok(!log.some((l) => /INSERT/.test(l.sql)), 'a token was written for a missing account');
});

test('the endpoint lives inside the admin gate, POST only', () => {
  const w = fs.readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  // Sliced from the section comment to the first adminGate call AFTER it -
  // an earlier route.admin gate uses the same call, and slicing to that one
  // produced an empty string that failed this test against correct code.
  const start = w.indexOf('// The admin surface');
  const gate = w.slice(start, w.indexOf('adminGate(env, request, ctx)', start));
  assert.ok(
    gate.includes("'/api/admin/reset-link'"),
    'reset-link is dispatched outside the admin gate - anyone could mint recovery links'
  );
  assert.ok(
    w.includes("if (request.method !== 'POST') return notFound"),
    'a GET can mint, so a prefetch or crawler can invalidate handed-out links'
  );
});
