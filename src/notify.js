// Notification rules and email delivery.
//
// Everything is written to the notifications table before a send is attempted,
// so a provider outage shows up in the UI as a failed row instead of silently
// vanishing. Without RESEND_API_KEY the rows are recorded as
// 'skipped_no_provider' - nothing is sent, and the settings page says so.

import { queryAll, queryOne, run, nowIso, parseJson } from './db.js';
import { newId, signToken, verifyToken } from './crypto.js';
import { escapeHtml } from './http.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const MAX_JOBS_PER_EMAIL = 25;

export const TRIGGER_KINDS = ['instant', 'digest_daily', 'digest_weekly'];

function signingSecret(env) {
  // Reuse the session pepper: this only signs unsubscribe links, whose worst
  // case is an attacker disabling their own notifications.
  return env.SESSION_PEPPER || env.TOTP_ENC_KEY || 'job-boards-dev-secret';
}

export async function unsubscribeLink(env, rule) {
  const token = await signToken(signingSecret(env), {
    rid: rule.id,
    uid: rule.user_id,
    exp: Date.now() + 365 * 86400000,
  });
  return `${env.SITE_URL || 'https://job-boards.io'}/unsubscribe?token=${encodeURIComponent(token)}`;
}

export async function applyUnsubscribe(env, token) {
  const payload = await verifyToken(signingSecret(env), token);
  if (!payload || !payload.rid) return false;
  const result = await run(
    env,
    'UPDATE notification_rules SET enabled = 0 WHERE id = ? AND user_id = ?',
    payload.rid,
    payload.uid
  );
  return (result.meta && result.meta.changes) > 0;
}

// --- matching --------------------------------------------------------------

function keywordMatch(job, keywords) {
  const terms = String(keywords || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = `${job.title} ${job.company} ${job.location} ${job.description}`.toLowerCase();
  return terms.some((t) => haystack.includes(t));
}

/** Jobs a rule would announce right now: scored, above threshold, not yet
 *  announced, and still in an un-acted-on state. */
async function candidateJobs(env, rule, { since }) {
  const params = [rule.user_id, rule.min_score];
  // closed_at is checked explicitly rather than relying on closed jobs having
  // been archived: emailing someone about a listing that no longer exists is
  // the worst possible moment to be wrong about it.
  let sql = `SELECT * FROM jobs
             WHERE user_id = ? AND score >= ? AND scored_at <> ''
               AND notified_at = '' AND closed_at = '' AND status IN ('new', 'saved')`;
  if (rule.board_id) {
    sql += ' AND board_id = ?';
    params.push(rule.board_id);
  }
  if (since) {
    sql += ' AND discovered_at >= ?';
    params.push(since);
  }
  sql += ' ORDER BY score DESC, discovered_at DESC LIMIT ?';
  params.push(MAX_JOBS_PER_EMAIL);

  const rows = await queryAll(env, sql, ...params);
  return rows.filter((job) => keywordMatch(job, rule.keywords));
}

/** Whether a digest rule is due, respecting the user's local send hour. */
export function digestIsDue(rule, { timezone = 'UTC', now = new Date() } = {}) {
  const periodMs = rule.trigger_kind === 'digest_weekly' ? 7 * 86400000 : 86400000;
  if (rule.last_sent_at) {
    const elapsed = now.getTime() - new Date(rule.last_sent_at).getTime();
    // A little under a full period, so a send that drifts late by a few minutes
    // does not push the next one a whole day out.
    if (elapsed < periodMs - 30 * 60000) return false;
  }
  let localHour;
  try {
    localHour = Number(
      new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false }).format(now)
    );
  } catch {
    localHour = now.getUTCHours();
  }
  return localHour === (Number(rule.send_hour) || 8);
}

// --- rendering -------------------------------------------------------------

function money(job) {
  if (job.salary_raw) return job.salary_raw;
  if (job.salary_min && job.salary_max) {
    return `$${job.salary_min.toLocaleString()} - $${job.salary_max.toLocaleString()}`;
  }
  if (job.salary_min) return `from $${job.salary_min.toLocaleString()}`;
  return '';
}

