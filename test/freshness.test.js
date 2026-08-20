import test from 'node:test';
import assert from 'node:assert/strict';
import { contextAdjustment } from '../src/rank.js';

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const job = (over = {}) => ({
  title: 'Technical Program Manager',
  company: 'Some Employer',
  location: 'Remote',
  remote: true,
  salaryMin: 0,
  salaryMax: 0,
  postedAt: daysAgo(0),
  ...over,
});
// What a model score of 100 becomes once age and pay are accounted for.
const applied = (over) => {
  const { delta } = contextAdjustment(job(over), {});
  return Math.max(0, Math.min(100, 100 + delta));
};

test('a month-old posting cannot hold a perfect score', () => {
  // The reported case: the model scores relevance, which is unaffected by age,
  // so a listing from four weeks ago sat at 100 beside one posted today.
  assert.ok(applied({ postedAt: daysAgo(28) }) < 100);
  assert.ok(applied({ postedAt: daysAgo(45) }) < applied({ postedAt: daysAgo(28) }));
  assert.ok(applied({ postedAt: daysAgo(90) }) < applied({ postedAt: daysAgo(45) }));
});

test('something posted today keeps its score', () => {
  assert.equal(applied({ postedAt: daysAgo(0) }), 100);
});

test('age is worth more than pay, but pay still separates equals', () => {
  const fresh = applied({ postedAt: daysAgo(0), salaryMax: 0 });
  const staleWellPaid = applied({ postedAt: daysAgo(45), salaryMax: 300000 });
  assert.ok(fresh > staleWellPaid, 'a fresh posting beats a stale one however well it pays');

  const poor = applied({ postedAt: daysAgo(28), salaryMax: 0 });
  const rich = applied({ postedAt: daysAgo(28), salaryMax: 300000 });
  assert.ok(rich > poor, 'at the same age, pay decides');
});

test('an unknown posting date is not treated as old', () => {
  // Plenty of sources publish no date. Guessing "old" would bury them.
  const { delta } = contextAdjustment(job({ postedAt: '' }), {});
  assert.ok(delta >= 0, `an undated posting was penalised by ${delta}`);
});

test('the adjustment explains itself', () => {
  const { notes } = contextAdjustment(job({ postedAt: daysAgo(45) }), {});
  assert.ok(
    notes.some((n) => /month/.test(n)),
    `expected the age to be named, got ${JSON.stringify(notes)}`
  );
});
