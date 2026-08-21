import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';

// The mobile layout is easy to break from the desktop, because the desktop is
// where changes get looked at. Each of these pins a defect that was measured on
// a 375px viewport before being fixed - not a style preference.

const appCss = () => fs.readFileSync(new URL('../public/assets/app.css', import.meta.url), 'utf8');
const appJs = () => fs.readFileSync(new URL('../public/assets/app.js', import.meta.url), 'utf8');
const landing = () => fs.readFileSync(new URL('../public/assets/landing.css', import.meta.url), 'utf8');

test('the jobs table cannot inflate the layout viewport', () => {
  // overflow: hidden clips but does not contain a table's min-content width -
  // it propagated up and the whole app rendered zoomed out to 681px on a 375px
  // phone. overflow-x: auto is what actually contains it.
  const css = appCss();
  const wrap = css.slice(css.indexOf('.table-wrap {'), css.indexOf('}', css.indexOf('.table-wrap {')));
  assert.ok(wrap.includes('overflow-x: auto'), 'the table wrap no longer scrolls internally');
  assert.ok(!/overflow: hidden/.test(wrap), 'overflow: hidden is back on the table wrap');
});

test('the job list becomes cards at phone width, with every cell alive', () => {
  const css = appCss();
  assert.ok(css.includes("'status  status actions'"), 'the card grid areas are gone');
  // The old strategy - dropping columns one by one - must stop where the card
  // begins, or the card renders with blanked place, pay and status cells. The
  // drop rules sit later in the file, so without the min-width scope they win.
  assert.ok(
    css.includes('@media (max-width: 1100px) and (min-width: 641px)'),
    'the pay-column drop is no longer scoped away from the card range'
  );
  assert.ok(
    css.includes('@media (max-width: 900px) and (min-width: 641px)'),
    'the place-column drop is no longer scoped away from the card range'
  );
  assert.ok(
    !/\.jobs__status-col,\s*\.jobs tbody td:nth-child\(7\)\s*\{\s*display:\s*none/.test(css),
    'the status column is hidden again at phone width, where the card needs it'
  );
});

test('board settings stays reachable on a phone', () => {
  // It is the only entry point for editing or deleting a board. Hiding it under
  // 880px meant a phone user could create a board and then never change it.
  assert.ok(
    !/#board-settings\s*\{\s*display:\s*none/.test(appCss()),
    'board settings is display:none again at some width'
  );
});

test('no form control invites the iOS focus zoom', () => {
  // Below 16px, iOS zooms the page on focus and leaves it zoomed. Two controls
  // needed more than the blanket rule: the status select, whose own rule sits
  // later in the file, and the recency select, which carried an inline
  // font-size that beat every stylesheet rule.
  const css = appCss();
  assert.ok(css.includes('select.status-select'), 'the status select escaped the 16px rule');
  assert.ok(css.includes('.recency .select,'), 'the recency select escaped the 16px rule');
  assert.ok(
    !appJs().includes("font-size:.8125rem'"),
    'an inline font-size is back on a select - it beats the 16px stylesheet rule'
  );
});

test('kanban cards can be moved without hovering', () => {
  // The move arrows were opacity: 0 until :hover, and a finger cannot hover -
  // drag-and-drop, which touch cannot do either, was the only visible way.
  const css = appCss();
  const idx = css.indexOf('@media (hover: none)');
  assert.ok(idx !== -1, 'the hover-none block is gone');
  assert.ok(
    css.slice(idx, idx + 300).includes('.kcard__move button'),
    'the arrows are not made visible where hover does not exist'
  );
});

test('opening a modal neither pops the keyboard nor leaves the drawer open', () => {
  const js = appJs();
  assert.ok(
    js.includes("matchMedia('(pointer: fine)').matches) focusable.focus()"),
    'the modal autofocuses unconditionally - on a phone that throws the keyboard over it'
  );
  const modal = js.slice(js.indexOf('function showModal'), js.indexOf('function closeModal'));
  assert.ok(
    modal.includes("classList.remove('sidebar-open')"),
    'a modal opened from the nav drawer leaves the drawer open behind it'
  );
});

test('the landing page keeps its touch sizing', () => {
  assert.ok(landing().includes('MOBILE ERGONOMICS'), 'the landing touch-size block is gone');
});
