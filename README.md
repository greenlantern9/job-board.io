# job-boards.io

Pull openings from company job boards, rank them against criteria you write in
plain English, and track every application from first look to offer.

Runs as a single Cloudflare Worker with D1 for storage. No build step, no
framework, no external requests from the browser.

---

## What it does

- **Accounts** with optional TOTP two-factor auth, recovery codes, session
  management, email verification, and password reset.
- **Boards** hold your criteria — a free-text prompt *and* a structured filter
  form. Both feed the same ranking. **Three boards per account**: boards are the
  unit that multiplies cost, since each refreshes on its own schedule.
- **Sources are automatic, and wide by default.** Two layers:
  - **Cross-company aggregators** — Remotive, Arbeitnow, RemoteOK, Himalayas —
    are attached to every board and searched with a query derived from its
    criteria. These cover thousands of employers in one request and need no API
    key, so even a board that cannot run discovery is not limited to a handful
    of companies.
  - **Per-company ATS boards** — Greenhouse, Lever, Ashby, SmartRecruiters —
    discovered from the criteria, each probed live before connecting, so only
    companies with a reachable board and open roles get added.

  Re-checked weekly: dead or silent company boards are retired and replaced.
  Aggregators are never retired — a quiet week means the query matched nothing,
  not that the source died. Manual add still exists but is no longer a step
  anyone has to take.
- **Company curation.** Name companies you care about and either *prioritize*
  them (ranking boost) or *limit* the board to them (hard allowlist). Either
  way we find their job board for you. "Suggest similar companies" returns only
  verified boards with live openings.
- **Ranking** scores every job 0–100 with a one-line reason. A deterministic
  heuristic always runs; Claude refines it when an API key is configured.
- **Tracking** in a prioritized list view and a kanban board, sharing one record.
- **Alerts** by email — instant, daily digest, or weekly digest, deduplicated so
  a job is never announced twice.

---

## Setup

### 1. Install

```bash
npm install
```

npm may warn that `workerd` and `esbuild` have install scripts it held back.
Wrangler runs fine without approving them; only if it fails to start do you
need `npm approve-scripts --allow-scripts-pending`.

### 2. Create the database

```bash
npx wrangler d1 create job-board
```

Copy the printed `database_id` into `wrangler.jsonc`, replacing
`REPLACE_WITH_ID_FROM_WRANGLER_D1_CREATE`. The schema applies itself on first
request; to apply it up front:

```bash
npm run db:init
```

### 3. Set secrets

```bash
npx wrangler secret put PASSWORD_PEPPER     # strongly recommended - see below
npx wrangler secret put TOTP_ENC_KEY        # required before anyone can enable 2FA
npx wrangler secret put SESSION_PEPPER      # signs unsubscribe links
npx wrangler secret put ANTHROPIC_API_KEY   # optional - enables AI ranking
npx wrangler secret put RESEND_API_KEY      # optional - enables email
```

Generate the two random ones with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

`TOTP_ENC_KEY` encrypts stored 2FA secrets. **Do not rotate it** once anyone has
enrolled — existing secrets become undecryptable and those users are locked to
their recovery codes. The code fails closed rather than storing a secret it
cannot read back.

`PASSWORD_PEPPER` is HMAC'd into every password before it reaches PBKDF2. It
matters more than it looks: the Workers runtime caps PBKDF2 at 100,000
iterations (see below), which is under the OWASP recommendation, and the pepper
is what makes a stolen `users` table unattackable regardless — the secret is not
in the database, so there is nothing to guess against.

It is optional. Without it, hashes are written unpeppered and still verify; set
it later and each password upgrades silently on that user's next sign-in.
**Once set, do not rotate or remove it** — every peppered hash stops verifying
and those users need a password reset.

### 4. Deploy

```bash
npm run deploy
```

### 5. The domain

`wrangler.jsonc` already declares both `job-boards.io` and `www.job-boards.io`
as custom domains, so `npm run deploy` creates and maintains the DNS records
itself — there is no manual A/CNAME step. The zone just has to already exist in
the same Cloudflare account as the Worker.

The Worker 301s `www` to the apex, so one origin owns cookies, CSP, and the
CSRF origin check. That is why `www` is routed to the Worker rather than
redirected at the DNS layer — a redirect that never reaches the Worker cannot
run.

