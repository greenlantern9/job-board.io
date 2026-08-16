// Show what a board would actually contain, for a given sentence.
//
// This exists because relevance was being tuned by reasoning about the code
// rather than by looking at the output. It runs the real pipeline - intent,
// query derivation, every aggregator, filters, heuristic ranking - and prints
// the board the way a person would see it. No database, no server, no key.
//
//   node scripts/preview-board.mjs "Technical Program Manager, $250k base, remote"

import { fetchSource, matchesFilters, normalizeCompany, AGGREGATOR_KINDS } from '../src/sources.js';
import { heuristicScore } from '../src/rank.js';
import { boardQuery } from '../src/curate.js';
import { SEED_COMPANIES, SEED_LIMIT } from '../src/seeds.js';
import { applyIntent, parseIntent } from '../src/intent.js';

const prompt = process.argv.slice(2).join(' ') || 'Technical Program Manager, $250k base, remote';

const intent = parseIntent(prompt);
const { filters } = applyIntent({}, prompt);
const board = { prompt, filters };
const query = boardQuery(board);

console.log('prompt      ', JSON.stringify(prompt));
console.log('role phrases', JSON.stringify(intent.phrases));
console.log('salary floor', intent.minSalary || '(none found)');
console.log('remote only ', Boolean(filters.remoteOnly));
console.log('min level   ', filters.minSeniority ?? '(none)');
console.log('query       ', JSON.stringify(query));
console.log();

// Every source is held to the same relevance bar, so the query travels with
// the filters exactly as it does at ingest.
const active = { ...filters, query };
const all = [];

const pull = async (label, source) => {
  try {
    const jobs = await fetchSource(source);
    const kept = jobs.filter((job) => matchesFilters(job, active));
    if (jobs.length || kept.length) {
      console.log(`${label.padEnd(22)} fetched=${String(jobs.length).padEnd(5)} kept=${kept.length}`);
    }
    all.push(...kept);
  } catch (err) {
    console.log(`${label.padEnd(22)} ERROR ${String(err.message).slice(0, 50)}`);
  }
};

console.log('--- aggregators ---');
for (const kind of AGGREGATOR_KINDS) await pull(kind, { kind, identifier: query });

console.log('--- company boards ---');
for (const seed of SEED_COMPANIES.slice(0, SEED_LIMIT)) {
  await pull(`${seed.label}`, { kind: seed.kind, identifier: seed.identifier });
}

// Same identity dedupe the ingest path uses.
const seen = new Set();
const unique = all.filter((job) => {
  const id = `${job.title.trim().toLowerCase().replace(/\s+/g, ' ')}|${normalizeCompany(job.company)}`;
  if (seen.has(id)) return false;
  seen.add(id);
  return true;
});

const ranked = unique
  .map((job) => ({ job, ...heuristicScore(job, { prompt, filters }) }))
  .sort((a, b) => b.score - a.score);

console.log(`\n${all.length} passed filters, ${unique.length} after dedupe. Top 20 as ranked:\n`);
for (const { job, score, reason } of ranked.slice(0, 20)) {
  const age = job.postedAt
    ? `${Math.round((Date.now() - new Date(job.postedAt).getTime()) / 86400000)}d`
    : '—';
  console.log(
    `${String(score).padStart(3)}  ${job.title.slice(0, 44).padEnd(46)}${(job.company || '?').slice(0, 18).padEnd(20)}${age.padStart(5)}`
  );
  console.log(`     ${reason.slice(0, 96)}`);
}
if (ranked.length === 0) console.log('  (nothing survived - the query or the filters are too tight)');
