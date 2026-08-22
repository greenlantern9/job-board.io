// Ordering rules for the list view's clickable column headers. Kept pure and
// DOM-free so the comparisons can be unit tested; app.js applies them to a
// copy of the loaded rows. The server's order (best fit or newest, per the
// segmented control) is never touched - clearing the header sort falls back
// to it.

/** First click gives each column the direction someone scanning it wants:
 *  best score, newest posting and highest pay first; names A to Z. */
export const DEFAULT_DIR = {
  score: 'desc',
  posted: 'desc',
  title: 'asc',
  company: 'asc',
  pay: 'desc',
};

// A row with no value for the column sorts last in *both* directions -
// flipping "highest pay first" should surface the lowest known pay, not a
// wall of unknowns.
const VALUES = {
  score: (job) => (Number.isFinite(job.score) ? job.score : null),
  posted: (job) => {
    const t = Date.parse(job.postedAt || '');
    return Number.isNaN(t) ? null : t;
  },
  title: (job) => job.title || null,
  company: (job) => job.company || null,
  // Salary arrives as a min, a max, both, or neither; the top of whatever is
  // known is the number people actually rank offers by.
  pay: (job) => Math.max(job.salaryMax || 0, job.salaryMin || 0) || null,
};

/** @param dir 'asc' | 'desc' */
export function comparator(key, dir) {
  const value = VALUES[key];
  const flip = dir === 'desc' ? -1 : 1;
  return (a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    const cmp =
      typeof va === 'string' ? va.localeCompare(vb, undefined, { sensitivity: 'base' }) : va - vb;
    return cmp * flip;
  };
}
