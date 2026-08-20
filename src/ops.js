// Operational visibility: what is breaking for people, and what they are asking
// for.
//
// Both used to be invisible. Failures were written wherever they happened - a
// board's last_error column, a source's last_error, a console line nobody
// reads - so each was legible only to whoever went looking in exactly the right
// row. An admin page that reported an entirely dead script as "Loading…" for
// hours is what that costs.

import { queryAll, queryOne, run, nowIso } from './db.js';
import { newId } from './crypto.js';

/** How much of a message is worth keeping. Long enough to identify the fault,
 *  short enough that a bad loop cannot fill the database. */
const MESSAGE_LIMIT = 400;
const CONTEXT_LIMIT = 300;

/**
 * Record something that went wrong for a user.
 *
 * Never throws. Logging is not worth failing a request over, and a logger that
 * can break the thing it is watching is worse than no logger.
 */
export async function recordError(env, { userId = '', kind, message, context = '' } = {}) {
  if (!kind) return;
  try {
    await run(
      env,
      `INSERT INTO error_log (id, user_id, kind, message, context, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      newId('err_'),
      String(userId || '').slice(0, 64),
      String(kind).slice(0, 60),
      String(message || '').slice(0, MESSAGE_LIMIT),
      typeof context === 'string' ? context.slice(0, CONTEXT_LIMIT) : JSON.stringify(context).slice(0, CONTEXT_LIMIT),
      nowIso()
    );
  } catch {
    // Deliberately silent.
  }
}

/** Recent failures, newest first, with the account they happened to. */
export async function recentErrors(env, { limit = 40 } = {}) {
  return queryAll(
    env,
    `SELECT e.id, e.kind, e.message, e.context, e.created_at, u.email
     FROM error_log e
     LEFT JOIN users u ON u.id = e.user_id
     ORDER BY e.created_at DESC
     LIMIT ?`,
    Math.min(200, Math.max(1, limit))
  );
}

/** Failures grouped by kind over a window, so a spike is visible as a spike. */
export async function errorSummary(env, { hours = 24 } = {}) {
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  return queryAll(
    env,
    `SELECT kind, COUNT(*) AS n, MAX(created_at) AS latest
     FROM error_log WHERE created_at >= ?
     GROUP BY kind ORDER BY n DESC`,
    since
  );
}

/**
 * Accounts and what they are doing.
 *
 * Addresses are included because this answers "who is using this and what is
 * happening to them", and a list of anonymous rows cannot. It is behind the
 * owner gate for that reason.
 */
export async function accountActivity(env, { limit = 50 } = {}) {
  return queryAll(
    env,
    `SELECT u.id, u.email, u.created_at, u.last_login_at, u.email_verified, u.totp_enabled,
            (SELECT COUNT(*) FROM boards b WHERE b.user_id = u.id) AS boards,
            (SELECT COUNT(*) FROM jobs j WHERE j.user_id = u.id) AS jobs,
            (SELECT COUNT(*) FROM jobs j WHERE j.user_id = u.id AND j.status = 'applied') AS applied,
            (SELECT COUNT(*) FROM error_log e WHERE e.user_id = u.id) AS errors,
            (SELECT COALESCE(SUM(m.calls), 0) FROM model_usage m WHERE m.user_id = u.id) AS calls
     FROM users u
     ORDER BY COALESCE(NULLIF(u.last_login_at, ''), u.created_at) DESC
     LIMIT ?`,
    Math.min(200, Math.max(1, limit))
  );
}

const FEEDBACK_KINDS = new Set(['bug', 'idea']);

/** Store a piece of feedback. Returns the stored row's id. */
export async function saveFeedback(env, { userId, kind, subject, body, page = '' }) {
  const id = newId('fb_');
  await run(
    env,
    `INSERT INTO feedback (id, user_id, kind, subject, body, page, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    userId,
    FEEDBACK_KINDS.has(kind) ? kind : 'idea',
    String(subject || '').slice(0, 140),
    String(body || '').slice(0, 4000),
    String(page || '').slice(0, 120),
    nowIso()
  );
  return id;
}

/** Everything reported, newest first, with who reported it. */
export async function listFeedback(env, { limit = 50 } = {}) {
  return queryAll(
    env,
    `SELECT f.id, f.kind, f.subject, f.body, f.page, f.status, f.created_at,
            f.forwarded_at, f.forward_error, u.email
     FROM feedback f
     LEFT JOIN users u ON u.id = f.user_id
     ORDER BY f.created_at DESC
     LIMIT ?`,
    Math.min(200, Math.max(1, limit))
  );
}

/** Whether feedback can be forwarded anywhere beyond this database. */
export function notionConfigured(env) {
  return Boolean(env && env.NOTION_API_KEY && env.NOTION_DATABASE_ID);
}

/**
 * Copy a piece of feedback into Notion.
 *
 * The database row is written first and is the record; this is a copy. If the
 * key is missing, or Notion is down, or the schema does not match, the feedback
 * is still safely stored and the failure is recorded against the row rather
 * than lost - somebody took the trouble to write it, and it should not depend
 * on a third party being reachable.
 */
export async function forwardToNotion(env, id) {
  if (!notionConfigured(env)) return { forwarded: false, reason: 'not-configured' };

  const row = await queryOne(
    env,
    `SELECT f.*, u.email FROM feedback f LEFT JOIN users u ON u.id = f.user_id WHERE f.id = ?`,
    id
  );
  if (!row) return { forwarded: false, reason: 'not-found' };

  const title = row.subject || (row.kind === 'bug' ? 'Bug report' : 'Feature request');
  const payload = {
    parent: { database_id: env.NOTION_DATABASE_ID },
    properties: {
      Name: { title: [{ text: { content: title.slice(0, 200) } }] },
    },
    children: [
      {
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [
            {
              type: 'text',
              text: {
                content: [
                  `Type: ${row.kind}`,
                  row.email ? `From: ${row.email}` : null,
                  row.page ? `Page: ${row.page}` : null,
                  `Received: ${row.created_at}`,
                ]
                  .filter(Boolean)
                  .join('\n')
                  .slice(0, 1900),
              },
            },
          ],
        },
      },
      {
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: String(row.body || '').slice(0, 1900) } }],
        },
      },
    ],
  };

  try {
    const res = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.NOTION_API_KEY}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      await run(
        env,
        'UPDATE feedback SET forward_error = ? WHERE id = ?',
        `${res.status}: ${detail}`,
        id
      );
      return { forwarded: false, reason: `${res.status}` };
    }

    await run(
      env,
      "UPDATE feedback SET forwarded_at = ?, forward_error = '' WHERE id = ?",
      nowIso(),
      id
    );
    return { forwarded: true };
  } catch (err) {
    await run(
      env,
      'UPDATE feedback SET forward_error = ? WHERE id = ?',
      String((err && err.message) || err).slice(0, 200),
      id
    );
    return { forwarded: false, reason: 'unreachable' };
  }
}
