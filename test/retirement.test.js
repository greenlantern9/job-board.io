import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyBoards } from '../src/directory.js';

// A server that accepts the connection and never answers, so the caller's own
// timeout is what ends the request.
const hangingFetch = () => (url, init = {}) =>
  new Promise((_resolve, reject) => {
    const signal = init.signal;
    if (!signal) return;
    const abort = () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort);
  });

const envRecording = (writes, rows) => ({
  DB: {
    prepare(sql) {
      return {
        bind: (...params) => {
          if (/UPDATE company_directory/.test(sql)) {
            writes.push(
              /timeout_streak = timeout_streak/.test(sql)
                ? 'timeout_streak'
                : /failed_streak = failed_streak/.test(sql)
                  ? 'failed_streak'
                  : 'other'
            );
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

test('a slow employer is marked slow, never retired', async (t) => {
  // The bug this guards: classification read 500 boards a tick against a
  // 12-second budget while the largest listings take nearly thirty seconds to
  // return. Counting that as failure retired the biggest employers in the
  // catalogue from every board on the service, and a retired row is excluded
  // from the query that would have re-read it - so it never came back.
  const original = globalThis.fetch;
  globalThis.fetch = hangingFetch();
  t.after(() => {
    globalThis.fetch = original;
  });

  const writes = [];
  const rows = [
    { kind: 'greenhouse', identifier: 'bayada', category: '' },
    { kind: 'greenhouse', identifier: 'spacex', category: '' },
  ];

  await classifyBoards(envRecording(writes, rows), { selfHost: 'example.test', limit: 2 });

  assert.deepEqual(writes, ['timeout_streak', 'timeout_streak']);
  assert.equal(writes.filter((c) => c === 'failed_streak').length, 0, 'slowness must not retire');
});
