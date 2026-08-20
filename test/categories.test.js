import test from 'node:test';
import assert from 'node:assert/strict';
import { inferCategory } from '../src/categories.js';

test('a bare "engineer" prompt still means software', () => {
  // The software pattern accepts an unqualified "engineer" on purpose, because
  // that is what somebody typing it into the box means. The fix for job titles
  // was precedence, not narrowing this.
  assert.equal(inferCategory('engineer'), 'software');
  assert.equal(inferCategory('Senior Backend Engineer'), 'software');
  assert.equal(inferCategory('Site Reliability Engineer'), 'software');
});

test('engineers who are not software engineers are not filed as software', () => {
  // Measured on a real board: an HVAC manufacturer had 54 of its 108 postings
  // counted as software purely because software was tested first.
  assert.equal(inferCategory('Electrical Engineer'), 'trades');
  assert.equal(inferCategory('Technical Sales and Field Service Engineer'), 'trades');
  assert.equal(inferCategory('HVAC Installation Technician'), 'trades');
  assert.equal(inferCategory('Maintenance Engineer'), 'trades');
});

test('veterinary work is care', () => {
  // 285 of 297 postings on a veterinary board matched nothing at all before
  // this, because no pattern mentioned vets.
  assert.equal(inferCategory('Veterinarian'), 'care');
  assert.equal(inferCategory('Veterinary Technician'), 'care');
  assert.equal(inferCategory('Veterinary Receptionist'), 'care');
  assert.equal(inferCategory('Kennel Assistant'), 'care');
});

test('nothing recognisable stays uncategorised rather than being guessed at', () => {
  assert.equal(inferCategory('Chief of Staff'), 'other');
  assert.equal(inferCategory(''), 'other');
});

test('the categories that were already right stay right', () => {
  assert.equal(inferCategory('Videographer'), 'creative');
  assert.equal(inferCategory('Customer Success Manager'), 'support');
  assert.equal(inferCategory('Registered Nurse'), 'care');
  assert.equal(inferCategory('Account Executive'), 'sales');
  assert.equal(inferCategory('Product Manager'), 'product');
  assert.equal(inferCategory('Skateboarding Coach'), 'teaching');
});
