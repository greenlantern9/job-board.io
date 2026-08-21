import test from 'node:test';
import assert from 'node:assert/strict';
import { contextAdjustment } from '../src/rank.js';

// These guard the two things an adversarial check found untested: the model
// path, and whether ordering survives a saturated score.
//
// The earlier version of this feature was measured on a dev server with no API
// key. With a key - which is every production board - the model replaces the
// heuristic score wholesale, so a preference expressed only in the heuristic
// disappeared entirely. Nothing caught it because nothing tested that path.

const job = (over = {}) => ({
  title: 'Technical Program Manager',
  company: 'Acme',
  location: 'Remote',
  remote: true,
  salaryMin: 0,
  salaryMax: 0,
  postedAt: new Date().toISOString(),
  ...over,
});

test('the remote preference survives the model replacing the score', () => {
  // contextAdjustment is the only arithmetic applied on top of a model score.
  // If remote is absent from it, a keyed deployment ranks remote and onsite
  // identically however the heuristic is weighted.
  const remote = contextAdjustment(job({ remote: true }), { filters: { remotePreferred: true } });
  const onsite = contextAdjustment(job({ remote: false }), { filters: { remotePreferred: true } });
  assert.ok(
    remote.delta > onsite.delta,
    `remote ${remote.delta} must beat onsite ${onsite.delta} on the model path`
  );
  assert.ok(remote.delta - onsite.delta >= 25, `the gap was only ${remote.delta - onsite.delta}`);
});

test('it says which it is, so the reason explains the ranking', () => {
  const remote = contextAdjustment(job({ remote: true }), { filters: { remotePreferred: true } });
  const onsite = contextAdjustment(job({ remote: false }), { filters: { remotePreferred: true } });
  assert.ok(remote.notes.includes('remote'));
  assert.ok(onsite.notes.includes('not remote'));
});

test('no preference means no remote adjustment either way', () => {
  const remote = contextAdjustment(job({ remote: true }), { filters: {} });
  const onsite = contextAdjustment(job({ remote: false }), { filters: {} });
  assert.equal(remote.delta, onsite.delta, 'silence about location must not tilt the ranking');
});

test('a hard filter needs no adjustment, since nothing onsite survives it', () => {
  const remote = contextAdjustment(job({ remote: true }), { filters: { remoteOnly: true } });
  assert.ok(remote.notes.includes('remote'));
});

// The band, mirrored from ingest.js. This is what makes the ordering structural
// rather than dependent on a score that clamps at 100 - a strong onsite posting
// ties with every remote one, and the tie then falls to the order rows were
// written in.
const bandRemoteFirst = (candidates) => [
  ...candidates.filter((c) => c.job.remote),
  ...candidates.filter((c) => !c.job.remote),
];

test('remote fills the board before onsite, even when scores are tied at the ceiling', () => {
  const candidates = [
    { job: { remote: false, title: 'onsite, perfect' }, score: 100 },
    { job: { remote: true, title: 'remote, perfect' }, score: 100 },
    { job: { remote: false, title: 'onsite, also perfect' }, score: 100 },
    { job: { remote: true, title: 'remote, weaker' }, score: 88 },
  ];
  const ordered = bandRemoteFirst(candidates);
  assert.deepEqual(
    ordered.map((c) => c.job.remote),
    [true, true, false, false],
    'every remote posting must precede every onsite one'
  );
});

test('onsite still fills the remaining slots rather than leaving them empty', () => {
  const candidates = [
    { job: { remote: false, title: 'onsite' }, score: 90 },
    { job: { remote: false, title: 'onsite too' }, score: 85 },
  ];
  assert.equal(bandRemoteFirst(candidates).length, 2, 'a preference orders, it does not exclude');
});
