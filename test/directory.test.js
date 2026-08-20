import test from 'node:test';
import assert from 'node:assert/strict';
import { topUpCatalogue, CATALOGUE_TARGET, RETRY_AFTER_MS } from '../src/directory.js';
import { DAILY_CALL_LIMIT } from '../src/budget.js';

// Every field except the ones named is filled to target, so the test controls
// exactly which field top-up is allowed to choose.
const fullExcept = (thin = {}) => {
  const counts = { ...thin };
  for (const id of ['software', 'creative', 'care', 'teaching', 'support', 'marketing', 'sales', 'product', 'trades']) {
    if (!(id in counts)) counts[id] = CATALOGUE_TARGET;
  }
  return counts;
};

// A D1 stand-in answering only the queries topUpCatalogue actually issues, so
// an unexpected one surfaces as a failure rather than passing quietly.
const fakeDb = ({ counts = {}, attempts = {}, callsUsed = 0 }) => {
  const writes = [];
  return {
    writes,
    DB: {
      prepare: (sql) => ({
        bind: (...params) => ({
          all: async () => {
            if (/FROM company_directory/.test(sql)) {
              return { results: Object.entries(counts).map(([category, n]) => ({ category, n })) };
            }
            if (/FROM discovery_attempts/.test(sql)) {
              return {
                results: Object.entries(attempts).map(([category, attempted_at]) => ({ category, attempted_at })),
              };
            }
            return { results: [] };
          },
          first: async () => (/model_usage/.test(sql) ? { calls: callsUsed, jobs_scored: 0 } : null),
          run: async () => {
            writes.push({ sql, params });
            return {};
          },
        }),
      }),
    },
  };
};

test('background top-up does nothing without an API key', async () => {
  const env = { ...fakeDb({}), ANTHROPIC_API_KEY: '' };
  assert.deepEqual(await topUpCatalogue(env), { skipped: 'no-key' });
});

test('a catalogue at target stops costing anything', async () => {
  // The whole point of a target: background discovery has to terminate, or it
  // bills for searches forever.
  const env = { ...fakeDb({ counts: fullExcept() }), ANTHROPIC_API_KEY: 'k' };
  const result = await topUpCatalogue(env);
  assert.equal(result.skipped, 'nothing-below-target');
  assert.equal(env.writes.length, 0, 'a satisfied catalogue must not record an attempt');
});

test('the thinnest field is the one topped up', async () => {
  const env = {
    ...fakeDb({ counts: fullExcept({ sales: 3, marketing: 1, product: 9 }), callsUsed: DAILY_CALL_LIMIT }),
    ANTHROPIC_API_KEY: 'k',
  };
  const result = await topUpCatalogue(env);
  assert.equal(result.category, 'marketing', 'the emptiest field benefits most');
  assert.equal(result.had, 1);
});

test('a field tried recently is left alone until the retry window passes', async () => {
  const env = {
    ...fakeDb({
      counts: fullExcept({ sales: 0 }),
      attempts: { sales: new Date(Date.now() - RETRY_AFTER_MS / 2).toISOString() },
    }),
    ANTHROPIC_API_KEY: 'k',
  };
  assert.equal((await topUpCatalogue(env)).skipped, 'nothing-below-target');
});

test('the same field is tried again once the window has passed', async () => {
  const env = {
    ...fakeDb({
      counts: fullExcept({ sales: 0 }),
      attempts: { sales: new Date(Date.now() - RETRY_AFTER_MS * 2).toISOString() },
      callsUsed: DAILY_CALL_LIMIT,
    }),
    ANTHROPIC_API_KEY: 'k',
  };
  assert.equal((await topUpCatalogue(env)).category, 'sales');
});

test('a run that finds nothing still records the attempt', async () => {
  // Discovery that comes up empty leaves no directory rows. Without an attempt
  // record there would be no evidence it ran, and the same barren field would
  // be searched again on the very next tick - forever.
  const env = {
    ...fakeDb({ counts: fullExcept({ sales: 0 }), callsUsed: DAILY_CALL_LIMIT }),
    ANTHROPIC_API_KEY: 'k',
  };
  const result = await topUpCatalogue(env);
  assert.equal(result.category, 'sales');
  assert.equal(result.added, 0);
  assert.ok(
    env.writes.some((w) => /discovery_attempts/.test(w.sql)),
    'an empty-handed run must still leave a record'
  );
});
