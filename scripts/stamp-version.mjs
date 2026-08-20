// Stamp the current commit into the bundle just before it is deployed.
//
// Without this there is no way to tell what is live. /health reported that the
// worker was up and had its keys, which is not the same question as whether
// the code answering it is the code you just pushed - and working that out
// meant guessing from behaviour or trusting that a deploy command ran.

import { execSync } from 'node:child_process';
import fs from 'node:fs';

const at = (cmd, fallback) => {
  try {
    return execSync(cmd, { encoding: 'utf8' }).trim();
  } catch {
    return fallback;
  }
};

const commit = at('git rev-parse --short HEAD', 'unknown');
const dirty = at('git status --porcelain', '') !== '';
const stamped = new Date().toISOString();

fs.writeFileSync(
  'src/version.js',
  `// GENERATED at deploy time by scripts/stamp-version.mjs - do not hand-edit.
export const VERSION = ${JSON.stringify({ commit, dirty, stamped })};
`
);

console.log(`stamped ${commit}${dirty ? ' (with uncommitted changes)' : ''}`);
