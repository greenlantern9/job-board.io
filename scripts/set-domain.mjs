// Rewrite the public domain across the project.
//
//   node scripts/set-domain.mjs job-boards.io
//
// The domain appears in ~40 places - config, canonical tags, the sitemap, the
// TOTP issuer label, email templates, the fetch User-Agent - and missing one
// produces a subtle bug rather than a loud failure. So it gets a script.
//
// Deliberately does NOT touch the Worker name or the D1 database name: those
// are Cloudflare resource identifiers, and renaming them after a deploy
// creates a second Worker and orphans the database.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// The domain currently in the tree. Update this after every run.
const OLD = 'job-boards.io';

const FILES = [
  'wrangler.jsonc',
  'package.json',
  'worker.js',
  'schema.sql',
  'README.md',
  'src/notify.js',
  'src/sources.js',
  'src/routes/auth.js',
  'public/index.html',
  'public/app.html',
  'public/robots.txt',
  'public/sitemap.xml',
  'public/assets/app.js',
  'public/assets/base.css',
];

const next = process.argv[2];

if (!next || !/^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+$/i.test(next)) {
  console.error('Usage: node scripts/set-domain.mjs <domain>\n  e.g. node scripts/set-domain.mjs job-boards.io');
  process.exit(1);
}

if (next === OLD) {
  console.log(`Already set to ${OLD}. Nothing to do.`);
  process.exit(0);
}

const root = path.resolve(import.meta.dirname, '..');
let totalFiles = 0;
let totalHits = 0;

for (const relative of FILES) {
  const file = path.join(root, relative);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    console.log(`  skip  ${relative} (not found)`);
    continue;
  }
  const hits = text.split(OLD).length - 1;
  if (hits === 0) continue;
  await writeFile(file, text.split(OLD).join(next), 'utf8');
  totalFiles++;
  totalHits += hits;
  console.log(`  ${String(hits).padStart(2)}x   ${relative}`);
}

console.log(`\nReplaced ${totalHits} references across ${totalFiles} files: ${OLD} -> ${next}`);
console.log('\nStill to do by hand:');
console.log('  1. Change OLD at the top of this script to the new domain.');
console.log('  2. Check wrangler.jsonc "routes" matches the new domain.');
console.log('  3. Verify the sending domain in Resend and update NOTIFY_FROM.');
console.log('  4. Run: npm test');
