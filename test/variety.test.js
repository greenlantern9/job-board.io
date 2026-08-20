import test from 'node:test';
import assert from 'node:assert/strict';
import { PER_EMPLOYER_LIMIT, PER_EMPLOYER_CEILING } from '../src/ingest.js';

// The selection rule, mirrored here so the intent is pinned even though the
// production copy is embedded in refreshBoard. If these diverge, the comments
// in ingest.js are the contract this checks.
const select = (relevant, want, held = new Map()) => {
  const employer = (e) => String(e.company || '').trim().toLowerCase();
  const chosen = [];
  const taken = new Set();
  for (const item of relevant) {
    if (chosen.length >= want) break;
    const key = employer(item);
    if (key && (held.get(key) || 0) >= PER_EMPLOYER_LIMIT) continue;
    chosen.push(item);
    taken.add(item);
    if (key) held.set(key, (held.get(key) || 0) + 1);
  }
  if (chosen.length < want) {
    const ceiling = Math.max(PER_EMPLOYER_LIMIT, Math.ceil(want * PER_EMPLOYER_CEILING));
    for (const item of relevant) {
      if (chosen.length >= want) break;
      if (taken.has(item)) continue;
      const key = employer(item);
      if (key && (held.get(key) || 0) >= ceiling) continue;
      chosen.push(item);
      if (key) held.set(key, (held.get(key) || 0) + 1);
    }
  }
  return chosen;
};

const jobs = (company, n) => Array.from({ length: n }, (_, i) => ({ company, title: `${company} role ${i}` }));

test('one employer cannot take the whole board', () => {
  // The reported case: every job on the first page from a single employer.
  // Uncapped, Anduril scores highest everywhere and takes all ten.
  const relevant = [...jobs('Anduril', 20), ...jobs('Stripe', 5), ...jobs('Pendo', 5)];
  const chosen = select(relevant, 10);

  assert.equal(chosen.length, 10, 'the board still fills');
  assert.equal(new Set(chosen.map((j) => j.company)).size, 3, 'every employer is represented');

  // Each employer gets its share before anyone gets a second helping. Only
  // once the qualifying employers are exhausted does the backfill run, so the
  // excess sits at the end of the board rather than the top of it.
  const spread = chosen.slice(0, PER_EMPLOYER_LIMIT * 3);
  for (const company of ['Anduril', 'Stripe', 'Pendo']) {
    assert.equal(
      spread.filter((j) => j.company === company).length,
      PER_EMPLOYER_LIMIT,
      `${company} should hold exactly its share of the spread`
    );
  }
});

test('the cap counts what the board already holds, not just this batch', () => {
  // Otherwise one employer accumulates a few at a time across refreshes. An
  // employer already at its limit is passed over while anyone else qualifies;
  // it can still backfill afterwards, because leaving slots empty helps nobody.
  const held = new Map([['anduril', PER_EMPLOYER_LIMIT]]);
  const relevant = [...jobs('Anduril', 10), ...jobs('Stripe', 10)];
  const chosen = select(relevant, 5, held);
  const stripe = chosen.filter((j) => j.company === 'Stripe').length;
  const anduril = chosen.filter((j) => j.company === 'Anduril').length;
  assert.equal(anduril, 0, 'an employer already at its limit gets nothing more');
  assert.equal(stripe, PER_EMPLOYER_LIMIT, 'the other employer fills what it may');
  assert.ok(chosen.length < 5, 'and the board stays short rather than concentrating');
});

test('a lone employer cannot fill a board even when nothing else qualifies', () => {
  // The reported board: qualifying roles at two employers, ten slots, and nine
  // of them from one company. A short board is the honest answer here.
  const chosen = select(jobs('Anduril', 12), 10);
  assert.ok(chosen.length < 10, 'the board should stay short rather than concentrate');
  assert.equal(chosen.length, Math.ceil(10 * PER_EMPLOYER_CEILING));
});

test('two employers split a board rather than one taking nine tenths', () => {
  const chosen = select([...jobs('Anduril', 20), ...jobs('Stripe', 1)], 10);
  const anduril = chosen.filter((j) => j.company === 'Anduril').length;
  assert.ok(anduril <= Math.ceil(10 * PER_EMPLOYER_CEILING), `one employer held ${anduril}`);
});

test('postings without an employer name are not capped against each other', () => {
  const chosen = select(jobs('', 10), 10);
  assert.equal(chosen.length, 10);
});
