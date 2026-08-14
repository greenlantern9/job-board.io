// Request/response plumbing: JSON helpers, cookies, security headers, CSRF.

export const SESSION_COOKIE = 'jb_session';

export function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function badRequest(message, extra = {}) {
  return json({ error: message, ...extra }, { status: 400 });
}

export function unauthorized(message = 'Sign in to continue', extra = {}) {
  return json({ error: message, ...extra }, { status: 401 });
}

export function forbidden(message = 'Not allowed') {
  return json({ error: message }, { status: 403 });
}

export function notFound(message = 'Not found') {
  return json({ error: message }, { status: 404 });
}

export function tooMany(message = 'Too many requests. Try again shortly.') {
  return json({ error: message }, { status: 429 });
}

/** Reads a JSON body, returning {} rather than throwing on malformed input. */
export async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}

export function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function setCookie(name, value, { maxAge, secure = true } = {}) {
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    // Lax rather than Strict: the email-verification link is a top-level
    // navigation from another origin and must arrive authenticated.
    'SameSite=Lax',
  ];
  if (secure) bits.push('Secure');
  if (maxAge !== undefined) bits.push(`Max-Age=${maxAge}`);
  return bits.join('; ');
}

export function clearCookie(name) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;
}

/**
 * CSRF defence for the JSON API. Two independent conditions must hold:
 *  - Origin (or Referer) matches this deployment, which a cross-site form post
 *    cannot forge.
 *  - Content-Type is application/json, which a simple form post cannot send
 *    without triggering a preflight we never answer.
 * Combined with SameSite=Lax cookies this closes the ordinary CSRF paths
 * without a token round trip.
 */
export function verifyOrigin(request) {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;

  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin) {
    try {
      return new URL(origin).host === url.host;
    } catch {
      return false;
    }
  }
  // No Origin header: fall back to Referer. Browsers always send one of the
  // two on a cross-origin state-changing request.
  const referer = request.headers.get('Referer');
  if (referer) {
    try {
      return new URL(referer).host === url.host;
    } catch {
      return false;
    }
  }
  return false;
}

export function requiresJsonBody(request) {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'DELETE') return true;
  const type = request.headers.get('Content-Type') || '';
  return type.includes('application/json');
}

const CSP = [
  "default-src 'self'",
  // The app is a single vanilla-JS bundle we ship ourselves; no CDN, no eval.
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  // Job listings link out, but nothing on our pages may be framed or post
  // elsewhere.
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

export function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', CSP);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * The canonical URL for a request: apex host, https scheme.
 *
 * Returns a string the caller compares against request.url - a redirect is only
 * warranted when they differ. That comparison is the whole point: a redirect to
 * the same URL is an unbounded loop rather than a visible error, and this
 * codebase has produced that bug twice.
 *
 * The visitor's scheme comes from CF-Visitor, not url.protocol. Cloudflare
 * terminates TLS before the Worker runs, so url.protocol describes an internal
 * hop and says nothing about how the browser actually connected.
 */
export function canonicalUrl(request) {
  const target = new URL(request.url);

  if (target.hostname.startsWith('www.')) {
    target.hostname = target.hostname.slice(4);
  }

  // Local development is served over plaintext on purpose.
  const isLocal = /^(localhost$|127\.|\[?::1\]?$|0\.0\.0\.0$)/.test(target.hostname);
  if (!isLocal) {
    let scheme = null;
    try {
      scheme = JSON.parse(request.headers.get('CF-Visitor') || '{}').scheme || null;
    } catch {
      scheme = null;
    }
    if (scheme === 'http') target.protocol = 'https:';
  }

  return target.toString();
}

export function clientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() ||
    'unknown'
  );
}

/**
 * Consumes one token from a Cloudflare rate-limit binding. Returns true when
 * the request may proceed. Fails open if the binding is absent (local `wrangler
 * dev` without the unsafe binding) rather than locking everyone out.
 */
export async function allowRate(binding, key) {
  if (!binding || typeof binding.limit !== 'function') return true;
  try {
    const { success } = await binding.limit({ key });
    return success;
  } catch {
    return true;
  }
}

/** HTML-escape for anything user-controlled that reaches an email or SVG. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
