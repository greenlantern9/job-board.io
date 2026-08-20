// Placeholder. Overwritten by scripts/stamp-version.mjs during deploy.
//
// Committed rather than ignored only because worker.js imports it statically,
// so a fresh clone has to be able to resolve it. The value here is never the
// one in production - CI restamps it from the commit it is actually shipping.
export const VERSION = { commit: 'dev', dirty: true, stamped: '' };
