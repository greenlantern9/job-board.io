import test from 'node:test';
import assert from 'node:assert/strict';
import { heuristicScore, detectSeniority } from '../src/rank.js';

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

const base = (over = {}) => ({
  title: 'Senior Backend Engineer',
  company: 'acme',
  location: 'Remote - US',
  description: 'Go, Postgres, distributed systems.',
  remote: true,
  salaryMin: 0,
  salaryMax: 0,
  postedAt: '',
  ...over,
});

test('seniority is read from the title, defaulting to mid', () => {
  assert.equal(detectSeniority('Software Engineer'), 2);
  assert.equal(detectSeniority('Engineering Intern'), 0);
  assert.equal(detectSeniority('Junior Developer'), 1);
  assert.equal(detectSeniority('Senior Platform Engineer'), 3);
  assert.equal(detectSeniority('Staff Engineer'), 3);
  assert.equal(detectSeniority('Principal Architect'), 4);
  assert.equal(detectSeniority('Director of Engineering'), 5);
  assert.equal(detectSeniority('VP Engineering'), 5);
});

test('scores stay inside 0-100 for hostile inputs', () => {
  const cases = [
    base(),
    base({ title: '', description: '', location: '', remote: false }),
    base({ postedAt: 'not-a-date' }),
    base({ postedAt: daysAgo(4000) }),
    base({ salaryMin: 999999999 }),
  ];
  for (const job of cases) {
    for (const filters of [{}, { seniority: 5, minSalary: 900000, keywords: 'x', remoteOnly: true }]) {
      const { score } = heuristicScore(job, { prompt: 'senior backend go remote', filters });
      assert.ok(score >= 0 && score <= 100, `out of range: ${score}`);
      assert.ok(Number.isInteger(score));
    }
  }
});

test('scoring is deterministic', () => {
  const job = base({ postedAt: daysAgo(2), salaryMin: 180000, salaryMax: 220000 });
  const opts = { prompt: 'senior backend go', filters: { minSalary: 150000 } };
  const first = heuristicScore(job, opts);
  assert.deepEqual(heuristicScore(job, opts), first);
});

test('criteria overlap moves the score and the reason says so', () => {
  const job = base();
  const match = heuristicScore(job, { prompt: 'backend engineer go postgres distributed' });
  const miss = heuristicScore(job, { prompt: 'kubernetes helm terraform ansible' });
  assert.ok(match.score > miss.score, `${match.score} should beat ${miss.score}`);
  assert.match(match.reason, /matches \d+\/\d+/);
  assert.match(miss.reason, /no overlap/);
});

test('a keyword in the title beats the same keyword in the body', () => {
  const inTitle = heuristicScore(base({ title: 'Senior Rust Engineer' }), { prompt: 'rust' });
  const inBody = heuristicScore(
    base({ title: 'Senior Engineer', description: 'We use rust here.' }),
    { prompt: 'rust' }
  );
  assert.ok(inTitle.score > inBody.score);
});

test('recency raises fresh postings and penalises stale ones', () => {
  const fresh = heuristicScore(base({ postedAt: daysAgo(1) }), {});
  const recent = heuristicScore(base({ postedAt: daysAgo(10) }), {});
  const stale = heuristicScore(base({ postedAt: daysAgo(90) }), {});
  assert.ok(fresh.score > recent.score);
  assert.ok(recent.score > stale.score);
  assert.match(stale.reason, /two months old/);
});

test('seniority mismatch costs more the further off it is', () => {
  const job = base({ title: 'Engineering Intern' });
  const exact = heuristicScore(job, { filters: { seniority: 0 } });
  const oneOff = heuristicScore(job, { filters: { seniority: 1 } });
  const wayOff = heuristicScore(job, { filters: { seniority: 5 } });
  assert.ok(exact.score > oneOff.score);
  assert.ok(oneOff.score > wayOff.score);
  assert.match(exact.reason, /seniority matches/);
});

test('salary above the floor beats merely meeting it', () => {
  const above = heuristicScore(base({ salaryMin: 200000, salaryMax: 240000 }), {
    filters: { minSalary: 150000 },
  });
  const meets = heuristicScore(base({ salaryMin: 150000, salaryMax: 155000 }), {
    filters: { minSalary: 150000 },
  });
  const silent = heuristicScore(base(), { filters: { minSalary: 150000 } });
  assert.ok(above.score > meets.score);
  assert.ok(meets.score > silent.score);
});

test('remote counts for more when remote was asked for', () => {
  const wanted = heuristicScore(base(), { filters: { remoteOnly: true } });
  const incidental = heuristicScore(base(), { filters: {} });
  assert.ok(wanted.score > incidental.score);
});

test('every result carries a reason and a provenance tag', () => {
  const result = heuristicScore(base(), {});
  assert.equal(result.scoredBy, 'heuristic');
  assert.ok(result.reason.length > 0);
});
