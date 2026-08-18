import { expandPhrase } from './synonyms.js';

// The deterministic ranking heuristic.
//
// Kept separate from scoring.js so it carries no dependencies: it is the
// fallback that must work when the model client is unavailable, and it is the
// part worth pinning with tests.

const SENIORITY = [
  { re: /\b(intern|internship)\b/i, level: 0 },
  { re: /\b(junior|jr\.?|entry[- ]level|associate|graduate|new grad)\b/i, level: 1 },
  { re: /\b(principal|distinguished|architect)\b/i, level: 4 },
  { re: /\b(director|vp|vice president|head of|chief|cto|ceo)\b/i, level: 5 },
  { re: /\b(senior|sr\.?|lead|staff)\b/i, level: 3 },
];

/** Human labels for the six levels, shared by the UI and the model prompt. */
export const SENIORITY_LABELS = [
  'Internship',
  'Junior',
  'Mid',
  'Senior / Staff',
  'Principal',
  'Director+',
];

/**
 * The level a title actually states, or null when it states none.
 *
 * The null matters: plenty of genuinely senior roles are titled just "Software
 * Engineer". Treating unstated as mid would let a minimum-level filter throw
 * those away, which is the same mistake as discarding every listing that omits
 * a salary.
 */
export function detectSeniorityLevel(title) {
  for (const { re, level } of SENIORITY) if (re.test(title)) return level;
  return null;
}

/** 0 intern, 1 junior, 2 mid (the assumption when unstated), 3 senior/staff,
 *  4 principal, 5 exec. */
export function detectSeniority(title) {
  return detectSeniorityLevel(title) ?? 2;
}

/**
 * Company-name comparison that survives the three shapes the same employer
 * arrives in: ATS slug, legal display name, and whatever the user typed.
 *
 * Duplicated deliberately rather than imported from sources.js - rank.js has no
 * dependencies on purpose, because it is the fallback that has to work when
 * everything else is unavailable.
 */
function normalizeCompany(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|gmbh|co|plc|sa|ag|bv|nv)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function companyOnList(company, list) {
  const target = normalizeCompany(company);
  if (!target) return false;
  return list.some((entry) => {
    const candidate = normalizeCompany(entry);
    if (!candidate) return false;
    return target === candidate || target.includes(candidate) || candidate.includes(target);
  });
}

/** Age in whole-ish days, or null when the posting carries no usable date. */
export function jobAgeDays(job) {
  if (!job || !job.postedAt) return null;
  const posted = new Date(job.postedAt).getTime();
  if (!Number.isFinite(posted)) return null;
  const age = (Date.now() - posted) / 86400000;
  if (!Number.isFinite(age) || age < 0) return null;
  return age;
}

// --- criteria extraction ---------------------------------------------------
// Shared by the ranking and by the query sent to sources, so a board is scored
// against exactly the terms it searched for.

const ROLE_NOUNS =
  // Corporate and salaried.
  'engineer|manager|developer|designer|analyst|scientist|architect|director|lead|specialist|' +
  'consultant|administrator|technician|recruiter|marketer|writer|producer|strategist|coordinator|' +
  'associate|executive|officer|partner|accountant|auditor|advisor|adviser|agent|representative|' +
  'supervisor|superintendent|planner|buyer|controller|' +
  // Service-desk roles end in a noun that is generic on its own but specific
  // with its modifiers: solar customer service, client support.
  'service|support|success|rep|reps|' +
  // Creative and media. Without these a videographer or photo-editor role
  // could not be parsed at all, which is most of the freelance market.
  'photographer|videographer|cinematographer|filmmaker|editor|storyteller|creator|artist|' +
  'illustrator|animator|retoucher|copywriter|journalist|blogger|podcaster|host|presenter|' +
  'stylist|gaffer|' +
  // Teaching, coaching and guiding - hourly and seasonal work that no ATS
  // ever sees but that people genuinely search for.
  'coach|instructor|trainer|teacher|professor|tutor|guide|mentor|facilitator|' +
  // Care, hospitality and trades.
  'nurse|physician|therapist|caregiver|assistant|chef|cook|bartender|server|barista|driver|' +
  'operator|installer|electrician|plumber|carpenter|mechanic|welder|surveyor|inspector|' +
  // The generic tails, kept last so a longer phrase wins first.
  'roles|role|positions|position|jobs|job|work|gig|gigs';