To move to a different domain later, one command rewrites every reference
(config, canonical tags, sitemap, TOTP issuer, email templates):

```bash
node scripts/set-domain.mjs example.com
```

For email, verify your sending domain in Resend and set `NOTIFY_FROM` in
`wrangler.jsonc` to an address on it.

---

## Running without the optional keys

The app is fully usable with neither optional secret set — that is deliberate,
so nothing is a hard dependency on a paid service:

| Missing | What happens |
| --- | --- |
| `ANTHROPIC_API_KEY` | Ranking uses the built-in heuristic only. Jobs still score 0–100 with reasons; the prompt is matched by keyword overlap rather than read. **Automatic source discovery is also off** — boards say so plainly and you add companies by hand. Naming companies in the board's company list still works, since finding their board is a probe, not a model call. |
| `RESEND_API_KEY` | Alerts are recorded as `skipped_no_provider` and shown that way in the Alerts panel. Nothing is sent, and nothing is silently lost. |

---

## How the ranking works

Two layers, and the first is always the floor:

1. **Heuristic** (`src/rank.js`) — deterministic 0–100 from criteria overlap
   (title matches count double), required keywords, remote match, published
   salary against your floor, seniority distance, curated-company membership,
   and **posting age, which is the heaviest single signal at up to ±22**.
   Applying early is one of the few things a candidate controls, so a good match
   from Tuesday outranks a perfect match from March. Undated postings are left
   neutral rather than penalised — many feeds simply omit the field. No network,
   no key, same input always gives the same number.

2. **Claude** (`src/scoring.js`) — batches of 15 jobs go to `claude-opus-5` with
   structured outputs, `effort: "medium"`, and the board's criteria in a cached
   system block. Jobs are sent highest-heuristic-first, so if the per-run batch
   ceiling is hit, the model looked at the ones most likely to matter. Any
   failure or refusal keeps that batch's heuristic score and surfaces a warning
   rather than leaving jobs unranked.

To use a cheaper model, set `SCORING_MODEL` in `wrangler.jsonc` — but note that
model choice is a cost decision, not a default: `claude-opus-5` is what ships.

### What a refresh costs

Spend per refresh is **bounded**, and it is worth understanding why. `scoreJobs`
gives every job a heuristic score, sends only the highest-ranked
`BATCH_SIZE * MAX_BATCHES_PER_RUN` (60) to the model, and then stamps
`scored_at` on **all** of them. Jobs that only got a heuristic score are not
retried on the next run, so a large ingestion cannot bill repeatedly.

That puts the ceiling at four batches per refresh — roughly **$0.30 at
`claude-opus-5` prices** — regardless of whether the board ingested 20 jobs or
800. With the daily cap, one board costs at most about **$9/month**, and less
whenever fewer than 60 new jobs turned up.

The trade-off: on a large first ingestion, most jobs keep a heuristic-only
score permanently. "Rescore" in the board menu re-runs the model over the
current top 60 when that matters.

Set a **spend limit on the Anthropic workspace** the key belongs to. It is the
only bound that holds regardless of what the code does.

---

## "Real-time" — what that actually means here

Worth being precise, because the word is doing a lot of work in most products:

- **Ingestion** runs on a Cron Trigger every 5 minutes, refreshing boards whose
  own interval has elapsed. Five boards per tick, oldest first, so one slow
  board cannot starve the rest.
- **Scheduled refreshes are capped at one a day** (daily, every two days, or
  weekly). This is the main cost lever: each refresh can spend up to four model
  batches on scoring, and postings do not appear fast enough for hourly to be
  worth 24× the bill. The Refresh button runs the whole pipeline on demand.
- **The open tab** polls `/api/jobs/changes?since=` every 20 seconds and patches
  only the rows that changed. It pauses while the tab is hidden.
- **Manual refresh** runs the whole pipeline immediately, rate-limited per user.

There is no WebSocket. Polling a narrow changes endpoint gets the same felt
result at a fraction of the cost and complexity, and it degrades to "slightly
stale" rather than "silently disconnected."

---

## Security notes

