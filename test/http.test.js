import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalUrl, verifyOrigin, requiresJsonBody, escapeHtml, getCookie } from '../src/http.js';

const req = (url, headers = {}, method = 'GET') => new Request(url, { method, headers });

// A real request from a browser over TLS, as Cloudflare presents it.
const https = { 'CF-Visitor': '{"scheme":"https"}' };
const plaintext = { 'CF-Visitor': '{"scheme":"http"}' };

test('a canonical request is left alone', () => {
  const url = 'https://job-boards.io/app';
  assert.equal(canonicalUrl(req(url, https)), url);
});

test('www is folded onto the apex', () => {
  assert.equal(
    canonicalUrl(req('https://www.job-boards.io/app?x=1', https)),
    'https://job-boards.io/app?x=1'
  );
});

test('a plaintext visitor is upgraded to https', () => {
  assert.equal(canonicalUrl(req('http://job-boards.io/', plaintext)), 'https://job-boards.io/');
});

test('www and plaintext are fixed in the same hop', () => {
  assert.equal(
    canonicalUrl(req('http://www.job-boards.io/app', plaintext)),
    'https://job-boards.io/app'
  );
});

// This is the regression that mattered. Cloudflare terminates TLS before the
// Worker, so an internal http:// URL does NOT mean the visitor used plaintext.
// Redirecting on url.protocol alone produced an infinite loop.
test('an internal http hop is not mistaken for a plaintext visitor', () => {
  const url = 'http://job-boards.io/robots.txt';
  assert.equal(canonicalUrl(req(url, https)), url, 'must not redirect a TLS visitor');
});

test('a missing or malformed CF-Visitor header never triggers a redirect', () => {
  const url = 'http://job-boards.io/robots.txt';
  assert.equal(canonicalUrl(req(url)), url);
  assert.equal(canonicalUrl(req(url, { 'CF-Visitor': 'not json' })), url);
  assert.equal(canonicalUrl(req(url, { 'CF-Visitor': '{}' })), url);
  assert.equal(canonicalUrl(req(url, { 'CF-Visitor': 'null' })), url);
});

test('local development is never upgraded', () => {
  for (const url of [
    'http://localhost:8787/robots.txt',
    'http://127.0.0.1:8787/',
    'http://0.0.0.0:8787/app',
  ]) {
    assert.equal(canonicalUrl(req(url, plaintext)), url, url);
  }
});

test('a host merely starting with "www" is not truncated', () => {
  // "wwwx.example.com" must survive; only the "www." label is a prefix.
  const url = 'https://wwwx.job-boards.io/';
  assert.equal(canonicalUrl(req(url, https)), url);
});

// --- CSRF surface ----------------------------------------------------------

test('safe methods bypass the origin check', () => {
  assert.equal(verifyOrigin(req('https://job-boards.io/api/boards')), true);
});

test('a same-origin mutation passes, a cross-origin one does not', () => {
  const ok = req('https://job-boards.io/api/boards/create', { Origin: 'https://job-boards.io' }, 'POST');
  const evil = req('https://job-boards.io/api/boards/create', { Origin: 'https://evil.test' }, 'POST');
  assert.equal(verifyOrigin(ok), true);
  assert.equal(verifyOrigin(evil), false);
});

test('a mutation with neither Origin nor Referer is refused', () => {
  assert.equal(verifyOrigin(req('https://job-boards.io/api/boards/create', {}, 'POST')), false);
});

test('Referer is the fallback when Origin is absent', () => {
  const ok = req('https://job-boards.io/api/x', { Referer: 'https://job-boards.io/app' }, 'POST');
  const evil = req('https://job-boards.io/api/x', { Referer: 'https://evil.test/x' }, 'POST');
  assert.equal(verifyOrigin(ok), true);
  assert.equal(verifyOrigin(evil), false);
});

test('a malformed Origin is refused rather than throwing', () => {
  assert.equal(verifyOrigin(req('https://job-boards.io/api/x', { Origin: 'garbage' }, 'POST')), false);
});

test('only JSON bodies are accepted on mutations', () => {
  const json = req('https://job-boards.io/api/x', { 'Content-Type': 'application/json' }, 'POST');
  const form = req(
    'https://job-boards.io/api/x',
    { 'Content-Type': 'application/x-www-form-urlencoded' },
    'POST'
  );
  assert.equal(requiresJsonBody(json), true);
  // A simple form post is the shape a cross-site CSRF attempt can actually send.
  assert.equal(requiresJsonBody(form), false);
  assert.equal(requiresJsonBody(req('https://job-boards.io/api/x')), true);
});

// --- helpers ---------------------------------------------------------------

test('escapeHtml neutralises the injection characters', () => {
  assert.equal(
    escapeHtml('<script>alert("x") & \'y\'</script>'),
    '&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;'
  );
  assert.equal(escapeHtml(null), '');
});

test('cookies are read by exact name', () => {
  const request = req('https://job-boards.io/', { Cookie: 'other=1; jb_session=abc123; jb=2' });
  assert.equal(getCookie(request, 'jb_session'), 'abc123');
  assert.equal(getCookie(request, 'jb'), '2');
  assert.equal(getCookie(request, 'missing'), null);
  assert.equal(getCookie(req('https://job-boards.io/'), 'jb_session'), null);
});
