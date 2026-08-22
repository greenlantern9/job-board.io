import test from 'node:test';
import assert from 'node:assert/strict';
import { expandTerm } from '../src/synonyms.js';

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