const ROLE_RE = new RegExp(String.raw`\b((?:[a-z][a-z+#.\-]*\s+){0,3}(?:${ROLE_NOUNS}))\b`, 'gi');
// Words naming the container rather than the work: gigs, work, opportunities.
// Left in, they become required words - "photo and video gigs" demanded the
// literal word "gigs" in a title and matched nothing at all, which is the most
// natural way anyone would phrase that search.
const PHRASE_TAIL = /\b(roles?|positions?|jobs?|gigs?|work|opportunit(?:y|ies)|openings?|listings?)$/;
const PHRASE_HEAD =
  /^(a|an|the|any|some|more|new|other|at|in|for|of|and|or|to|my|i|im|want|wants|looking|seeking|find|me|least|base|about)\s+/;

/**
 * Job titles named in the sentence, longest first.
 *
 * "technical program manager" kept whole is a completely different search from
 * those three words treated separately - the latter matches any store manager.
 */
export function extractRolePhrases(prompt) {
  const text = String(prompt || '').toLowerCase();
  const found = new Set();

  for (const match of text.matchAll(ROLE_RE)) {
    let phrase = match[1].replace(/\s+/g, ' ').trim();
    let previous;
    do {
      previous = phrase;
      phrase = phrase.replace(PHRASE_HEAD, '');
    } while (phrase !== previous);
    phrase = phrase.replace(PHRASE_TAIL, '').trim();
    if (phrase.includes(' ')) found.add(phrase);
  }

  return [...found].sort((a, b) => b.split(' ').length - a.split(' ').length).slice(0, 3);
}

/**
 * Words too generic, or too much like scaffolding, to count as criteria.
 *
 * The salary figure and its units belong here: "at least $250k base" was being
 * scored as three matchable terms, so a posting that happened to contain the
 * word "base" collected criteria credit. That is how a listing called "Sales
 * Jedi" reached 73 out of 100 on a search for a program manager.
 */
const CRITERIA_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'you', 'our', 'are', 'will', 'that', 'this', 'have', 'from',
  'who', 'want', 'looking', 'work', 'working', 'team', 'role', 'roles', 'job', 'jobs', 'position',
  'positions', 'company', 'companies', 'experience', 'years', 'strong', 'good', 'great', 'able',
  'help', 'build', 'building', 'across', 'into', 'their', 'your', 'about', 'more', 'than', 'well',
  'also', 'not', 'least', 'base', 'salary', 'pay', 'comp', 'compensation', 'minimum', 'min',
  'ideally', 'preferably', 'prefer', 'interested', 'seeking', 'find', 'new', 'some', 'any',
  'remote', 'hybrid', 'onsite', 'office', 'full', 'time', 'part', 'contract', 'permanent',
]);

/** True for tokens that are money or numbers rather than criteria. */
const IS_NUMERIC = /^\d+(\.\d+)?k?$/;

/**
 * Does this phrase describe that text, allowing for how employers actually
 * word things?
 *
 * Every slot must be filled, but any member of a slot's family fills it - so
 * "photo and video" is satisfied by "Video Editor" or "Content Creator". The
 * ranking used to compare words literally while only the source filter knew
 * about synonyms, which is why a board could let a job through and then rank it
 * as though it barely matched.
 */
function phraseMatches(phrase, text) {
  const slots = expandPhrase(phrase);
  if (slots.length === 0) return false;
  return slots.every((family) => family.some((alternative) => text.includes(alternative)));
}

export function criteriaTerms(prompt) {
  const phrases = extractRolePhrases(prompt);
  const inPhrase = new Set(phrases.flatMap((p) => p.split(' ')));

  const singles = String(prompt || '')
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter(
      (w) => w.length > 2 && !CRITERIA_STOPWORDS.has(w) && !IS_NUMERIC.has?.(w) && !IS_NUMERIC.test(w) && !inPhrase.has(w)
    );

  return { phrases, words: [...new Set(singles)] };
}

