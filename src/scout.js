// Scout: research the open web for work that no job board carries.
//
// Surf-retreat photography, wedding and event shoots, local coaching - these
// are never posted to an applicant tracking system. They are found the way a
// person finds them: search, read the site, work out who to approach. So that
// is what this does, using the model's own web search and fetch tools.
//
// Deliberately not a scraper. The search and the page reads run on Anthropic's
// infrastructure, which crawls the web on the ordinary terms every search
// engine does. Nothing here sends requests to Upwork, LinkedIn or anyone else
// who prohibits it - a decision that belongs in the architecture rather than in
// a disclaimer.

import Anthropic from '@anthropic-ai/sdk';
import { reserveCall, recordUsage } from './budget.js';
import { queryAll, run, nowIso } from './db.js';
import { newId } from './crypto.js';
import { safeExternalUrl } from './sources.js';

/** Searches and page reads allowed per run. Every search is billed on top of
 *  tokens, so this is the main cost lever alongside the daily call budget. */
const MAX_SEARCHES = 8;
const MAX_FETCHES = 5;

/** A paused turn means the server-side tool loop hit its iteration limit and
 *  can be resumed. Bounded so a pathological run cannot spin. */
const MAX_RESUMES = 4;

const LEAD_SCHEMA = {
  type: 'object',
  properties: {
    leads: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The organisation or business name' },
          summary: { type: 'string', description: 'One sentence on what they do' },
          location: { type: 'string', description: 'Where they operate, or empty if unclear' },
          website: { type: 'string', description: 'Their own website, absolute URL' },
          contactUrl: {
            type: 'string',
            description:
              'Their published careers, work-with-us, or contact page. Empty if none was found.',
          },
          relevance: { type: 'string', description: 'Why this fits what the person is looking for' },
          approach: {
            type: 'string',
            description: 'Concrete advice on how to approach them and what to lead with',
          },
          signal: {
            type: 'string',
            description:
              'Evidence they want this work now - a posted role, a call for submissions, a stated need. Empty if none found.',
          },
        },
        required: [
          'name',
          'summary',
          'location',
          'website',
          'contactUrl',
          'relevance',
          'approach',
          'signal',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['leads'],
  additionalProperties: false,
};

const SYSTEM = [
  'You research real opportunities for one freelancer, using web search.',
  '',
  'Find organisations that plausibly need what they do, and give them a route in. Prefer evidence',
  'of current need (a posted role, a call for submissions, a stated hiring plan); organisations',
  'small enough that a direct approach reaches a decision-maker; and their own website over an',
  'aggregator listing.',
  '',
  'Rules that matter:',
  '- Only report organisations you actually found and read about. Never invent a name, a URL, or a',
  '  detail to pad the list. A short list of real leads is worth far more than a long list of',
  '  guesses, and a fabricated lead wastes a real person an afternoon.',
  '- Give the organisation’s own published business contact route - its contact or careers page.',
  '  Do not collect named individuals’ personal email addresses or phone numbers, and do not',
  '  assemble profiles of people. A business’s public "work with us" page is what you want.',
  '- If you cannot find a contact page, leave it empty rather than guessing a URL pattern.',
  '- Approach advice must be specific to that organisation, not generic networking advice. Say what',
  '  to lead with and why it would land with them in particular.',
  '- If the search turns up little, return the few real leads you found and stop. An honest short',
  '  list is the right answer to a thin market.',
].join('\n');

/** Model-supplied URLs are untrusted input like any other feed value. */
function cleanUrl(value) {
  return safeExternalUrl(String(value || '').trim()) || '';
}

/**
 * Research leads for one board.
 *
 * Always resolves. A failed run reports the reason rather than throwing into
 * the request handler - a scout that cannot run should not take the board down
 * with it.
 */
export async function scoutLeads(env, { userId, prompt, location = '', profile = null }) {
  const warnings = [];

  if (!env.ANTHROPIC_API_KEY) {
    return { leads: [], warnings: ['Scouting needs an Anthropic API key on the Worker.'], searches: 0 };
  }
  if (!String(prompt || '').trim()) {
    return { leads: [], warnings: ['Describe what you are looking for first.'], searches: 0 };
  }

  // Charged against the same daily allowance as scoring: a scout run is the
  // most expensive thing here, because every search is billed on top of tokens.
  if (!(await reserveCall(env, userId, 0))) {
    return { leads: [], warnings: ['Daily AI budget reached. Scouting resets tomorrow.'], searches: 0 };
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.SCORING_MODEL || 'claude-opus-5';

  const brief = [
    `What they are looking for, in their words:\n${prompt}`,
    location && `Where they can work: ${location}`,
    profile && profile.headline && `About them: ${profile.headline}`,
    profile && (profile.skills || []).length
      ? `What they can do: ${profile.skills.slice(0, 15).join(', ')}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  const messages = [
    {
      role: 'user',
      content: `${brief}\n\nSearch the web and find up to 10 organisations worth approaching. Report only what you actually find.`,
    },
  ];

  let response;
  let resumes = 0;
  let searches = 0;

  try {
    for (;;) {
      response = await client.beta.messages.create({
        model,
        max_tokens: 8000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: {
          effort: 'medium',
          format: { type: 'json_schema', schema: LEAD_SCHEMA },
        },
        tools: [
          // The 2026-02-09 variants filter results before they reach the
          // context, which is cheaper and more accurate. Code execution is
          // deliberately not declared alongside them - it is already built in,
          // and a second execution environment confuses the model.
          { type: 'web_search_20260209', name: 'web_search', max_uses: MAX_SEARCHES },
          { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: MAX_FETCHES },
        ],
        system: SYSTEM,
        messages,
      });

      // Inside the loop: a paused turn is resumed with a fresh request, and
      // each one is billed separately.
      await recordUsage(env, userId, response.usage);

      searches += response.content.filter(
        (block) => block.type === 'server_tool_use' && block.name === 'web_search'
      ).length;

      // A paused turn resumes by echoing the assistant turn back; the server
      // picks up where it stopped and detects the trailing server-tool block
      // itself, so no extra user message is added.
      if (response.stop_reason !== 'pause_turn' || resumes >= MAX_RESUMES) break;
      messages.push({ role: 'assistant', content: response.content });
      resumes++;
    }
  } catch (err) {
    return { leads: [], warnings: [`Scouting failed: ${err.message}`], searches };
  }

  if (response.stop_reason === 'refusal') {
    return { leads: [], warnings: ['The model declined that search.'], searches };
  }
  if (response.stop_reason === 'pause_turn') {
    warnings.push('The search was still running when it hit its limit; these are the leads so far.');
  }

  const text = response.content.find((block) => block.type === 'text');
  if (!text) return { leads: [], warnings: ['The search came back empty.'], searches };

  let parsed;
  try {
    parsed = JSON.parse(text.text);
  } catch {
    return { leads: [], warnings: ['Could not read the search results.'], searches };
  }

  const leads = (parsed.leads || [])
    .map((lead) => ({
      name: String(lead.name || '').slice(0, 120),
      summary: String(lead.summary || '').slice(0, 400),
      location: String(lead.location || '').slice(0, 120),
      website: cleanUrl(lead.website),
      contactUrl: cleanUrl(lead.contactUrl),
      relevance: String(lead.relevance || '').slice(0, 400),
      approach: String(lead.approach || '').slice(0, 800),
      signal: String(lead.signal || '').slice(0, 300),
    }))
    // A lead with no name or no reachable site is not a lead.
    .filter((lead) => lead.name && lead.website)
    .slice(0, 10);

  if (leads.length === 0) {
    warnings.push('Nothing solid came back. Try naming a place, or a more specific kind of work.');
  }

  return { leads, warnings, searches };
}

/**
 * Persist a scout run's leads against a board.
 *
 * Upserted on (board_id, website): re-scouting refreshes what an organisation
 * looks like now without duplicating it or losing the status the user has
 * already set on it. Their own notes and status are never overwritten by a
 * later run - the research is ours to refresh, the record of what they did
 * about it is theirs.
 */
export async function saveLeads(env, { boardId, userId, leads }) {
  const now = nowIso();
  let saved = 0;

  for (const lead of leads) {
    await run(
      env,
      `INSERT INTO leads (id, board_id, user_id, name, summary, location, website,
         contact_url, relevance, approach, signal, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', '', ?, ?)
       ON CONFLICT (board_id, website) DO UPDATE SET
         name = excluded.name,
         summary = excluded.summary,
         location = excluded.location,
         contact_url = excluded.contact_url,
         relevance = excluded.relevance,
         approach = excluded.approach,
         signal = excluded.signal,
         updated_at = excluded.updated_at`,
      newId('lead_'),
      boardId,
      userId,
      lead.name,
      lead.summary,
      lead.location,
      lead.website,
      lead.contactUrl,
      lead.relevance,
      lead.approach,
      lead.signal,
      now,
      now
    );
    saved++;
  }
  return saved;
}

export async function listLeads(env, boardId, userId) {
  const rows = await queryAll(
    env,
    `SELECT * FROM leads WHERE board_id = ? AND user_id = ?
     ORDER BY CASE status WHEN 'new' THEN 0 WHEN 'contacted' THEN 1 ELSE 2 END, created_at DESC`,
    boardId,
    userId
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    summary: row.summary,
    location: row.location,
    website: row.website,
    contactUrl: row.contact_url,
    relevance: row.relevance,
    approach: row.approach,
    signal: row.signal,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
  }));
}

/**
 * Scout and store in one step, for the paths that run unattended.
 *
 * Swallows its own failures deliberately: this runs in the background after a
 * board is created, and a failed search must not take the board creation with
 * it. The user has a board either way; the leads are a bonus that either
 * arrives or does not.
 */
export async function scoutAndStore(env, { boardId, userId, prompt, location, profile }) {
  try {
    const result = await scoutLeads(env, { userId, prompt, location, profile });
    if (result.leads.length > 0) {
      await saveLeads(env, { boardId, userId, leads: result.leads });
    }
    return result;
  } catch (err) {
    console.error('scout failed for board', boardId, err && err.message);
    return { leads: [], warnings: [String((err && err.message) || err)], searches: 0 };
  }
}
