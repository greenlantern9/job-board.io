// job-boards.io - Cloudflare Worker entry point.
//
// The Worker sits in front of everything (assets.run_worker_first), so the
// apex redirect, security headers, and the session check on /app all apply to
// page loads as well as to /api/*.

import {
  json,
  unauthorized,
  notFound,
  forbidden,
  badRequest,
  getCookie,
  withSecurityHeaders,
  verifyOrigin,
  requiresJsonBody,
  escapeHtml,
  canonicalUrl,
  SESSION_COOKIE,
} from './src/http.js';
import { ensureSchema, run, nowIso } from './src/db.js';
import { loadSession, findUserById, purgeExpired } from './src/auth.js';
import { AUTH_ROUTES, verifyEmailToken } from './src/routes/auth.js';
import { APP_ROUTES } from './src/routes/app.js';
import { boardsDueForRefresh, refreshBoard } from './src/ingest.js';
import { curateBoard, boardsDueForCuration } from './src/curate.js';
import { topUpCatalogue, loadGreenhouseList, classifyBoards } from './src/directory.js';
import { runNotifications, applyUnsubscribe } from './src/notify.js';
import { adminGate, adminStats } from './src/admin.js';

const ROUTES = { ...AUTH_ROUTES, ...APP_ROUTES };

// One cron tick must finish inside the Worker's CPU budget, so refreshes are
// round-robined: boardsDueForRefresh orders by last_refresh ascending, and the
// boards that miss a tick lead the queue on the next one.
const BOARDS_PER_TICK = 5;

// Curation is far more expensive than a refresh - a model call plus up to two
// dozen outbound probes - so only a couple of boards are revisited per tick.
// boardsDueForCuration orders by staleness, so nothing is starved.
const BOARDS_CURATED_PER_TICK = 2;

const SESSION_TOUCH_MS = 60 * 60 * 1000;

async function buildContext(env, request) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return { token: null, session: null, user: null };
  const session = await loadSession(env, token);
  if (!session) return { token, session: null, user: null };
  const user = await findUserById(env, session.user_id);
  if (!user) return { token, session: null, user: null };
  return { token, session, user };
}

function htmlPage({ title, heading, body, linkHref, linkLabel }, status = 200) {
  // Standalone pages (unsubscribe, error states) that do not need the app
  // shell. Inline styles keep them independent of the asset bundle.
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  :root{color-scheme:dark}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d0e0a;color:#e8ebdd;
       font:400 16px/1.6 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:24px}
  .card{max-width:26rem;text-align:center}
  .mark{font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.2em;
        text-transform:uppercase;color:#c3f53c}
  h1{margin:.75rem 0 .5rem;font-size:1.6rem;letter-spacing:-.02em}
  p{margin:0 0 1.5rem;color:#9aa08a}
  a{display:inline-block;padding:.7rem 1.4rem;border-radius:999px;background:#c3f53c;color:#0d0e0a;
    font-weight:600;text-decoration:none}
</style></head>
<body><div class="card"><div class="mark">job-boards.io</div>
<h1>${escapeHtml(heading)}</h1><p>${escapeHtml(body)}</p>
${linkHref ? `<a href="${escapeHtml(linkHref)}">${escapeHtml(linkLabel)}</a>` : ''}
</div></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
  );
}

async function serveAsset(env, request, pathname) {
  const url = new URL(request.url);
  url.pathname = pathname;
  const response = await env.ASSETS.fetch(new Request(url.toString(), request));
  if (pathname.endsWith('.html')) {
    // The app shell is per-user once JavaScript runs; never let a shared cache
    // hold it.
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store');
    return new Response(response.body, { status: response.status, headers });
  }
  return response;
}

async function handleApi(request, env, executionCtx, url) {
  // CSRF: a cross-site form post cannot set Origin to us, and cannot send
  // application/json without a preflight we never answer.
  if (!verifyOrigin(request)) return forbidden('Request origin is not allowed.');
  if (!requiresJsonBody(request)) return badRequest('Send JSON.');

  const route = ROUTES[`${request.method} ${url.pathname}`];
  if (!route) return notFound('No such endpoint.');

  const ctx = await buildContext(env, request);

  // Handlers receive the auth context, not the runtime's ExecutionContext, so
  // background work (source discovery on board creation) needs waitUntil
  // bridged onto it. Without this the call is a TypeError that surfaces as a
  // generic 500 on an otherwise successful request.
  ctx.waitUntil = (promise) => executionCtx.waitUntil(promise);

  if (route.auth !== false) {
    if (!ctx.user || !ctx.session) return unauthorized();
    if (!ctx.session.mfa_satisfied && !route.partial) {
      return json({ error: 'Two-factor code required.', mfaRequired: true }, { status: 401 });
    }
  }

  // Keep last_seen_at roughly current for the session list without writing on
  // every single request.
  if (ctx.session && Date.now() - new Date(ctx.session.last_seen_at).getTime() > SESSION_TOUCH_MS) {
    executionCtx.waitUntil(
      run(env, 'UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', nowIso(), ctx.session.token_hash)
    );
  }

  return route.handler(request, env, ctx);
}

