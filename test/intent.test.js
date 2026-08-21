import test from 'node:test';
import assert from 'node:assert/strict';
import { wantsRemote, applyIntent } from '../src/intent.js';

test('a plain "remote" in the sentence asks for remote work', () => {
  // The reported case: "remote" was written in the box and onsite roles came
  // back anyway, because only emphatic phrasings were recognised.
  assert.equal(wantsRemote('Technical Program Manager, remote'), true);
  assert.equal(wantsRemote('remote technical program manager'), true);
  assert.equal(
    wantsRemote('Technical Program Manager at top tech company, remote, 250k base salary minimum'),
    true
  );
});

test('emphatic phrasings still work', () => {
  assert.equal(wantsRemote('fully remote TPM'), true);
  assert.equal(wantsRemote('remote-only TPM'), true);
  assert.equal(wantsRemote('100% remote'), true);
});

test('"remote" describing a place is not a working arrangement', () => {
  // These are onsite jobs whose field happens to use the word.
  assert.equal(wantsRemote('remote sensing engineer'), false);
  assert.equal(wantsRemote('remote site technician for oil rigs'), false);
  assert.equal(wantsRemote('remote patient monitoring nurse'), false);
});

test('naming another arrangement means they would accept it', () => {
  // "remote or hybrid" is the opposite of remote-only; filtering to remote
  // would discard half of what was asked for.
  assert.equal(wantsRemote('TPM, remote or hybrid'), false);
  assert.equal(wantsRemote('hybrid TPM in NYC'), false);
  assert.equal(wantsRemote('TPM, onsite'), false);
});

test('a negated mention is honoured', () => {
  assert.equal(wantsRemote('TPM, not remote'), false);
  assert.equal(wantsRemote('TPM, no remote roles'), false);
});

test('silence about location stays silent', () => {
  assert.equal(wantsRemote('backend engineer'), false);
  assert.equal(wantsRemote(''), false);
});

test('the form states, the sentence suggests', () => {
  // Changed deliberately. A bare "remote" in prose used to set the hard filter,
  // which excluded 91 of 108 matching postings for somebody who had simply
  // written the word. Prose now expresses a preference and the box expresses a
  // rule - which is what this module's own docstring already claimed.
  const { filters } = applyIntent({ remoteOnly: false }, 'TPM, remote');
  assert.ok(!filters.remoteOnly, 'prose must not set the hard filter');
  assert.equal(filters.remotePreferred, true, 'prose sets a preference');

  const insistent = applyIntent({ remoteOnly: false }, 'TPM, remote only');
  assert.equal(insistent.filters.remoteOnly, true, 'insisting is a rule');

  const explicit = applyIntent({ remoteOnly: true }, 'TPM, not remote');
  assert.equal(explicit.filters.remoteOnly, true, 'a ticked box is left alone');
});