function words(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((w) => w.length > 2);
}

// Words common enough that a match carries no signal.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'you', 'our', 'are', 'will', 'that', 'this', 'have', 'from',
  'who', 'want', 'looking', 'work', 'working', 'team', 'role', 'job', 'position', 'company',
  'experience', 'years', 'strong', 'good', 'great', 'able', 'help', 'build', 'building',
  'across', 'into', 'their', 'your', 'about', 'more', 'than', 'well', 'also', 'not',
]);

/**
 * Scores one job 0-100 against a board's criteria. Deterministic: the same
 * inputs always produce the same number, which matters because this is what
 * the list is sorted by when the model is not in play.
 */
export function heuristicScore(job, { prompt = '', filters = {}, profile = null } = {}) {
  const haystack = `${job.title} ${job.company} ${job.location} ${job.description}`.toLowerCase();
  const titleText = String(job.title || '').toLowerCase();
  const reasons = [];
  const gaps = [];
  let score = 40; // neutral baseline

  // 1. The role itself (up to +40), which has to dominate.
  //
  //    Averaging a title match in with a dozen loose words let irrelevant
  //    postings accumulate credit from incidental vocabulary while an exact
  //    role match got diluted. A named role in the title is now worth more than
  //    every other criteria signal combined, and a job that matches none of the
  //    stated role is pushed below the baseline rather than left at it.
  const { phrases, words: criteriaWords } = criteriaTerms(prompt);

  if (phrases.length > 0) {
    const best = phrases.find((phrase) => phraseMatches(phrase, titleText));
    const inBody = phrases.find((phrase) => phraseMatches(phrase, haystack));

    if (best) {
      score += 40;
      reasons.unshift(`title matches "${best}"`);
    } else if (inBody) {
      score += 12;
      reasons.push('role appears in the description, not the title');
    } else {
      score -= 20;
      reasons.push('not the role you described');
    }
  }

  // 2. Remaining criteria words (up to +15). Supporting evidence only - skills
  //    and domain terms that refine an already-plausible match.
  if (criteriaWords.length > 0) {
    let hits = 0;
    let titleHits = 0;
    for (const term of criteriaWords) {
      if (haystack.includes(term)) {
        hits++;
        if (titleText.includes(term)) titleHits++;
      }
    }
    if (hits > 0) {
      const ratio = Math.min(1, (hits + titleHits) / Math.max(3, criteriaWords.length * 0.7));
      score += Math.round(ratio * 15);
      reasons.push(`matches ${hits}/${criteriaWords.length} of your other terms`);
    } else if (phrases.length === 0) {
      reasons.push('no overlap with your stated criteria');
    }
  }

  // 3. Required keyword in the title (up to +10).
  const required = String(filters.keywords || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (required.length > 0) {
    const inTitle = required.filter((t) => titleText.includes(t)).length;
    if (inTitle > 0) {
      score += Math.min(10, inTitle * 5);
      reasons.push('keyword appears in the title');
    }
  }

  // 3. Remote.
  if (job.remote) {
    score += filters.remoteOnly ? 8 : 4;
    reasons.push('remote');
  }

  // 4. Salary: published beats unpublished, clearing the floor beats meeting it.
  const best = Math.max(job.salaryMax || 0, job.salaryMin || 0);
  if (best > 0) {
    score += 5;
    const floor = Number(filters.minSalary) || 0;
    if (floor > 0 && best >= floor * 1.15) {
      score += 5;
      reasons.push('pay is comfortably above your floor');
    } else if (floor > 0 && best >= floor) {
      reasons.push('pay meets your floor');
    } else {
      reasons.push('salary published');
    }
  }

  // 5. Recency, the heaviest single signal at up to +22.
  //
  //    Weighted this hard on purpose: applying early is one of the few things a
  //    candidate actually controls, and a posting more than a couple of months
  //    old has usually either been filled or gone stale in the pipeline. A
  //    perfect match from March is worth less than a good match from Tuesday.
  //
  //    An undated posting is left alone rather than penalised - plenty of feeds
  //    simply omit the field, and guessing would bury them.
  const ageDays = jobAgeDays(job);
  if (ageDays !== null) {
    if (ageDays <= 1) {
      score += 22;
      reasons.unshift('posted today');
    } else if (ageDays <= 3) {
      score += 18;
      reasons.unshift('posted in the last few days');
    } else if (ageDays <= 7) {
      score += 12;
      reasons.push('posted this week');
    } else if (ageDays <= 14) {
      score += 6;
      reasons.push('posted in the last fortnight');
    } else if (ageDays <= 30) {
      score -= 2;
    } else if (ageDays <= 60) {
      score -= 10;
      reasons.push('over a month old');
    } else {
      score -= 20;
      reasons.push('over two months old');
    }
  }

  // 6. Seniority alignment, 6 points per level of distance from the preferred
  //    level.
  const wanted = Number(filters.seniority);
  if (Number.isFinite(wanted) && wanted >= 0) {
    const gap = Math.abs(detectSeniority(job.title) - wanted);
    if (gap > 0) {
      score -= Math.min(18, gap * 6);
      reasons.push(gap === 1 ? 'seniority is slightly off' : 'seniority does not match');
    } else {
      score += 5;
      reasons.push('seniority matches');
    }
  }

  // 7. Below the stated minimum level. The ingest filter already drops these,
  //    so this only bites jobs collected before the minimum was set - without
  //    it, raising the minimum would leave the old ones sitting at the top of
  //    the list until they were archived by hand.
  const floorLevel = Number(filters.minSeniority);
  if (Number.isFinite(floorLevel) && floorLevel >= 0) {
    const stated = detectSeniorityLevel(job.title);
    if (stated !== null && stated < floorLevel) {
      score -= 25;
      reasons.push(`below your minimum level (${SENIORITY_LABELS[stated]})`);
    }
  }

  // 8. Curated companies. In "limit" mode the filter has already removed
  //    everyone else, so the boost only changes the ordering in "prioritize"
  //    mode - which is the whole difference between the two.
  const companies = String(filters.companies || '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  if (companies.length > 0 && companyOnList(job.company, companies)) {
    score += 15;
    reasons.unshift('on your company list');
  }

  // 9. The candidate profile, when one exists and is enabled.
  //
  //    Deal-breakers are absolute rather than a deduction. Something the person
  //    has said they will not accept should not sit near the top of their board
  //    with a polite penalty applied - it should be out.
  if (profile) {
    const dealBreaker = (profile.dealBreakers || [])
      .map((t) => String(t).trim().toLowerCase())
      .find((t) => t.length > 1 && haystack.includes(t));
    if (dealBreaker) {
      return {
        score: 0,
        reason: `ruled out — you listed "${dealBreaker}" as a deal-breaker`,
        scoredBy: 'heuristic',
        gaps: [`Mentions "${dealBreaker}"`],
      };
    }

    const missing = (profile.mustHave || [])
      .map((t) => String(t).trim().toLowerCase())
      .filter((t) => t.length > 1 && !haystack.includes(t));
    if (missing.length > 0) {
      score -= Math.min(25, missing.length * 12);
      gaps.push(`no mention of ${missing.slice(0, 3).join(', ')}`);
    }

    const matched = (profile.skills || [])
      .map((s) => String(s).trim().toLowerCase())
      .filter((s) => s.length > 1 && haystack.includes(s));
    if (matched.length > 0) {
      score += Math.min(15, matched.length * 3);
      reasons.push(`matches your ${matched.slice(0, 3).join(', ')}`);
    }
  }

  // A posting from a different field than the one asked for is pushed well
  // down. Without this a search for video work led with software engineering
  // roles that merely mentioned media, which is the single loudest way the
  // board looked broken.
  const clash = disciplineClash(job.title, prompt);
  if (clash < 0) {
    score -= clash;
    reasons.push('same field of work');
  }

  const raw = Math.max(0, Math.min(100, Math.round(score)));

  // A posting from a different field is capped, not merely penalised.
  //
  // Subtracting from a score that has already reached the ceiling changes
  // nothing, and that is exactly what happened: software roles whose titles
  // merely contained "video" sat at 100 alongside actual video editors, because
  // the title matched the phrase and every deduction was absorbed by the clamp.
  // A ceiling guarantees the ordering instead of hoping the arithmetic lands.
  const capped = clash > 0 ? Math.min(raw, 55) : raw;
  if (clash > 0) reasons.push('different field to what you asked for');

  return {
    score: capped,
    reason: reasons.length ? reasons.slice(0, 3).join('; ') : 'baseline relevance',
    scoredBy: 'heuristic',
    // What the job asks for that this candidate does not obviously have.
    // Empty is meaningful: it says nothing was found wanting, not that nothing
    // was checked.
    gaps,
  };
}

/**
 * What field of work a title belongs to.
 *
 * Ordered, and the first match wins, because titles routinely carry words from
 * two fields: "Senior Engineering Manager, Media Foundation" is a software job
 * that happens to mention media, and a search for video work should not be
 * shown it. Testing software before creative settles that the right way round.
 *
 * Only confident classifications are useful here - an unrecognised title
 * returns null and is left entirely to the ordinary scoring, because guessing a
 * discipline and penalising on the guess is worse than not classifying at all.
 */
const DISCIPLINES = [
  [
    'software',
    /\b(software|engineer|engineering|developer|programmer|devops|sre|backend|back-end|frontend|front-end|fullstack|full-stack|architect|data scientist|machine learning|platform|infrastructure|qa automation)\b/i,
  ],
  ['sales', /\b(sales|account executive|business development|quota|revenue|sdr|bdr)\b/i],
  ['support', /\b(customer (service|support|success)|client (success|services)|helpdesk|help desk|technical support)\b/i],
  ['finance', /\b(accountant|accounting|controller|auditor|bookkeep\w*|payroll|treasury|financial analyst)\b/i],
  [
    'healthcare',
    /\b(nurse|nursing|physician|clinician|therapist|caregiver|medical assistant|pharmac\w*|mental health|psycholog\w*|counsell?or|health professional|dentist|paramedic)\b/i,
  ],
  ['trades', /\b(electrician|plumber|carpenter|welder|installer|hvac|mechanic|technician, field|field technician)\b/i],
  ['teaching', /\b(teacher|tutor|instructor|coach|lecturer|professor|curriculum)\b/i],
  // Creative is tested last, after every role-defining noun.
  //
  // "Video" in a title is usually the domain rather than the job: "Customer
  // Success Manager, Video Games" is a support role at a games company, and
  // "Mental Health Professional (Chat & Video)" is a clinician. Matching
  // creative first read both as creative work and let them onto a photography
  // board; testing the role nouns first reads the title the way a person does.
  //
  // Bare "photo" and "video" belong here even so. Requiring "photograph" meant
  // the most natural phrasing of the search - "photo and video gigs" -
  // classified as nothing at all, and the field check silently never ran.
  [
    'creative',
    /\b(photo\w*|video\w*|cinematograph\w*|filmmak\w*|content creator|storytell\w*|retouch\w*|colou?rist|illustrator|animator|art director|graphic design\w*|visual design\w*|brand design\w*|creative director|producer|editorial)\b/i,
  ],
];

/** The field a piece of text belongs to, or null when it is not clear. */
export function detectDiscipline(text) {
  const value = String(text || '');
  for (const [name, re] of DISCIPLINES) {
    if (re.test(value)) return name;
  }
  return null;
}

/**
 * How badly a posting's field clashes with what was asked for.
 *
 * Returns a penalty, not a rejection. Fields genuinely overlap at the edges - a
 * video engineer sits between software and creative - so a hard filter would
 * throw away real matches. A large deduction pushes the clash off the first
 * screen while leaving it findable, which is the behaviour that survives being
 * wrong.
 */
export function disciplineClash(jobTitle, prompt) {
  const wanted = detectDiscipline(prompt);
  const got = detectDiscipline(jobTitle);
  if (!wanted || !got) return 0;
  // Same field is a strong positive: it is the single most reliable signal
  // that a posting is the kind of work someone asked for.
  if (wanted === got) return -12;
  return 35;
}
