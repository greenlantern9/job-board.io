// Job scoring: the deterministic heuristic in rank.js always runs, plus an
// optional Claude pass that reads the board's free-text criteria.
//
// The heuristic is not a placeholder - it is the floor. Without an API key the
// board still prioritizes sensibly, and when a model call fails or is declined
// we keep the heuristic result rather than leaving jobs unscored.

import Anthropic from '@anthropic-ai/sdk';
import { heuristicScore } from './rank.js';

const BATCH_SIZE = 15;
const MAX_BATCHES_PER_RUN = 4; // bounds cost and CPU time for one cron tick

export { heuristicScore };
export { detectSeniority } from './rank.js';

const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The job id exactly as given in the input' },
          score: { type: 'integer', description: 'Relevance from 0 (irrelevant) to 100 (ideal)' },
          reason: { type: 'string', description: 'One short sentence, at most 20 words' },
        },
        required: ['id', 'score', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['scores'],
  additionalProperties: false,
};

const SYSTEM_INSTRUCTIONS = `You rank job postings for one person against the criteria they wrote.

Score each posting 0-100 for how well it fits *their stated criteria*, not how good a job it is in general:
- 85-100: matches the core ask on role, level, and any hard constraints.
- 60-84: plausible fit with one meaningful gap.
- 30-59: adjacent - same field, wrong level or wrong focus.
- 0-29: not what they asked for.

Judge only from the text provided. Do not infer a salary, location, or seniority that is not stated;
an unstated attribute is neutral, not a penalty. Where the criteria are vague, prefer the ordinary
reading over a strict one. Return one entry per posting, using the exact id given.
Each reason is one short sentence naming the single strongest factor in the score.`;

function jobDigest(job) {
  return [
    `id: ${job.id}`,
    `title: ${job.title}`,
    job.company && `company: ${job.company}`,
    job.location && `location: ${job.location}`,
    job.remote ? 'remote: yes' : null,
    job.employment && `type: ${job.employment}`,
    job.salaryRaw && `salary: ${job.salaryRaw}`,
    job.postedAt && `posted: ${job.postedAt.slice(0, 10)}`,
    // The description is the bulk of the tokens, and fit is almost always
    // decidable from the opening requirements.
    job.description && `description: ${String(job.description).slice(0, 1200)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

async function scoreBatchWithClaude(client, model, jobs, { prompt, filters }) {
  const criteria = [
    prompt ? `Their criteria, in their words:\n${prompt}` : 'They did not write free-text criteria.',
    filters.keywords && `Required keywords: ${filters.keywords}`,
    filters.exclude && `Ruled out: ${filters.exclude}`,
    filters.locations && `Preferred locations: ${filters.locations}`,
    filters.remoteOnly && 'They want remote roles.',
    filters.minSalary && `Minimum acceptable salary: ${filters.minSalary}`,
  ]
    .filter(Boolean)
    .join('\n');

  const response = await client.beta.messages.create({
    model,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    // A safety decline on an ordinary job listing is unlikely but not
    // impossible; letting the API re-serve it costs nothing when unused.
    fallbacks: 'default',
    output_config: {
      // Ranking short postings against explicit criteria does not need deep
      // reasoning, and medium keeps a 60-job refresh affordable.
      effort: 'medium',
      format: { type: 'json_schema', schema: SCORE_SCHEMA },
    },
    system: [
      {
        type: 'text',
        text: `${SYSTEM_INSTRUCTIONS}\n\n${criteria}`,
        // Identical across every batch in a refresh, so later batches read it
        // back instead of re-paying for it.
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `Score these ${jobs.length} postings.\n\n${jobs.map(jobDigest).join('\n\n---\n\n')}`,
      },
    ],
  });

  // Check the stop reason before touching content: a declined request returns
  // 200 with an empty content array.
  if (response.stop_reason === 'refusal') {
    const category = (response.stop_details && response.stop_details.category) || 'unspecified';
    throw new Error(`model declined to score this batch (${category})`);
  }

  const text = response.content.find((block) => block.type === 'text');
  if (!text) throw new Error('model returned no text block');

  const parsed = JSON.parse(text.text);
  const byId = new Map();
  for (const entry of parsed.scores || []) {
    // The schema cannot express numeric bounds, so clamp here.
    const score = Math.max(0, Math.min(100, Math.round(Number(entry.score))));
    if (!entry.id || !Number.isFinite(score)) continue;
    byId.set(String(entry.id), {
      score,
      reason: String(entry.reason || '').slice(0, 240),
      scoredBy: model,
    });
  }
  return byId;
}

/**
 * Scores every job in `jobs`, returning a Map of job id to
 * {score, reason, scoredBy}. Always resolves: a model failure degrades to the
 * heuristic for the affected batch and is reported in `warnings`.
 */
export async function scoreJobs(env, jobs, board) {
  const context = { prompt: board.prompt || '', filters: board.filters || {} };
  const results = new Map();
  const warnings = [];

  for (const job of jobs) results.set(job.id, heuristicScore(job, context));

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey || jobs.length === 0) {
    return { results, warnings, usedModel: false };
  }

  const model = env.SCORING_MODEL || 'claude-opus-5';
  const client = new Anthropic({ apiKey });

  // Order by heuristic score so that if we hit the batch ceiling, the model's
  // attention went to the jobs most likely to matter.
  const ordered = [...jobs].sort((a, b) => results.get(b.id).score - results.get(a.id).score);
  const batches = [];
  for (let i = 0; i < ordered.length && batches.length < MAX_BATCHES_PER_RUN; i += BATCH_SIZE) {
    batches.push(ordered.slice(i, i + BATCH_SIZE));
  }

  let usedModel = false;
  for (const batch of batches) {
    try {
      const scored = await scoreBatchWithClaude(client, model, batch, context);
      for (const [id, value] of scored) {
        if (results.has(id)) {
          results.set(id, value);
          usedModel = true;
        }
      }
    } catch (err) {
      // Keep the heuristic scores already in `results` for this batch.
      warnings.push(`AI scoring fell back to the built-in ranking: ${err.message}`);
    }
  }

  const covered = batches.length * BATCH_SIZE;
  if (ordered.length > covered) {
    warnings.push(`${ordered.length - covered} lower-ranked jobs used the built-in ranking this run.`);
  }

  return { results, warnings, usedModel };
}
