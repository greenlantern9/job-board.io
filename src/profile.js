// The candidate profile.
//
// Until now a board matched against one sentence someone typed. A profile is
// the far better input: what you have actually done, what you are good at, and
// what you will not accept. It is written once and improves every board.
//
// Entirely optional, and off unless enabled. A profile that silently changed
// everyone's rankings would be worse than no profile at all - so `enabled` is
// checked at every read, and with it off the ranking behaves exactly as before.

import { queryOne, run, nowIso, parseJson } from './db.js';

const MAX_CV_CHARS = 20000;

/** Terms too generic to say anything about a candidate. */
const SKILL_NOISE = new Set([
  'work', 'team', 'teams', 'company', 'role', 'roles', 'years', 'experience',
  'management', 'business', 'project', 'projects', 'process', 'processes',
  'communication', 'leadership', 'strong', 'excellent', 'good', 'various',
  'including', 'responsible', 'responsibilities', 'duties', 'skills', 'ability',
]);

/**
 * Pull skills out of CV text without a model.
 *
 * Deliberately crude and deliberately present: the profile has to be useful to
 * someone who has not configured an API key, and a keyword list beats nothing.
 * When a key is available, parseProfileWithModel replaces this with something
 * far better.
 */
export function extractSkillsHeuristically(text) {
  const body = String(text || '').toLowerCase();

  // Technologies are mostly proper nouns and acronyms that survive tokenising.
  const known = [
    'javascript', 'typescript', 'python', 'java', 'golang', 'go', 'rust', 'ruby', 'php', 'scala',
    'kotlin', 'swift', 'c++', 'c#', '.net', 'react', 'vue', 'angular', 'node', 'django', 'rails',
    'kubernetes', 'docker', 'terraform', 'aws', 'gcp', 'azure', 'postgres', 'postgresql', 'mysql',
    'mongodb', 'redis', 'kafka', 'spark', 'airflow', 'snowflake', 'databricks', 'graphql', 'grpc',
    'jira', 'confluence', 'agile', 'scrum', 'kanban', 'sql', 'tableau', 'looker', 'figma',
    'salesforce', 'hubspot', 'sap', 'oracle', 'servicenow', 'workday', 'pytorch', 'tensorflow',
    'llm', 'nlp', 'machine learning', 'data science', 'product management', 'program management',
    'roadmap', 'stakeholder', 'go-to-market', 'p&l', 'forecasting', 'compliance', 'soc 2', 'gdpr',
  ];

  const found = known.filter((skill) => {
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const left = /^\w/.test(skill) ? '\\b' : '';
    const right = /\w$/.test(skill) ? '\\b' : '';
    return new RegExp(`${left}${escaped}${right}`, 'i').test(body);
  });

  return [...new Set(found)].filter((s) => !SKILL_NOISE.has(s)).slice(0, 40);
}

/** Job titles the person has held, newest-looking first. */
export function extractTitlesHeuristically(text) {
  const titles = new Set();
  const lines = String(text || '').split(/\n+/);
  const titleish =
    /\b(engineer|manager|developer|designer|analyst|scientist|architect|director|lead|specialist|consultant|coordinator|principal|head of|vp|founder|cto|ceo)\b/i;

  for (const line of lines) {
    const clean = line.trim().replace(/\s{2,}/g, ' ');
    // A title line is short and names a role; a paragraph mentioning one is not.
    if (clean.length > 4 && clean.length <= 70 && titleish.test(clean) && !/[.!?]$/.test(clean)) {
      titles.add(clean.replace(/^[-•*\s]+/, '').slice(0, 70));
    }
    if (titles.size >= 12) break;
  }
  return [...titles];
}

/** Rough years of experience, from the earliest four-digit year that reads
 *  like a work date. */
export function estimateYears(text) {
  const years = [...String(text || '').matchAll(/\b(19[89]\d|20[0-4]\d)\b/g)]
    .map((m) => Number(m[1]))
    .filter((y) => y >= 1985 && y <= new Date().getFullYear());
  if (years.length === 0) return 0;
  const span = new Date().getFullYear() - Math.min(...years);
  // Guard against a stray year in an address or a certification number.
  return span > 0 && span < 50 ? span : 0;
}

export async function getProfile(env, userId) {
  const row = await queryOne(env, 'SELECT * FROM profiles WHERE user_id = ?', userId);
  if (!row) return null;
  return {
    headline: row.headline || '',
    summary: row.summary || '',
    skills: parseJson(row.skills, []),
    titles: parseJson(row.titles, []),
    yearsExperience: row.years_experience || 0,
    seniority: row.seniority === null || row.seniority === undefined ? null : row.seniority,
    mustHave: parseJson(row.must_have, []),
    dealBreakers: parseJson(row.deal_breakers, []),
    enabled: Boolean(row.enabled),
    updatedAt: row.updated_at,
    hasCv: Boolean(row.summary),
  };
}

/**
 * The profile as the ranking should see it - or null when it must be ignored.
 * Every consumer goes through this, so "disabled" cannot be forgotten at one
 * call site and silently applied anyway.
 */
export async function activeProfile(env, userId) {
  const profile = await getProfile(env, userId);
  return profile && profile.enabled ? profile : null;
}

export async function saveProfile(env, userId, input) {
  const now = nowIso();
  const summary = String(input.summary || '').slice(0, MAX_CV_CHARS);

  const list = (value, max = 40) =>
    JSON.stringify(
      (Array.isArray(value) ? value : String(value || '').split(','))
        .map((v) => String(v).trim())
        .filter(Boolean)
        .slice(0, max)
    );

  await run(
    env,
    `INSERT INTO profiles (user_id, headline, summary, skills, titles, years_experience,
       seniority, must_have, deal_breakers, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       headline = excluded.headline,
       summary = excluded.summary,
       skills = excluded.skills,
       titles = excluded.titles,
       years_experience = excluded.years_experience,
       seniority = excluded.seniority,
       must_have = excluded.must_have,
       deal_breakers = excluded.deal_breakers,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`,
    userId,
    String(input.headline || '').slice(0, 160),
    summary,
    list(input.skills),
    list(input.titles, 12),
    Math.max(0, Math.min(60, Number(input.yearsExperience) || 0)),
    Number.isInteger(Number(input.seniority)) ? Number(input.seniority) : null,
    list(input.mustHave, 20),
    list(input.dealBreakers, 20),
    input.enabled === false ? 0 : 1,
    now,
    now
  );

  return getProfile(env, userId);
}

/** Best-effort structured read of pasted CV text, with no model involved. */
export function parseCvHeuristically(text) {
  return {
    skills: extractSkillsHeuristically(text),
    titles: extractTitlesHeuristically(text),
    yearsExperience: estimateYears(text),
    summary: String(text || '').slice(0, MAX_CV_CHARS),
  };
}
