// "Companies like the ones I already track."
//
// A bare list of names would be a dead end - the user would still have to guess
// each company's ATS and its board slug. So every suggestion is probed against
// the real Greenhouse, Lever, and Ashby endpoints before it is shown, and only
// the ones that resolve to a live board come back. A suggestion you can add
// with one click is worth several you have to go research.

import Anthropic from '@anthropic-ai/sdk';
import { fetchSource, validateSlug, ATS_KINDS } from './sources.js';

const MAX_CANDIDATES = 8;

const SUGGEST_SCHEMA = {
  type: 'object',
  properties: {
    companies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Company name as commonly written' },
          slug: {
            type: 'string',
            description:
              'Best guess at the company job-board identifier: lowercase, no spaces, usually the company name (e.g. "gitlab", "ramp", "1password")',
          },
          reason: {
            type: 'string',
            description: 'One short clause on why it resembles the others. Max 15 words.',
          },
        },
        required: ['name', 'slug', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['companies'],
  additionalProperties: false,
};

const SYSTEM = `You suggest employers a job seeker should also be watching.

You are given the criteria they wrote and the companies they already track. Suggest companies that
resemble those in the ways that matter to a candidate: industry, product area, engineering culture,
stage and size, and whether they hire for the kind of role described.

Rules:
- Never repeat a company already on their list.
- Prefer companies that publish a public job board, since an unlistable suggestion is useless here.
- Favour real, currently-operating companies. Do not invent names.
- Spread the list across stages rather than returning ten companies of identical size.
- The slug is your best guess at their job-board identifier: lowercase, no spaces or punctuation.`;

/** Ask the model for candidates. Throws on refusal or a missing key. */
async function proposeCompanies(env, { prompt, filters, known }) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const error = new Error(
      'Company suggestions need an Anthropic API key. Add ANTHROPIC_API_KEY as a Worker secret to turn this on.'
    );
    error.code = 'no_api_key';
    throw error;
  }

  const client = new Anthropic({ apiKey });
  const context = [
    prompt ? `What they are looking for:\n${prompt}` : 'They did not write free-text criteria.',
    filters.locations && `Preferred locations: ${filters.locations}`,
    filters.remoteOnly && 'They want remote roles.',
    filters.keywords && `Required keywords: ${filters.keywords}`,
    filters.exclude && `Ruled out: ${filters.exclude}`,
    known.length
      ? `Companies already on their board (do not repeat these):\n${known.join(', ')}`
      : 'They have no companies on their board yet.',
  ]
    .filter(Boolean)
    .join('\n');

  const response = await client.beta.messages.create({
    model: env.SCORING_MODEL || 'claude-opus-5',
    max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: {
      // Recall, not analysis - and the user is waiting on this one.
      effort: 'low',
      format: { type: 'json_schema', schema: SUGGEST_SCHEMA },
    },
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: `${context}\n\nSuggest ${MAX_CANDIDATES} companies they should also be watching.`,
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('The model declined to answer that request.');
  }
  const text = response.content.find((block) => block.type === 'text');
  if (!text) throw new Error('The model returned no suggestions.');

  const parsed = JSON.parse(text.text);
  return (parsed.companies || []).slice(0, MAX_CANDIDATES);
}

/**
 * Try each platform in turn and stop at the first that resolves. Returns null
 * when nothing does - a company whose board we cannot reach is dropped rather
 * than shown as an option that would fail on click.
 */
async function probe(candidate, selfHost) {
  let slug;
  try {
    slug = validateSlug(candidate.slug);
  } catch {
    // Fall back to a slug derived from the name.
    slug = String(candidate.name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    if (!slug) return null;
  }

  for (const kind of ATS_KINDS) {
    try {
      const jobs = await fetchSource({ kind, identifier: slug }, { selfHost });
      // A board that exists but lists nothing is not worth adding today.
      if (jobs.length > 0) {
        return {
          name: candidate.name,
          reason: candidate.reason,
          kind,
          identifier: slug,
          count: jobs.length,
          sample: jobs.slice(0, 2).map((job) => job.title),
        };
      }
    } catch {
      // Wrong platform for this company, or no such board. Try the next.
    }
  }
  return null;
}

/**
 * Suggest companies for a board and return only those we could verify.
 * `checked` reports how many were proposed, so the UI can say something honest
 * when most of them did not resolve.
 */
export async function suggestCompanies(env, board, { known = [], selfHost } = {}) {
  const candidates = await proposeCompanies(env, {
    prompt: board.prompt || '',
    filters: board.filters || {},
    known,
  });

  // Probed concurrently: worst case is MAX_CANDIDATES * PLATFORMS subrequests,
  // which stays inside the per-request subrequest budget.
  const results = await Promise.all(candidates.map((candidate) => probe(candidate, selfHost)));

  return {
    checked: candidates.length,
    companies: results.filter(Boolean),
  };
}
