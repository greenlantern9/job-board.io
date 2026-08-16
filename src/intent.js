// Read structured intent out of the sentence someone wrote.
//
// The board asks for criteria in plain English and then, until now, used them
// only as loose keywords. Someone who wrote "Technical Program Manager, $250k
// base, remote" got no salary floor, no seniority filter, and their role title
// shredded into three words that each matched independently - which is how a
// search for a program manager returned store managers.
//
// This turns the sentence into the filters the user would otherwise have had
// to find under Advanced. Everything here is a *default*: an explicitly set
// filter always wins, because the form is a statement of intent and the prose
// is an inference from one.

// Imported as well as re-exported: `export ... from` forwards the binding but
// does not bring it into this module's scope.
import { detectSeniorityLevel, extractRolePhrases } from './rank.js';

export { extractRolePhrases };

// "401k" is a benefit, not a salary, and it sits squarely in the plausible
// range - so it is removed before anything is parsed.
const BENEFIT_NOISE = /\b401\s?\(?k\)?\b/gi;
const MONEY_RE = /\$?\s?(\d{2,3}(?:,\d{3})+|\d{2,3}(?:\.\d)?\s?k\b|\d{5,7})\b/gi;

const MIN_PLAUSIBLE_SALARY = 30000;
const MAX_PLAUSIBLE_SALARY = 2000000;

/**
 * The salary floor implied by the sentence.
 *
 * Takes the smallest plausible figure mentioned, which reads a range like
 * "$180k-$220k" as a floor of 180k while still reading "at least $250k" as
 * 250k. Guessing high would hide jobs the user would have wanted.
 */
export function extractSalaryFloor(prompt) {
  const text = String(prompt || '').replace(BENEFIT_NOISE, ' ');
  const values = [];

  for (const match of text.matchAll(MONEY_RE)) {
    const raw = match[1].replace(/[,\s]/g, '');
    const value = /k$/i.test(raw) ? Math.round(parseFloat(raw) * 1000) : parseInt(raw, 10);
    if (Number.isFinite(value) && value >= MIN_PLAUSIBLE_SALARY && value <= MAX_PLAUSIBLE_SALARY) {
      values.push(value);
    }
  }

  return values.length ? Math.min(...values) : 0;
}

/**
 * Only an explicit exclusivity signal counts.
 *
 * Inferring it from a bare mention was actively harmful: "remote or NYC" set
 * remote-only, which then discarded every on-site posting - including the
 * entire best source, since most of its listings name a city. Someone offering
 * an alternative is stating a preference, and a preference belongs in the
 * ranking, not in a filter that deletes things.
 */
const REMOTE_REQUIRED =
  /\b(remote[-\s]?only|fully[-\s]remote|100%\s*remote|must\s+be\s+remote|remote[-\s]first|only\s+remote|work\s+from\s+home\s+only)\b/i;

const NEGATED_REMOTE = /\b(not|no|non|isn't|rather than|instead of)\s+(\w+\s+){0,2}remote\b/i;

export function wantsRemote(prompt) {
  const text = String(prompt || '');
  if (NEGATED_REMOTE.test(text)) return false;
  return REMOTE_REQUIRED.test(text);
}

/**
 * Everything the sentence implies. Returned as a plain object so callers can
 * decide which parts to apply.
 */
export function parseIntent(prompt) {
  const phrases = extractRolePhrases(prompt);
  return {
    phrases,
    minSalary: extractSalaryFloor(prompt),
    // The seniority stated in the role phrase, if any - read from the phrase
    // rather than the whole prompt so "not junior" cannot set it to junior.
    seniority: phrases.length ? detectSeniorityLevel(phrases[0]) : null,
    remoteOnly: wantsRemote(prompt),
  };
}

/**
 * Fill in filters the user did not set. Explicit values always win: the form is
 * a statement, the prose is an inference.
 */
export function applyIntent(filters, prompt) {
  const intent = parseIntent(prompt);
  const merged = { ...filters };

  if (!merged.minSalary && intent.minSalary) merged.minSalary = intent.minSalary;
  if (merged.minSeniority === undefined && intent.seniority !== null && intent.seniority >= 3) {
    // Only inferred upwards. Reading "junior" out of a sentence and quietly
    // capping someone's search at junior roles would be worse than doing
    // nothing at all.
    merged.minSeniority = intent.seniority;
  }
  if (!merged.remoteOnly && intent.remoteOnly) merged.remoteOnly = true;

  return { filters: merged, intent };
}
