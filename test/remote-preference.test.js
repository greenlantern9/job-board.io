import test from 'node:test';
import assert from 'node:assert/strict';
import { requiresRemote, prefersRemote, applyIntent } from '../src/intent.js';
import { matchesFilters } from '../src/sources.js';
import { heuristicScore } from '../src/rank.js';

const base = { keywords: '', exclude: '', locations: '', remoteOnly: false };
const filtersFor = (prompt) => applyIntent({ ...base }, prompt).filters;

const job = (over = {}) => ({
  title: 'Technical Program Manager',
  company: 'Acme',
  location: 'San Francisco',
  description: '',
  remote: false,
  salaryMin: 0,
  salaryMax: 0,
  postedAt: new Date().toISOString(),
  ...over,
});

test('a bare "remote" is a preference, not a filter', () => {
  // The reported case: this excluded 91 of 108 matching postings.
  const f = filtersFor('Technical Program Manager, Remote, 250K base salary minimum');
  assert.ok(!f.remoteOnly, 'must not become a hard filter');
  assert.equal(f.remotePreferred, true);
  assert.equal(matchesFilters(job(), { ...f, query: '' }), true, 'an onsite job must survive the filter');
});

test('insisting is still a filter', () => {
  for (const prompt of ['remote only TPM', 'must be remote', 'fully remote TPM', '100% remote']) {
    const f = filtersFor(prompt);
    assert.equal(f.remoteOnly, true, prompt);
    assert.equal(matchesFilters(job(), { ...f, query: '' }), false, `onsite must be excluded for: ${prompt}`);
  }
});

test('the checkbox still excludes, whatever the sentence says', () => {
  const f = applyIntent({ ...base, remoteOnly: true }, 'Technical Program Manager').filters;
  assert.equal(f.remoteOnly, true);
  assert.equal(matchesFilters(job(), { ...f, query: '' }), false);
});

test('a preference puts remote above onsite', () => {
  const f = filtersFor('Technical Program Manager, Remote');
  const remote = heuristicScore(job({ remote: true, location: 'Remote - US' }), { prompt: 'technical program manager', filters: f }).score;
  const onsite = heuristicScore(job({ remote: false }), { prompt: 'technical program manager', filters: f }).score;
  // The gap is smaller than the raw weights imply because the score clamps at
  // 100 and a relevant posting is already near it. Ordering is what matters
  // here; the saturation is a separate problem.
  assert.ok(remote > onsite, `remote ${remote} should beat onsite ${onsite}`);
  assert.ok(remote - onsite >= 10, `the gap should be visible, was ${remote - onsite}`);
});

test('an onsite job can still be admitted when nothing remote qualifies', () => {
  // The whole point of a preference: it orders, it does not empty the board.
  const f = filtersFor('Technical Program Manager, Remote');
  const onsite = heuristicScore(job({ remote: false }), { prompt: 'technical program manager', filters: f }).score;
  assert.ok(onsite >= 60, `an onsite match scored ${onsite} and would never be admitted`);
});

test('"remote or hybrid" asks for neither a filter nor a preference', () => {
  const f = filtersFor('TPM, remote or hybrid');
  assert.ok(!f.remoteOnly);
  assert.ok(!f.remotePreferred);
});

test('"remote" naming a place is neither', () => {
  for (const prompt of ['remote sensing engineer', 'remote site technician', 'remote patient monitoring nurse']) {
    assert.equal(prefersRemote(prompt), false, prompt);
    assert.equal(requiresRemote(prompt), false, prompt);
  }
});

test('a negated mention is neither', () => {
  assert.equal(prefersRemote('TPM, not remote'), false);
  assert.equal(requiresRemote('TPM, not remote'), false);
});

test('silence about location is neither', () => {
  const f = filtersFor('backend engineer');
  assert.ok(!f.remoteOnly);
  assert.ok(!f.remotePreferred);
});
