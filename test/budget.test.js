import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateCost, DAILY_CALL_LIMIT } from '../src/budget.js';

test('cost is priced from published per-million rates', () => {
  // Opus 5: $5/M in, $25/M out.
  const cost = estimateCost({ inputTokens: 1e6, outputTokens: 1e6 }, 'claude-opus-5');
  assert.equal(cost, 30);
});

test('a typical scoring batch costs cents, not dollars', () => {
  // 15 postings, descriptions capped at 1,200 characters, plus the system
  // prompt: roughly 6k in and 2k out.
  const cost = estimateCost({ inputTokens: 6000, outputTokens: 2000 }, 'claude-opus-5');
  assert.ok(cost > 0.05 && cost < 0.12, `expected a few cents, got ${cost}`);
});

test('cached input is billed at a tenth of fresh input', () => {
  const fresh = estimateCost({ inputTokens: 1e6 }, 'claude-opus-5');
  const cached = estimateCost({ cacheReadTokens: 1e6 }, 'claude-opus-5');
  assert.equal(fresh / cached, 10);
});

test('an unknown model is priced at the most expensive rate rather than free', () => {
  // Guessing low would under-report spend, which is the dangerous direction.
  const unknown = estimateCost({ inputTokens: 1e6 }, 'some-future-model');
  const opus = estimateCost({ inputTokens: 1e6 }, 'claude-opus-5');
  assert.equal(unknown, opus);
});

test('zero usage costs nothing', () => {
  assert.equal(estimateCost({}, 'claude-opus-5'), 0);
});

test('the daily cap bounds what one account can spend', () => {
  // The ceiling quoted to the user: 30 calls, each a scoring batch.
  const perCall = estimateCost({ inputTokens: 6000, outputTokens: 2000 }, 'claude-opus-5');
  assert.ok(perCall * DAILY_CALL_LIMIT < 5, 'a single account cannot run up a large daily bill');
});
