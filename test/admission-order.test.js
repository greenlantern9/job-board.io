import test from 'node:test';
import assert from 'node:assert/strict';
import { PREFER_FRESHER_THAN_DAYS } from '../src/ingest.js';
import { jobAgeDays } from '../src/rank.js';

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

// The banding rule as ingest applies it: recent candidates are offered slots
// before stale ones, and the ranking decides the order within each band.
const order = (candidates) => {
  const recentEnough = ({ entry }) => {
    const days = jobAgeDays(entry.job);
    return days === null || days <= PREFER_FRESHER_THAN_DAYS;
  };
  return [...candidates.filter(recentEnough), ...candidates.filter((c) => !recentEnough(c))];
};

const candidate = (label, days, score) => ({
  entry: { job: { title: label, postedAt: days === null ? '' : daysAgo(days) } },
  score,
});

test('a stale posting waits behind every recent one, whatever it scores', () => {
  // The reported case: a listing from four weeks ago reached 100 through pay
  // and employer bonuses and sat beside postings from that morning.
  const ranked = [
    candidate('month-old, perfect', 28, 100),
    candidate('today, slightly worse', 0, 92),
    candidate('two days, worse still', 2, 88),
  ];
  const [first, second, third] = order(ranked);
  assert.equal(first.entry.job.title, 'today, slightly worse');
  assert.equal(second.entry.job.title, 'two days, worse still');
  assert.equal(third.entry.job.title, 'month-old, perfect');
});

test('within the recent band the ranking still decides', () => {
  const ranked = [
    candidate('better', 5, 96),
    candidate('worse', 1, 70),
  ];
  assert.equal(order(ranked)[0].entry.job.title, 'better', 'freshness bands, it does not re-sort');
});

test('stale postings are still admitted when nothing recent is left', () => {
  // Holding a slot empty would help nobody; the preference is an ordering, not
  // an exclusion.
  const ranked = [candidate('old but relevant', 40, 88)];
  assert.equal(order(ranked).length, 1);
});

test('an undated posting is treated as recent', () => {
  const ranked = [candidate('stale', 30, 100), candidate('undated', null, 80)];
  assert.equal(order(ranked)[0].entry.job.title, 'undated');
});

test('the threshold is a sensible number of days', () => {
  assert.ok(PREFER_FRESHER_THAN_DAYS >= 7 && PREFER_FRESHER_THAN_DAYS <= 45);
});