async function handleRequest(request, env, executionCtx) {
  const url = new URL(request.url);

  // Canonical host and scheme, so that cookies, CSP, and the Origin check all
  // agree with each other. See canonicalUrl() for why the comparison matters.
  const canonical = canonicalUrl(request);
  if (canonical !== request.url) {
    return Response.redirect(canonical, 301);
  }

  await ensureSchema(env);

  // The admin surface. Gated identically whether it is the page or its data,
  // because a dashboard whose API is open is not gated at all.
  if (url.pathname === '/admin' || url.pathname === '/api/admin/stats') {
    const ctx = await buildContext(env, request);
    const gate = await adminGate(env, request, ctx);

    if (!gate.ok) {
      // Someone signed out gets sent to sign in - that is an ordinary state, not
      // a refusal. Anyone else is told nothing: a signed-in non-owner learns
      // only that the path does not exist, which is the correct amount of
      // information to give them about somebody else's admin page.
      // Only the page redirects. An API that answers a signed-out caller with
      // a redirect is both wrong for the caller and a tell: every other unknown
      // /api/ path 404s, so a 302 here would confirm this one exists.
      if (gate.reason === 'signed-out') {
        if (url.pathname === '/admin') {
          return Response.redirect(new URL('/app', request.url).toString(), 302);
        }
        return notFound('No such endpoint.');
      }
      if (gate.reason === 'needs-2fa') {
        // This is the owner - telling them nothing would be unhelpful and buys
        // no security, since they can already prove who they are.
        return htmlPage(
          {
            title: 'Two-factor required',
            heading: 'Turn on two-factor first',
            body:
              'The admin page requires a second factor on this account. Open Account, set up two-factor authentication, then come back.',
            linkHref: '/app',
            linkLabel: 'Open your account',
          },
          403
        );
      }
      if (gate.reason === 'access') {
        return htmlPage(
          {
            title: 'Access required',
            heading: 'Cloudflare Access could not verify you',
            body: gate.detail || 'Sign in through Access and try again.',
            linkHref: '/app',
            linkLabel: 'Back to the app',
          },
          403
        );
      }
      return notFound('No such endpoint.');
    }

    if (url.pathname === '/api/admin/stats') {
      return json(await adminStats(env));
    }
    return serveAsset(env, request, '/admin.html');
  }

  if (url.pathname.startsWith('/api/')) {
    return handleApi(request, env, executionCtx, url);
  }

  // Email-confirmation link. Handled server-side so the token never reaches
  // client JavaScript or a Referer header.
  if (url.pathname === '/verify') {
    const ok = await verifyEmailToken(env, url.searchParams.get('token') || '');
    return htmlPage(
      ok
        ? {
            title: 'Email confirmed',
            heading: 'Address confirmed',
            body: 'Alerts can now reach you. Head back to your board.',
            linkHref: '/app',
            linkLabel: 'Open job-boards.io',
          }
        : {
            title: 'Link expired',
            heading: 'That link has expired',
            body: 'Confirmation links last 24 hours. Sign in and send yourself a fresh one.',
            linkHref: '/app',
            linkLabel: 'Sign in',
          },
      ok ? 200 : 400
    );
  }

  // Deployment status, deliberately public and deliberately minimal.
  //
  // Whether a key is configured is not a secret - the app's behaviour already
  // makes it obvious, since ranking visibly degrades without one. What this
  // adds is the ability to tell *which* Worker is answering for this domain,
  // which is exactly the question that could not be answered while secrets
  // appeared correct in the dashboard and invisible to the running code.
  //
  // Names and booleans only. No values, no key prefixes, no binding list.
  if (url.pathname === '/health') {
    return json({
      ok: true,
      worker: env.WORKER_NAME || '(unset - deploy has not run since this was added)',
      site: env.SITE_URL || '',
      features: {
        aiRanking: Boolean(env.ANTHROPIC_API_KEY),
        twoFactor: Boolean(env.TOTP_ENC_KEY),
        email: Boolean(env.RESEND_API_KEY),
      },
      time: nowIso(),
    });
  }

  if (url.pathname === '/unsubscribe') {
    const ok = await applyUnsubscribe(env, url.searchParams.get('token') || '');
    return htmlPage({
      title: ok ? 'Alert turned off' : 'Link not recognised',
      heading: ok ? 'Alert turned off' : 'We could not read that link',
      body: ok
        ? 'You will not get email from this alert again. Your other alerts are untouched.'
        : 'The link may have already been used, or it was cut short by your mail client.',
      linkHref: '/app',
      linkLabel: 'Manage alerts',
    });
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return serveAsset(env, request, '/index.html');
  }

  // Every app route is the same shell; the client router reads the path.
  if (
    url.pathname === '/app' ||
    url.pathname.startsWith('/app/') ||
    url.pathname === '/reset' ||
    url.pathname === '/signin' ||
    url.pathname === '/signup'
  ) {
    return serveAsset(env, request, '/app.html');
  }

  const asset = await serveAsset(env, request, url.pathname);
  if (asset.status === 404) {
    return htmlPage(
      {
        title: 'Not found',
        heading: 'Nothing here',
        body: 'That page does not exist.',
        linkHref: '/',
        linkLabel: 'Back to job-boards.io',
      },
      404
    );
  }
  return asset;
}

