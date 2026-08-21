import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const app = () => fs.readFileSync(new URL('../public/assets/app.js', import.meta.url), 'utf8');
const css = () => fs.readFileSync(new URL('../public/assets/app.css', import.meta.url), 'utf8');
const html = () => fs.readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');

test('the collapse control exists and describes what it controls', () => {
  const markup = html();
  assert.ok(markup.includes('id="sidebar-collapse"'), 'the collapse button is missing');
  assert.ok(markup.includes('aria-controls="sidebar"'), 'the button does not say what it controls');
  assert.ok(markup.includes('aria-expanded="true"'), 'the button does not report its state');
});

test('collapsing is confined to the wide layout', () => {
  const styles = css();
  // Below 881px the sidebar is already a drawer. Collapsing there would fight
  // the drawer for the same element.
  assert.ok(styles.includes('@media (min-width: 881px)'), 'the collapse styles are not width-scoped');
  assert.ok(styles.includes('.app.sidebar-collapsed {'), 'the collapsed column rule is missing');
  assert.ok(
    styles.includes('.app.sidebar-collapsed .topbar__menu'),
    'nothing brings the sidebar back once it is collapsed'
  );
});

test('a collapsed sidebar cannot be tabbed into', () => {
  // Something slid out of view must not still be reachable from the keyboard.
  // visibility mostly handles it; inert is the guarantee.
  assert.ok(app().includes('sidebar.inert ='), 'the collapsed sidebar is left in the tab order');
});

test('inert is scoped to the layout that can actually collapse', () => {
  // The bug this pins: a sidebar collapsed on a desktop keeps the class when the
  // window narrows, because the CSS simply stops applying. Setting inert from
  // the class alone left the mobile drawer sliding open and then ignoring every
  // tap - it looked completely fine and did nothing at all.
  const source = app();
  assert.ok(
    /sidebar\.inert =[^;]*wideLayout\.matches/.test(source),
    'inert is being set without checking the layout it belongs to'
  );
  assert.ok(
    source.includes("window.addEventListener('resize', applyNavInert)"),
    'nothing recomputes inert when the window changes size'
  );
  assert.ok(
    /applyNavInert\(\);\s*\}\);/.test(source),
    'the menu button does not recompute inert, so a stale value can survive a resize'
  );
});

test('the choice is remembered, and a refusal to store it is not fatal', () => {
  const source = app();
  assert.ok(source.includes("localStorage.setItem(COLLAPSED_KEY"), 'the collapse is not remembered');
  // Private browsing can refuse storage outright; the control should still work.
  const guarded = source.slice(source.indexOf('function setNavCollapsed'));
  assert.ok(
    guarded.slice(0, 600).includes('try {'),
    'storage is written without guarding against it being refused'
  );
});

test('motion can be turned off', () => {
  assert.ok(
    css().includes('@media (prefers-reduced-motion: reduce)'),
    'the sidebar animates regardless of what the reader asked for'
  );
});