export function renderEmail({ jobs, heading, intro, appUrl, unsubscribeUrl }) {
  const rows = jobs
    .map((job) => {
      const meta = [job.company, job.location || (job.remote ? 'Remote' : ''), money(job)]
        .filter(Boolean)
        .map(escapeHtml)
        .join(' &middot; ');
      return `
      <tr><td style="padding:16px 0;border-bottom:1px solid #e6e6e6;">
        <div style="font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#5b6b3a;letter-spacing:.08em;">
          ${job.score}<span style="color:#9aa08a;"> / 100</span>
        </div>
        <a href="${escapeHtml(job.url)}" style="display:block;margin:6px 0 4px;font:600 17px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#14150f;text-decoration:none;">
          ${escapeHtml(job.title)}
        </a>
        <div style="font:400 14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#5f6357;">${meta}</div>
        ${job.score_reason ? `<div style="margin-top:6px;font:400 13px/1.5 -apple-system,sans-serif;color:#7a7f70;">${escapeHtml(job.score_reason)}</div>` : ''}
      </td></tr>`;
    })
    .join('');

  const text = [
    heading,
    '',
    ...jobs.map(
      (job) =>
        `[${job.score}] ${job.title} - ${job.company}${job.location ? ` (${job.location})` : ''}\n${job.url}`
    ),
    '',
    `Open your board: ${appUrl}`,
    `Stop these emails: ${unsubscribeUrl}`,
  ].join('\n');

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f6f6f2;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f2;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;padding:32px;">
        <tr><td>
          <div style="font:600 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:#8a9160;">job-boards.io</div>
          <h1 style="margin:14px 0 6px;font:600 24px/1.25 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#14150f;">${escapeHtml(heading)}</h1>
          <p style="margin:0;font:400 15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#5f6357;">${escapeHtml(intro)}</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">${rows}</table>
          <a href="${escapeHtml(appUrl)}" style="display:inline-block;margin-top:24px;padding:12px 22px;background:#14150f;color:#f2f4e6;border-radius:999px;font:600 14px/1 -apple-system,sans-serif;text-decoration:none;">Open your board</a>
          <p style="margin:28px 0 0;font:400 12px/1.6 -apple-system,sans-serif;color:#9aa08a;">
            You set up this alert on job-boards.io.
            <a href="${escapeHtml(unsubscribeUrl)}" style="color:#9aa08a;">Turn it off</a>.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;

  return { html, text };
}

// --- delivery --------------------------------------------------------------

async function deliver(env, { to, subject, html, text }) {
  if (!env.RESEND_API_KEY) {
    return { status: 'skipped_no_provider', error: 'No email provider configured (RESEND_API_KEY).' };
  }
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.NOTIFY_FROM || 'alerts@job-boards.io',
        to: [to],
        subject,
        html,
        text,
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      return { status: 'failed', error: `${res.status}: ${detail.slice(0, 200)}` };
    }
    return { status: 'sent', error: '' };
  } catch (err) {
    return { status: 'failed', error: String(err.message || err).slice(0, 200) };
  }
}

/**
 * Records the notification and attempts delivery. The unique index on
 * dedupe_key is what actually guarantees a job is never announced twice by the
 * same rule, even if two cron ticks overlap.
 */
async function sendNotification(env, { user, rule, jobs, heading, intro, dedupeKey }) {
  const existing = await queryOne(
    env,
    'SELECT id FROM notifications WHERE dedupe_key = ?',
    dedupeKey
  );
  if (existing) return null;

  const appUrl = `${env.SITE_URL || 'https://job-boards.io'}/app`;
  const unsubscribeUrl = await unsubscribeLink(env, rule);
  const { html, text } = renderEmail({ jobs, heading, intro, appUrl, unsubscribeUrl });
  const subject =
    jobs.length === 1 ? `${jobs[0].title} - ${jobs[0].company}` : `${jobs.length} matches on your board`;

  const id = newId('ntf_');
  try {
    await run(
      env,
      `INSERT INTO notifications (id, user_id, rule_id, channel, subject, body, status, dedupe_key, job_count, created_at)
       VALUES (?, ?, ?, 'email', ?, ?, 'queued', ?, ?, ?)`,
      id,
      user.id,
      rule.id,
      subject,
      text.slice(0, 4000),
      dedupeKey,
      jobs.length,
      nowIso()
    );
  } catch {
    // Unique-index collision: another tick already claimed this send.
    return null;
  }

  const result = await deliver(env, { to: user.email, subject, html, text });
  await run(
    env,
    'UPDATE notifications SET status = ?, error = ?, sent_at = ? WHERE id = ?',
    result.status,
    result.error,
    result.status === 'sent' ? nowIso() : '',
    id
  );

  if (result.status === 'sent' || result.status === 'skipped_no_provider') {
    // Mark the jobs either way: with no provider configured, re-queuing the
    // same jobs every five minutes would just fill the table.
    await env.DB.batch(
      jobs.map((job) => env.DB.prepare('UPDATE jobs SET notified_at = ? WHERE id = ?').bind(nowIso(), job.id))
    );
    await run(env, 'UPDATE notification_rules SET last_sent_at = ? WHERE id = ?', nowIso(), rule.id);
  }

  return { id, status: result.status, jobCount: jobs.length };
}