async function runCron(env) {
  await ensureSchema(env);
  await purgeExpired(env);

  const selfHost = new URL(env.SITE_URL || 'https://job-boards.io').hostname;

  // Revalidate source lists before refreshing, so a board that just had dead
  // sources retired and fresh ones connected pulls from the new set on this
  // same tick. Kept to a couple of boards because each one costs a model call
  // plus a burst of outbound probes.
  for (const board of await boardsDueForCuration(env, { limit: BOARDS_CURATED_PER_TICK })) {
    try {
      await curateBoard(env, board, { selfHost });
    } catch (err) {
      console.error('curation failed', board.id, err && err.stack ? err.stack : err);
    }
  }

  const due = await boardsDueForRefresh(env, { limit: BOARDS_PER_TICK });
  for (const board of due) {
    try {
      await refreshBoard(env, board, { selfHost });
    } catch (err) {
      // One board's failure must not stop the rest of the tick, or a single bad
      // board would starve every other user's schedule.
      await run(
        env,
        'UPDATE boards SET last_error = ?, last_refresh = ?, updated_at = ? WHERE id = ?',
        String(err.message || err).slice(0, 300),
        nowIso(),
        nowIso(),
        board.id
      );
    }
  }

  await runNotifications(env);

  // Grow the shared company catalogue in the background.
  //
  // Last, and deliberately so: it is the only part of the tick nobody is
  // waiting on. Discovery used to happen only when a board came up short at
  // creation, which put a web search on the critical path of somebody's first
  // impression and left fields nobody had asked for yet completely empty.
  // Filling it here means the slugs are already there when they are wanted.
  try {
    // Order matters, cheapest first. Loading the published list is local work.
    // Classifying reads boards we already know about. Only when both are done
    // does discovery pay to look for boards nobody has listed.
    await loadGreenhouseList(env);
    await classifyBoards(env, { selfHost });
    await topUpCatalogue(env, { selfHost });
  } catch (err) {
    console.error('catalogue work failed', err && err.stack ? err.stack : err);
  }
}

export default {
  async fetch(request, env, executionCtx) {
    try {
      return withSecurityHeaders(await handleRequest(request, env, executionCtx));
    } catch (err) {
      // Never leak a stack trace to the client; observability captures it.
      console.error('unhandled', err && err.stack ? err.stack : err);
      const accepts = request.headers.get('Accept') || '';
      if (accepts.includes('application/json') || new URL(request.url).pathname.startsWith('/api/')) {
        return withSecurityHeaders(json({ error: 'Something went wrong on our end.' }, { status: 500 }));
      }
      return withSecurityHeaders(
        htmlPage(
          {
            title: 'Error',
            heading: 'Something went wrong',
            body: 'That is on us. Try again in a moment.',
            linkHref: '/',
            linkLabel: 'Back to job-boards.io',
          },
          500
        )
      );
    }
  },

  async scheduled(event, env, executionCtx) {
    executionCtx.waitUntil(
      runCron(env).catch((err) => console.error('cron failed', err && err.stack ? err.stack : err))
    );
  },
};
