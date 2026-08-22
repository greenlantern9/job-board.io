import test from 'node:test';
import assert from 'node:assert/strict';
import { expandTerm } from '../src/synonyms.js';
import { heuristicScore } from '../src/rank.js';

// Why "Aerospace Program Manager" returned two jobs from a thirty-thousand
// employer catalogue: the industry word describes the employer, while
// selection matches title words - and aerospace employers do not put
// "aerospace" in titles. Measured live before the fix: Anduril's 2,237 titles
// carry avionics, propulsion, mission and rocket but not "aerospace"; SpaceX's
// 2,179 carry avionics, propulsion and satellite - not "aerospace" and not
// even "program". Both scored at or below a generic SaaS shop.

test('the industry family stands in for the industry word', () => {
  const family = expandTerm('aerospace');
  for (const word of ['avionics', 'propulsion', 'spacecraft', 'satellite']) {
    assert.ok(family.includes(word), 'aerospace family lost ' + word);
  }
  // The deliberately excluded words: airlines, marketing and product teams
  // use them, and a wrong synonym is worse than a missing one.
  for (const word of ['flight', 'launch', 'mission']) {
    assert.ok(!family.includes(word), word + ' crept into the aerospace family - it is ambiguous in titles');
  }
});

test('family hits flip the ordering the bug produced', () => {
  // The exact vocabularies measured on live boards, and the exact search.
  const anduril = new Set('program manager avionics propulsion flight mission launch rocket defense'.split(' '));
  const spacex = new Set('manager avionics propulsion satellite flight mission launch'.split(' '));
  const saas = new Set('program manager software account sales'.split(' '));

  const wanted = ['aerospace', 'program', 'manager'].map(expandTerm);
  const hits = (vocab) => wanted.filter((family) => family.some((term) => vocab.has(term))).length;

  assert.equal(hits(anduril), 3, 'Anduril should hit all three slots through its family words');
  assert.equal(hits(spacex), 2);
  assert.equal(hits(saas), 2);
  assert.ok(hits(anduril) > hits(saas), 'an aerospace employer must outrank a generic one for an aerospace search');
  // SpaceX ties the SaaS shop on hits; selection then breaks ties by size,
  // and 2,179 postings beat any small generic employer - which is the right
  // order even without the word.
});

test('an unknown word still matches literally', () => {
  assert.deepEqual(expandTerm('kubernetes'), ['kubernetes']);
});

test('an industry slot is satisfied by the employer; a role slot never is', () => {
  // The posting that motivated this: 'Program Manager, Mission Operations' at
  // Anduril, searched as 'Aerospace Program Manager'. Without employer context
  // it scored 20 - 'not the role you described' - and died below the model
  // gate before the model could read the company name. The employer's own
  // title corpus carries avionics and propulsion, which is what aerospace
  // means in titles.
  const job = { title: 'Program Manager, Mission Operations', company: 'Anduril Industries', location: '', description: '', remote: false };
  const prompt = 'Aerospace Program Manager';
  const corpus = 'senior avionics engineer propulsion technician mission software lead program manager';

  const without = heuristicScore(job, { prompt });
  const withCorpus = heuristicScore(job, { prompt, employerText: corpus });
  assert.ok(without.score < 35, 'the pre-fix score should sit below the model gate, or this test is not testing the bug');
  assert.ok(withCorpus.score >= 75, 'employer context should lift the true match to a strong admit');
  assert.ok(/industry is what this employer does/.test(withCorpus.reason), 'the reason must not claim the title contains a word it does not');

  // The guard: the role itself must still come from the posting. A marketing
  // job at the same aerospace employer gains nothing.
  const marketing = { title: 'Marketing Coordinator', company: 'Anduril Industries', location: '', description: '', remote: false };
  const guarded = heuristicScore(marketing, { prompt, employerText: corpus });
  assert.ok(guarded.score < 35, 'a role slot became employer-satisfiable - every posting at a PM shop now counts as a PM');
});