/**
 * Evaluates every enabled rule. Called from the cron handler after refreshes,
 * so newly-ingested jobs are eligible on the same tick.
 */
export async function runNotifications(env) {
  const rules = await queryAll(env, 'SELECT * FROM notification_rules WHERE enabled = 1');
  const sent = [];

  for (const rule of rules) {
    const user = await queryOne(env, 'SELECT * FROM users WHERE id = ?', rule.user_id);
    // An unverified address must never receive mail - that is how a signup form
    // becomes someone else's spam problem.
    if (!user || !user.email_verified) continue;

    if (rule.trigger_kind === 'instant') {
      const jobs = await candidateJobs(env, rule, {});
      for (const job of jobs) {
        const result = await sendNotification(env, {
          user,
          rule,
          jobs: [job],
          heading: 'A strong match just landed',
          intro: `Scored ${job.score}/100 against your criteria.`,
          dedupeKey: `${rule.id}:${job.id}`,
        });
        if (result) sent.push(result);
      }
      continue;
    }

    if (!digestIsDue(rule, { timezone: user.timezone, now: new Date() })) continue;
    const jobs = await candidateJobs(env, rule, {});
    if (jobs.length === 0) continue;

    const period = rule.trigger_kind === 'digest_weekly' ? 'week' : 'day';
    const stamp = new Date().toISOString().slice(0, 10);
    const result = await sendNotification(env, {
      user,
      rule,
      jobs,
      heading: `${jobs.length} new match${jobs.length === 1 ? '' : 'es'} this ${period}`,
      intro: 'Ranked highest first, against the criteria on your board.',
      dedupeKey: `${rule.id}:${period}:${stamp}`,
    });
    if (result) sent.push(result);
  }

  return sent;
}

/** Verification and password-reset mail, sent outside the rules engine. */
export async function sendTransactional(env, { to, subject, heading, body, actionUrl, actionLabel }) {
  const html = `<!doctype html><html><body style="margin:0;background:#f6f6f2;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border-radius:14px;padding:32px;">
        <tr><td>
          <div style="font:600 13px/1 ui-monospace,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:#8a9160;">job-boards.io</div>
          <h1 style="margin:14px 0 10px;font:600 22px/1.3 -apple-system,'Segoe UI',sans-serif;color:#14150f;">${escapeHtml(heading)}</h1>
          <p style="margin:0 0 24px;font:400 15px/1.6 -apple-system,'Segoe UI',sans-serif;color:#5f6357;">${escapeHtml(body)}</p>
          <a href="${escapeHtml(actionUrl)}" style="display:inline-block;padding:12px 22px;background:#14150f;color:#f2f4e6;border-radius:999px;font:600 14px/1 -apple-system,sans-serif;text-decoration:none;">${escapeHtml(actionLabel)}</a>
          <p style="margin:24px 0 0;font:400 12px/1.6 -apple-system,sans-serif;color:#9aa08a;">If you did not request this, you can ignore this email.</p>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
  const text = `${heading}\n\n${body}\n\n${actionUrl}\n`;
  return deliver(env, { to, subject, html, text });
}

export async function listNotifications(env, userId, limit = 30) {
  return queryAll(
    env,
    `SELECT id, subject, status, error, job_count, created_at, sent_at
     FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    userId,
    limit
  );
}

export function ruleToPublic(rule) {
  return {
    id: rule.id,
    boardId: rule.board_id || '',
    channel: rule.channel,
    trigger: rule.trigger_kind,
    minScore: rule.min_score,
    keywords: rule.keywords,
    sendHour: rule.send_hour,
    enabled: Boolean(rule.enabled),
    lastSentAt: rule.last_sent_at,
  };
}

export { parseJson };
