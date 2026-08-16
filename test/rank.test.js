import test from 'node:test';
import assert from 'node:assert/strict';
import { heuristicScore, detectSeniority, detectSeniorityLevel, jobAgeDays } from '../src/rank.js';

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

test('recency is monotonic across the whole age range', () => {
  const ages = [0, 2, 5, 10, 20, 45, 120];
  const scores = ages.map((d) => heuristicScore(base({ postedAt: daysAgo(d) }), {}).score);
  for (let i = 1; i < scores.length; i++) {
    assert.ok(
      scores[i] <= scores[i - 1],
      `age ${ages[i]}d scored ${scores[i]}, higher than ${ages[i - 1]}d at ${scores[i - 1]}`
    );
  }
  assert.ok(scores[0] > scores[scores.length - 1] + 30, 'fresh should clear stale by a wide margin');
});

test('recency outweighs a criteria match, because applying early matters', () => {
  // A perfect match from four months ago should lose to a decent match from
  // today - that is the whole point of weighting recency this hard.
  const staleMatch = heuristicScore(base({ postedAt: daysAgo(120) }), {
    prompt: 'senior backend engineer go postgres distributed systems',
  });
  const freshWeaker = heuristicScore(base({ postedAt: daysAgo(0), description: 'Some other stack.' }), {
    prompt: 'senior backend engineer go postgres distributed systems',
  });
  assert.ok(freshWeaker.score > staleMatch.score);
});

test('today and this-week postings say so in the reason, first', () => {
  assert.match(heuristicScore(base({ postedAt: daysAgo(0) }), {}).reason, /^posted today/);
  assert.match(heuristicScore(base({ postedAt: daysAgo(5) }), {}).reason, /posted this week/);
  assert.match(heuristicScore(base({ postedAt: daysAgo(120) }), {}).reason, /two months old/);
});

test('an undated posting is neither rewarded nor punished', () => {
  const undated = heuristicScore(base({ postedAt: '' }), {});
  const monthOld = heuristicScore(base({ postedAt: daysAgo(20) }), {});
  const fresh = heuristicScore(base({ postedAt: daysAgo(0) }), {});
  assert.ok(undated.score > monthOld.score - 5 && undated.score < fresh.score);
  assert.equal(jobAgeDays({ postedAt: '' }), null);
  assert.equal(jobAgeDays({ postedAt: 'not-a-date' }), null);
  // A future date is a feed bug, not a fresh posting.
  assert.equal(jobAgeDays({ postedAt: new Date(Date.now() + 86400000).toISOString() }), null);
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

test('unstated seniority is distinguishable from mid', () => {
  // detectSeniority collapses both to 2 for ranking; detectSeniorityLevel keeps
  // them apart so the minimum-level filter does not throw away untitled roles.
  assert.equal(detectSeniorityLevel('Software Engineer'), null);
  assert.equal(detectSeniority('Software Engineer'), 2);
  assert.equal(detectSeniorityLevel('Senior Software Engineer'), 3);
});

test('jobs below the minimum level are pushed down, not just filtered', () => {
  // Existing rows collected before the minimum was raised still need to sink.
  const junior = heuristicScore(base({ title: 'Junior Backend Engineer' }), {
    filters: { minSeniority: 3 },
  });
  const senior = heuristicScore(base({ title: 'Senior Backend Engineer' }), {
    filters: { minSeniority: 3 },
  });
  assert.ok(senior.score > junior.score);
  assert.match(junior.reason, /below your minimum level/);
});

test('an unstated level is not penalised by the minimum', () => {
  const withMin = heuristicScore(base({ title: 'Software Engineer' }), {
    filters: { minSeniority: 4 },
  });
  const without = heuristicScore(base({ title: 'Software Engineer' }), { filters: {} });
  assert.equal(withMin.score, without.score);
});

test('companies on the curated list are boosted and told why', () => {
  const listed = heuristicScore(base({ company: 'stripe' }), {
    filters: { companies: 'Stripe, Linear' },
  });
  const other = heuristicScore(base({ company: 'acme' }), {
    filters: { companies: 'Stripe, Linear' },
  });
  assert.ok(listed.score > other.score);
  assert.match(listed.reason, /on your company list/);
});

test('the company boost tolerates slug and legal-suffix variation', () => {
  const plain = heuristicScore(base({ company: 'gitlab' }), { filters: { companies: 'GitLab Inc.' } });
  assert.match(plain.reason, /on your company list/);
});

// --- candidate profile (optional) ------------------------------------------

test('no profile leaves scoring exactly as it was', () => {
  const job = base();
  const withoutKey = heuristicScore(job, { prompt: 'backend go' });
  const withNull = heuristicScore(job, { prompt: 'backend go', profile: null });
  assert.deepEqual(withNull, withoutKey);
});

test('a deal-breaker rules a job out rather than deducting from it', () => {
  const job = base({ description: 'Go, Postgres, and a crypto trading platform.' });
  const result = heuristicScore(job, {
    prompt: 'senior backend go',
    profile: { dealBreakers: ['crypto'], skills: ['go'], mustHave: [] },
  });
  // Not "scored a bit lower" - out. Someone who said they will not do this
  // should not find it near the top of their board.
  assert.equal(result.score, 0);
  assert.match(result.reason, /deal-breaker/);
  assert.deepEqual(result.gaps, ['Mentions "crypto"']);
});

test('a deal-breaker beats every positive signal', () => {
  // A perfect match on everything else must still be ruled out.
  const job = base({ title: 'Senior Backend Engineer', description: 'Go, crypto exchange', postedAt: daysAgo(0) });
  const result = heuristicScore(job, {
    prompt: 'senior backend engineer go',
    filters: { remoteOnly: true },
    profile: { dealBreakers: ['crypto'], skills: ['go'], mustHave: [] },
  });
  assert.equal(result.score, 0);
});

test('missing must-haves are reported as gaps, not silent', () => {
  const result = heuristicScore(base(), {
    prompt: 'backend',
    profile: { dealBreakers: [], skills: [], mustHave: ['kubernetes', 'terraform'] },
  });
  assert.ok(result.gaps.length > 0);
  assert.match(result.gaps[0], /kubernetes/);
});

test('profile skills present in the posting raise the score', () => {
  const job = base({ description: 'Go, Postgres, Kubernetes, Terraform.' });
  const without = heuristicScore(job, { prompt: 'backend' });
  const with_ = heuristicScore(job, {
    prompt: 'backend',
    profile: { dealBreakers: [], mustHave: [], skills: ['go', 'kubernetes', 'terraform'] },
  });
  assert.ok(with_.score > without.score);
  assert.match(with_.reason, /matches your/);
});

test('an empty deal-breaker string cannot rule everything out', () => {
  // A blank entry left in the list must not match every job by substring.
  const result = heuristicScore(base(), {
    prompt: 'backend',
    profile: { dealBreakers: ['', ' ', 'x'], skills: [], mustHave: [] },
  });
  assert.notEqual(result.score, 0);
});

test('every result carries a gaps array, even when nothing is wrong', () => {
  const result = heuristicScore(base(), { prompt: 'backend' });
  assert.ok(Array.isArray(result.gaps));
});

test('every result carries a reason and a provenance tag', () => {
  const result = heuristicScore(base(), {});
  assert.equal(result.scoredBy, 'heuristic');
  assert.ok(result.reason.length > 0);
});
