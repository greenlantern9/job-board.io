import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifyBoards, topUpCatalogue } from '../src/directory.js';

// Why classification plateaued at 85%: a board that answered with no openings
// kept its seeded job_count, so the rest window (which requires job_count = 0)
// never engaged - the row was re-selected every tick, sorted near the front on
// its stale count, and starved the queue behind it. And since an empty board
// has no titles to classify from, it stayed category-less forever, which held
// the discovery gate shut and made /admin read a finished fill as a stalled
// one. These tests pin each half of the fix.

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : status === 429 ? 'Too Many Requests' : 'Server Error',
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const envRecording = (writes, rows) => ({
  DB: {
    prepare(sql) {
      return {
        bind: (...params) => {
          if (/UPDATE company_directory/.test(sql)) {
            writes.push({ sql, params });
          }
          return {
            all: async () => ({ results: /SELECT kind, identifier, category/.test(sql) ? rows : [] }),
            first: async () => null,
            run: async () => ({}),
          };
        },
      };
    },
    batch: async (stmts) => stmts,
  },
});

test('a quiet board rests with its count zeroed, not its seeded snapshot', async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ jobs: [] });
  t.after(() => {
    globalThis.fetch = original;
  });

  const writes = [];
  const rows = [{ kind: 'greenhouse', identifier: 'dormant-co', category: '' }];
  await classifyBoards(envRecording(writes, rows), { selfHost: 'example.test', limit: 1 });

  assert.equal(writes.length, 1, 'expected exactly one write for the quiet row');
  assert.ok(/verified_at/.test(writes[0].sql), 'the quiet row was not marked verified');
  assert.ok(
    /job_count = 0/.test(writes[0].sql),
    'the quiet write no longer zeroes job_count - the rest window requires it, so the row is re-read every tick forever'
  );
});

test('rate limiting and server errors do not retire an employer', async (t) => {
  // Three failed_streak strikes retire a row from every search on the service.
  // A 429 is the platform asking for patience; a 500 is its own trouble.
  // Neither is the employer disappearing, which is what retirement means.
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  for (const [status, expected] of [
    [429, 'timeout_streak'],
    [500, 'timeout_streak'],
    [404, 'failed_streak'],
  ]) {
    globalThis.fetch = async () => jsonResponse({}, status);
    const writes = [];
    const rows = [{ kind: 'greenhouse', identifier: 'busy-co', category: '' }];
    await classifyBoards(envRecording(writes, rows), { selfHost: 'example.test', limit: 1 });
    assert.equal(writes.length, 1, `status ${status}: expected one write`);
    assert.ok(
      new RegExp(`${expected} = ${expected}`).test(writes[0].sql),
      `status ${status} should increment ${expected}, got: ${writes[0].sql.trim().slice(0, 80)}`
    );
  }
});

test('the discovery gate counts only rows classification can still act on', async () => {
  // A quiet board has no titles to classify from, so counting it as backlog
  // held the gate shut permanently once every readable row was done.
  let backlogSql = '';
  const env = {
    ANTHROPIC_API_KEY: 'test',
    DB: {
      prepare(sql) {
        return {
          bind: () => ({
            all: async () => ({ results: [] }),
            first: async () => {
              if (/COUNT\(\*\) AS n FROM company_directory/.test(sql)) {
                backlogSql = sql;
                return { n: 1 }; // gate closes; we only need the SQL it used
              }
              return null;
            },
            run: async () => ({}),
          }),
        };
      },
      batch: async (stmts) => stmts,
    },
  };

  const result = await topUpCatalogue(env, { selfHost: 'example.test' });
  assert.equal(result.skipped, 'classification-backlog');
  assert.ok(
    /NOT \(verified_at <> '' AND job_count = 0\)/.test(backlogSql),
    'the gate counts quiet rows as backlog again - discovery stays off forever'
  );
  assert.ok(
    /failed_streak </.test(backlogSql),
    'the gate counts failed-out rows as backlog again'
  );
});

test('the admin page separates quiet from still-being-classified', () => {
  const server = fs.readFileSync(new URL('../src/admin.js', import.meta.url), 'utf8');
  assert.ok(
    server.includes("category = '' AND verified_at <> '' AND job_count = 0"),
    'the readiness query no longer counts quiet rows'
  );
  const client = fs.readFileSync(new URL('../public/assets/admin.js', import.meta.url), 'utf8');
  assert.ok(
    client.includes('quiet right now'),
    'the catalogue card lumps quiet rows into "still being classified" again'
  );
});
