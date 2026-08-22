import test from 'node:test';
import assert from 'node:assert/strict';
import { termCoverage } from '../src/admin.js';

// "How many aerospace roles do I have" is a topic question, and the fields
// chart cannot answer it - aerospace employers classify as software or trades.
// termCoverage asks the vocabulary instead, and its one hard requirement is
// matching the way employer selection matches: exact words, same
// normalization, so its answer predicts what a board would actually reach.

const fakeEnv = (log, rows = {}) => ({
  DB: {
    prepare(sql) {
      return {
        bind: (...params) => ({
          first: async () => {
            log.push({ sql, params });
            return rows.totals || { n: 0, jobs: 0 };
          },
          all: async () => {
            log.push({ sql, params });
            return { results: rows.byField || [] };
          },
          run: async () => ({}),
        }),
      };
    },
    batch: async (stmts) => stmts,
  },
});

test('matching is word-exact, not substring', async () => {
  // 'care' must not match an employer whose vocabulary has 'career'. The SQL
  // spelling of Set membership is padding both sides with spaces.
  const log = [];
  await termCoverage(fakeEnv(log), 'care');
  const totals = log.find((l) => /COUNT\(\*\)/.test(l.sql));
  assert.ok(totals.sql.includes("' ' || title_terms || ' ' LIKE ?"), 'word-boundary padding is gone');
  assert.deepEqual(totals.params, ['% care %'], 'the bound pattern is not space-delimited');
});

test('input is normalized the way titles were normalized', async () => {
  // Uppercase, punctuation, and short words all fall away exactly as
  // titleTerms() drops them - otherwise the lookup and the catalogue disagree
  // about what a word is.
  const log = [];
  const out = await termCoverage(fakeEnv(log), '  Aerospace, ENGINEER!! at ');
  assert.deepEqual(out.terms, ['aerospace', 'engineer'], 'normalization diverged from titleTerms');
  const totals = log.find((l) => /COUNT\(\*\)/.test(l.sql));
  // aerospace expands to its industry family (selection matches families, and
  // coverage must count the same reach); every member binds its own padded
  // pattern, ORed within the term.
  assert.ok(totals.params.includes('% aerospace %'));
  assert.ok(totals.params.includes('% avionics %'), 'the aerospace family is not reaching the coverage query');
  assert.ok(totals.params.includes('% engineer %'));
  assert.ok(/\) AND \(/.test(totals.sql), 'terms should still AND while families OR');
});

test('coverage counts the same reach selection has', async () => {
  // The tool's one promise: its number predicts what a board would connect.
  // Selection expands families, so an employer advertising avionics but never
  // the word aerospace must count as aerospace coverage.
  const log = [];
  await termCoverage(fakeEnv(log), 'aerospace');
  const totals = log.find((l) => /COUNT\(\*\)/.test(l.sql));
  assert.ok(totals.params.length > 1, 'aerospace matched only its literal word - Anduril and SpaceX are invisible again');
  assert.ok(totals.sql.split('LIKE ?').length - 1 === totals.params.length, 'binds and placeholders diverged');
});

test('retired employers do not count as coverage', async () => {
  const log = [];
  await termCoverage(fakeEnv(log), 'aerospace');
  for (const call of log) {
    assert.ok(/failed_streak < 3/.test(call.sql), 'a struck-out employer is being counted as reachable');
  }
});

test('an unusable query is an error, not an empty result', async () => {
  // Empty and too-short input must be distinguishable from "the catalogue has
  // nothing" - one is a typo, the other is a gap worth acting on.
  const out = await termCoverage(fakeEnv([]), 'ab');
  assert.ok(out.error, 'a two-letter query silently returned a coverage result');
  const out2 = await termCoverage(fakeEnv([]), '');
  assert.ok(out2.error);
});

test('field rows carry human labels, unclassified included', async () => {
  const log = [];
  const out = await termCoverage(fakeEnv(log, {
    totals: { n: 12, jobs: 340 },
    byField: [
      { category: 'software', n: 10, jobs: 300 },
      { category: '', n: 2, jobs: 40 },
    ],
  }), 'aerospace');
  assert.equal(out.employers, 12);
  assert.equal(out.byField[0].label, 'Software and data');
  assert.equal(out.byField[1].label, 'unclassified', 'a category-less row should say so, not render blank');
});