- Passwords: PBKDF2-SHA256 at 100,000 iterations with a per-user salt, an
  HMAC pepper from a Worker secret, and transparent rehash when the parameters
  move. Verification runs even for unknown emails so response timing does not
  reveal who has an account.

  100k is not a choice — **the Workers runtime refuses more than 100,000
  iterations**, throwing `NotSupportedError` above it, and `wrangler dev` does
  not enforce the ceiling. Setting it higher passes every local test and then
  throws on the first real signup in production. `test/crypto.test.js` pins this
  so it cannot regress. The pepper is the compensating control, since 100k alone
  is below the OWASP recommendation of 600k.
- Sessions: only `SHA-256(token)` is stored, so a database leak yields nothing
  replayable. A password change or reset kills every other session.
- 2FA: RFC 6238 TOTP, ±1 window, constant-time comparison, secrets AES-GCM
  encrypted at rest. Ten single-use recovery codes, stored hashed and shown once.
- CSRF: `SameSite=Lax` cookies plus an Origin/Referer check plus a required
  `application/json` content type on every state-changing request.
- SSRF: user-supplied feed URLs must be HTTPS and are refused if they resolve to
  localhost, link-local, private ranges, or back at this deployment.
- CSP is `script-src 'self'` with no CDN and no `eval` — which is why the QR
  encoder is written in-repo rather than pulled from a library.
- Signup never reveals whether an address is registered; the account owner finds
  out by email instead.

---

## Tests

```bash
npm test
```

70 unit tests, no network, no mocks worth the name. The ones that matter:

- **QR** — encode→decode round trip across all ten supported versions and both
  block groups, plus Reed-Solomon verified by the defining property (the
  codeword polynomial has roots at α⁰…αⁿ⁻¹) rather than a transcribed table.
- **TOTP** — the RFC 6238 test vectors.
- **Crypto** — hash/verify, tamper rejection, expiry, timing-safe comparison.
- **Sources** — salary parsing (including the numbers that must *not* parse as
  salaries), HTML flattening, filter precedence, and the full SSRF blocklist.
- **Ranking** — determinism, 0–100 bounds under hostile input, and the direction
  of every signal.
- **HTTP** — canonical host/scheme (including the internal-http-hop case that
  caused a redirect loop), the CSRF origin and content-type checks, and cookie
  parsing.

There is also an end-to-end script that walks the whole day-one path against a
running server — signup, board, live Greenhouse fetch, ranking, status change,
2FA enrollment, sign-out, TOTP challenge, recovery code, account deletion:

```bash
npx wrangler dev          # in one terminal
npm run test:e2e          # in another
```

It needs `.dev.vars` present (see Setup) and makes real requests to a public
Greenhouse board, which is why it is not part of `npm test`.

---

## Layout

```
worker.js              entry: routing, pages, cron
src/
  curate.js            automatic source discovery, validation, retirement
  suggest.js           company suggestions, verified against live ATS boards
  crypto.js            PBKDF2, AES-GCM, HMAC tokens, ids
  totp.js              RFC 6238
  qr.js                QR encoder (byte mode, ECC M, versions 1-10)
  http.js              JSON helpers, cookies, CSP, CSRF, rate limits
  db.js                schema bootstrap + query helpers
  auth.js              users, sessions, MFA, recovery codes
  sources.js           ATS + RSS connectors, normalization, filters
  rank.js              deterministic scoring heuristic
  scoring.js           Claude scoring with heuristic fallback
  ingest.js            board refresh orchestration
  notify.js            alert rules, email rendering, delivery
  routes/auth.js       auth + account endpoints
  routes/app.js        boards, sources, jobs, alerts
public/                landing page, app shell, CSS, client JS
```

---

## Known limits

- **Dark theme only.** A deliberate single look, not a missing light mode.
- **Email only.** SMS was scoped out; `notification_rules.channel` exists so a
  Twilio adapter drops in beside the email one without a migration.
- **Sources are ATS APIs and feeds**, not general web scraping. A company whose
  careers page is bespoke HTML with no feed cannot be added.
- **Salary parsing is conservative.** An unparseable range is left as raw text
  rather than guessed at, because that number feeds a filter.
- **The kanban ordering column exists but is not user-sortable yet** — cards
  order by score within a column.
