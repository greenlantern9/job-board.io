# job-board.io

Pull openings from company job boards, rank them against criteria you write in
plain English, and track every application from first look to offer.

Runs as a single Cloudflare Worker with D1 for storage. No build step, no
framework, no external requests from the browser.

---

## What it does

- **Accounts** with optional TOTP two-factor auth, recovery codes, session
  management, email verification, and password reset.
- **Boards** hold your criteria — a free-text prompt *and* a structured filter
  form. Both feed the same ranking.
- **Sources** pull from public ATS endpoints (Greenhouse, Lever, Ashby) or any
  RSS/Atom job feed. Each is tested before it is saved.
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

Wrangler needs its `workerd` and `esbuild` binaries, whose install scripts npm
holds back by default:

```bash
npm approve-scripts --allow-scripts-pending
```

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

### 4. Deploy

```bash
npm run deploy
```

### 5. Point the domain at it

In the Cloudflare dashboard, add a route for `job-board.io/*` and
`www.job-board.io/*` to the `job-board-io` Worker. The Worker 301s `www` to the
apex itself, so one origin owns cookies, CSP, and the CSRF origin check.

For email, verify your sending domain in Resend and set `NOTIFY_FROM` in
`wrangler.jsonc` to an address on it.

---

## Running without the optional keys

The app is fully usable with neither optional secret set — that is deliberate,
so nothing is a hard dependency on a paid service:

| Missing | What happens |
| --- | --- |
| `ANTHROPIC_API_KEY` | Ranking uses the built-in heuristic only. Jobs still score 0–100 with reasons; the prompt is matched by keyword overlap rather than read. |
| `RESEND_API_KEY` | Alerts are recorded as `skipped_no_provider` and shown that way in the Alerts panel. Nothing is sent, and nothing is silently lost. |

---

## How the ranking works

Two layers, and the first is always the floor:

1. **Heuristic** (`src/rank.js`) — deterministic 0–100 from criteria overlap
   (title matches count double), required keywords, remote match, published
   salary against your floor, posting age, and seniority distance. No network,
   no key, same input always gives the same number.

2. **Claude** (`src/scoring.js`) — batches of 15 jobs go to `claude-opus-5` with
   structured outputs, `effort: "medium"`, and the board's criteria in a cached
   system block. Jobs are sent highest-heuristic-first, so if the per-run batch
   ceiling is hit, the model looked at the ones most likely to matter. Any
   failure or refusal keeps that batch's heuristic score and surfaces a warning
   rather than leaving jobs unranked.

To use a cheaper model, set `SCORING_MODEL` in `wrangler.jsonc` — but note that
model choice is a cost decision, not a default: `claude-opus-5` is what ships.

---

## "Real-time" — what that actually means here

Worth being precise, because the word is doing a lot of work in most products:

- **Ingestion** runs on a Cron Trigger every 5 minutes, refreshing boards whose
  own interval (15 minutes to daily) has elapsed. Five boards per tick, oldest
  first, so one slow board cannot starve the rest.
- **The open tab** polls `/api/jobs/changes?since=` every 20 seconds and patches
  only the rows that changed. It pauses while the tab is hidden.
- **Manual refresh** runs the whole pipeline immediately, rate-limited per user.

There is no WebSocket. Polling a narrow changes endpoint gets the same felt
result at a fraction of the cost and complexity, and it degrades to "slightly
stale" rather than "silently disconnected."

---

## Security notes

- Passwords: PBKDF2-SHA256, 210k iterations, per-user salt, transparent rehash
  when the parameters move. Verification runs even for unknown emails so
  response timing does not reveal who has an account.
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

54 tests, no network, no mocks worth the name. The ones that matter:

- **QR** — encode→decode round trip across all ten supported versions and both
  block groups, plus Reed-Solomon verified by the defining property (the
  codeword polynomial has roots at α⁰…αⁿ⁻¹) rather than a transcribed table.
- **TOTP** — the RFC 6238 test vectors.
- **Crypto** — hash/verify, tamper rejection, expiry, timing-safe comparison.
- **Sources** — salary parsing (including the numbers that must *not* parse as
  salaries), HTML flattening, filter precedence, and the full SSRF blocklist.
- **Ranking** — determinism, 0–100 bounds under hostile input, and the direction
  of every signal.

---

## Layout

```
worker.js              entry: routing, pages, cron
src/
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
