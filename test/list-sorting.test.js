import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';

import { comparator, DEFAULT_DIR } from '../public/assets/list-sort.js';

const app = () => fs.readFileSync(new URL('../public/assets/app.js', import.meta.url), 'utf8');
const html = () => fs.readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');

const order = (jobs, key, dir) => [...jobs].sort(comparator(key, dir)).map((j) => j.id);

test('every sortable column is a real button, and only those columns', () => {
  const markup = html();
  for (const key of ['score', 'posted', 'title', 'company', 'pay']) {
    assert.ok(markup.includes(`data-sort="${key}"`), `no sort control for ${key}`);
  }
  // Location, Status and the actions column stay plain headers.
  assert.equal(markup.match(/data-sort="/g).length, 5, 'a column is sortable that should not be');
  // Inside a clickable row a bare type would submit-by-default; and CSP is
  // script-src 'self', so behaviour must attach in app.js, never inline.
  assert.ok(markup.match(/class="th-sort"/g).length === 5 && !markup.includes('onclick='));
  for (const m of markup.match(/<button[^>]*th-sort[^>]*>/g)) {
    assert.ok(m.includes('type="button"'), `sort button missing type="button": ${m}`);
  }
});

test('score sorts as a number, not as text', () => {
  // 9 / 87 / 100 is the case string comparison gets backwards.
  const jobs = [
    { id: 'mid', score: 87 },
    { id: 'low', score: 9 },
    { id: 'high', score: 100 },
  ];
  assert.deepEqual(order(jobs, 'score', 'desc'), ['high', 'mid', 'low']);
  assert.deepEqual(order(jobs, 'score', 'asc'), ['low', 'mid', 'high']);
});

test('posted orders by date, undated last in both directions', () => {
  const jobs = [
    { id: 'old', postedAt: '2026-07-01T00:00:00Z' },
    { id: 'none' },
    { id: 'new', postedAt: '2026-08-20T00:00:00Z' },
    { id: 'bad', postedAt: 'not a date' },
  ];
  assert.deepEqual(order(jobs, 'posted', 'desc'), ['new', 'old', 'none', 'bad']);
  // Flipping to oldest-first must not bury the dated rows under the unknowns.
  assert.deepEqual(order(jobs, 'posted', 'asc'), ['old', 'new', 'none', 'bad']);
});

test('titles and companies compare alphabetically, ignoring case', () => {
  const jobs = [
    { id: 'z', title: 'zookeeper', company: 'Zebra Corp' },
    { id: 'a', title: 'Analyst', company: 'acme' },
    { id: 'b', title: 'baker', company: 'Bristol Ltd' },
  ];
  assert.deepEqual(order(jobs, 'title', 'asc'), ['a', 'b', 'z']);
  assert.deepEqual(order(jobs, 'company', 'desc'), ['z', 'b', 'a']);
});

test('pay sorts by the top of the range; a lone minimum still counts; unknown last', () => {
  const jobs = [
    { id: 'range', salaryMin: 100000, salaryMax: 150000 },
    { id: 'minonly', salaryMin: 160000 },
    { id: 'unknown' },
    { id: 'top', salaryMin: 120000, salaryMax: 200000 },
  ];
  assert.deepEqual(order(jobs, 'pay', 'desc'), ['top', 'minonly', 'range', 'unknown']);
  assert.deepEqual(order(jobs, 'pay', 'asc'), ['range', 'minonly', 'top', 'unknown']);
});

test('first click matches how each column is read', () => {
  // Best score, newest posting and highest pay first; names A to Z.
  assert.deepEqual(DEFAULT_DIR, {
    score: 'desc',
    posted: 'desc',
    title: 'asc',
    company: 'asc',
    pay: 'desc',
  });
});

test('a header click never reaches the server', () => {
  const source = app();
  // The click cycle re-renders what is loaded; state.sort and loadJobs belong
  // to the segmented Best fit / Newest control alone.
  const start = source.indexOf('DEFAULT_DIR[key]');
  assert.ok(start > 0, 'the header click cycle is missing');
  const cycle = source.slice(start, start + 400);
  assert.ok(cycle.includes('renderList()'), 'a header click does not re-render the list');
  assert.ok(!cycle.includes('loadJobs'), 'a header click re-fetches');
  assert.ok(!cycle.includes('state.sort ='), 'a header click leaks into the server sort param');
  // And the rows are sorted as a copy, so clearing falls back to the server
  // order without another fetch.
  assert.ok(source.includes('[...state.jobs].sort(comparator('), 'renderList sorts state.jobs in place');
});

test('the header sort resets when the rows baseline changes', () => {
  const source = app();
  const selectBoard = source.slice(source.indexOf('function selectBoard'));
  assert.ok(
    selectBoard.slice(0, 300).includes('state.listSort = null'),
    'switching boards keeps a stale header sort'
  );
  assert.ok(
    /state\.sort = key;\s*state\.listSort = null;/.test(source),
    'the Best fit / Newest control keeps a stale header sort'
  );
});

test('the active column announces its direction', () => {
  const source = app();
  assert.ok(source.includes("setAttribute('aria-sort'"), 'no aria-sort on the active column');
  assert.ok(
    source.includes("removeAttribute('aria-sort')"),
    'stale aria-sort survives on inactive columns'
  );
  // The indicator is redrawn from state on every list render, which is what
  // lets it survive the re-renders polling and status changes trigger.
  const renderListBody = source.slice(source.indexOf('function renderList('));
  assert.ok(
    renderListBody.slice(0, 200).includes('renderSortHeaders()'),
    'renderList does not redraw the header state'
  );
});
