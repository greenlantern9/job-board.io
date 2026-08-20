import test from 'node:test';
import assert from 'node:assert/strict';
import { heuristicScore, WRONG_ROLE_CEILING } from '../src/rank.js';

const ADMIT_FLOOR = 60; // ingest.js ADMIT_SCORE_FLOOR
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

const job = (over = {}) => ({
  title: 'Technical Program Manager',
  company: 'Some Employer',
  location: 'Remote',
  description: '',
  remote: true,
  salaryMin: 0,
  salaryMax: 0,
  postedAt: daysAgo(0),
  ...over,
});
const score = (over, ctx = {}) =>
  heuristicScore(job(over), { prompt: 'technical program manager', filters: {}, ...ctx }).score;

test('relevance outweighs every other factor combined', () => {
  // A perfect match with nothing else going for it must still beat a mismatch
  // that is fresh, well paid and at a famous company.
  const relevant = score({ postedAt: daysAgo(20), salaryMin: 0, company: 'Nobody' });
  const irrelevant = score({ title: 'Line Cook', salaryMin: 250000, company: 'Stripe', postedAt: daysAgo(0) });
  assert.ok(relevant > irrelevant, `${relevant} should beat ${irrelevant}`);
});

test('recency separates two equally relevant postings', () => {
  assert.ok(score({ postedAt: daysAgo(0) }) > score({ postedAt: daysAgo(45) }));
});

test('pay lifts a posting but cannot rescue a mismatch', () => {
  // Measured on a posting with headroom. A fresh, remote, exact title match
  // already reaches 100 on relevance and recency alone, so the bonuses are
  // invisible there - they separate the middle of a board, not the top of it.
  const older = { postedAt: daysAgo(40) };
  assert.ok(score({ ...older, salaryMax: 250000 }) > score({ ...older, salaryMax: 0 }));
  // The wrong role stays under the bar however well it pays.
  const wrongButRich = score({ title: 'Line Cook', salaryMax: 400000 });
  assert.ok(wrongButRich < ADMIT_FLOOR, `a mismatch scored ${wrongButRich}`);
});

test('a recognised employer breaks a tie without deciding one', () => {
  const older = { postedAt: daysAgo(40) };
  const known = score({ ...older, company: 'Stripe' });
  const unknown = score({ ...older, company: 'Some Employer' });
  assert.ok(known > unknown, 'recognised employers rank higher, all else equal');
  // But not enough to carry an unrelated posting over the bar.
  const knownButWrong = score({ title: 'Line Cook', company: 'Stripe' });
  assert.ok(knownButWrong < ADMIT_FLOOR);
});

test('neither new factor can empty a board', () => {
  // The safety property: both are bonuses, so a posting with no salary and an
  // unknown employer is not pushed below where it already was.
  const plain = score({ salaryMin: 0, salaryMax: 0, company: 'Totally Unknown Ltd' });
  assert.ok(plain >= ADMIT_FLOOR, `a good match with no extras scored ${plain}`);
});

test('a body-only match still cannot be admitted, however well it pays', () => {
  const s = heuristicScore(
    job({
      title: 'Water Resources Designer II',
      description: 'Supports the technical program; works with the program manager on technical tasks.',
      salaryMax: 300000,
      company: 'Stripe',
    }),
    { prompt: 'technical program manager', filters: {} }
  ).score;
  assert.ok(s <= WRONG_ROLE_CEILING, `scored ${s}`);
});
