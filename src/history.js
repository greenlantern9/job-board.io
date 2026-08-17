// The record of what actually happened to an application.
//
// Job postings are edited and eventually taken down - we delist them ourselves
// when the employer stops listing. So the description you read, the salary that
// was advertised, and the profile you applied with are all gone by the time you
// are preparing for the interview, which is precisely when you want them.
//
// Every status change writes an event. The move into "applied" writes a full
// copy of the posting, because that is the moment worth preserving; later moves
// record what changed and when.

import { queryAll, run, nowIso, parseJson } from './db.js';
import { newId } from './crypto.js';

/** Enough of the posting to reconstruct what was read, without storing the
 *  whole description on every single transition. */
function snapshotOf(job, profile) {
  return {
    title: job.title,
    company: job.company,
    location: job.location,
    remote: Boolean(job.remote),
    salary: job.salary_raw || '',
    url: job.url,
    postedAt: job.posted_at || '',
    score: job.score,
    scoreReason: job.score_reason || '',
    // Truncated hard: this is for recall, not for re-reading the whole advert.
    description: String(job.description || '').slice(0, 6000),
    // What you looked like when you applied, which changes over a search.
    profileHeadline: profile ? profile.headline : '',
    profileSkills: profile ? (profile.skills || []).slice(0, 25) : [],
  };
}

/** True for the transition worth keeping a full copy of. */
const isApplication = (from, to) => to === 'applied' && from !== 'applied';

export async function recordStatusChange(env, { job, fromStatus, toStatus, note, profile }) {
  // A full snapshot on application, a light one thereafter. Storing the whole
  // posting on every drag between kanban columns would be waste.
  const snapshot = isApplication(fromStatus, toStatus)
    ? snapshotOf(job, profile)
    : { title: job.title, company: job.company, score: job.score };

  await run(
    env,
    `INSERT INTO job_events (id, user_id, job_id, board_id, from_status, to_status, note, snapshot, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId('evt_'),
    job.user_id,
    job.id,
    job.board_id,
    fromStatus || '',
    toStatus,
    String(note || '').slice(0, 2000),
    JSON.stringify(snapshot),
    nowIso()
  );
}

export async function jobHistory(env, userId, jobId) {
  const rows = await queryAll(
    env,
    `SELECT * FROM job_events WHERE user_id = ? AND job_id = ? ORDER BY created_at ASC`,
    userId,
    jobId
  );
  return rows.map((row) => ({
    id: row.id,
    from: row.from_status,
    to: row.to_status,
    note: row.note,
    at: row.created_at,
    snapshot: parseJson(row.snapshot, {}),
  }));
}

/**
 * Everything applied to, newest first, with the outcome it reached.
 *
 * Reads from the archive rather than from the jobs table, so an application
 * survives its posting being delisted, its board being deleted, or the job row
 * itself being cleared out.
 */
export async function applicationHistory(env, userId, { limit = 100 } = {}) {
  const rows = await queryAll(
    env,
    `SELECT * FROM job_events WHERE user_id = ? ORDER BY created_at ASC LIMIT 1000`,
    userId
  );

  const byJob = new Map();
  for (const row of rows) {
    const snapshot = parseJson(row.snapshot, {});
    const entry = byJob.get(row.job_id) || {
      jobId: row.job_id,
      boardId: row.board_id,
      title: snapshot.title || '',
      company: snapshot.company || '',
      url: snapshot.url || '',
      salary: snapshot.salary || '',
      appliedAt: '',
      outcome: '',
      outcomeAt: '',
      timeline: [],
      snapshot: null,
    };

    // The application snapshot is the rich one; keep it, and let later light
    // events fill in the title if the first event predates the archive.
    if (snapshot.description) entry.snapshot = snapshot;
    if (snapshot.title && !entry.title) entry.title = snapshot.title;
    if (snapshot.company && !entry.company) entry.company = snapshot.company;
    if (snapshot.url && !entry.url) entry.url = snapshot.url;

    if (row.to_status === 'applied' && !entry.appliedAt) entry.appliedAt = row.created_at;
    entry.outcome = row.to_status;
    entry.outcomeAt = row.created_at;
    entry.timeline.push({ to: row.to_status, at: row.created_at, note: row.note });

    byJob.set(row.job_id, entry);
  }

  return [...byJob.values()]
    .filter((entry) => entry.appliedAt)
    .sort((a, b) => (a.appliedAt < b.appliedAt ? 1 : -1))
    .slice(0, limit);
}
