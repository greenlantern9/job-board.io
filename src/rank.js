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

/** 0 intern, 1 junior, 2 mid (default), 3 senior/staff, 4 principal, 5 exec. */
export function detectSeniority(title) {
  for (const { re, level } of SENIORITY) if (re.test(title)) return level;
  return 2;
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
export function heuristicScore(job, { prompt = '', filters = {} } = {}) {
  const haystack = `${job.title} ${job.company} ${job.location} ${job.description}`.toLowerCase();
  const titleText = String(job.title || '').toLowerCase();
  const reasons = [];
  let score = 40; // neutral baseline

  // 1. Criteria overlap (up to +35). A term in the title counts twice - it is a
  //    far stronger signal than the same word buried in a benefits list.
  const promptTerms = [...new Set(words(prompt).filter((w) => !STOPWORDS.has(w)))];
  if (promptTerms.length > 0) {
    let hits = 0;
    let titleHits = 0;
    for (const term of promptTerms) {
      if (haystack.includes(term)) {
        hits++;
        if (titleText.includes(term)) titleHits++;
      }
    }
    const ratio = Math.min(1, (hits + titleHits) / Math.max(4, promptTerms.length * 0.6));
    score += Math.round(ratio * 35);
    reasons.push(
      hits > 0
        ? `matches ${hits}/${promptTerms.length} of your criteria terms`
        : 'no overlap with your stated criteria'
    );
  }

  // 2. Required keyword in the title (up to +10).
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

  // 5. Recency (up to +12). Past ~60 days a posting is usually already filled.
  if (job.postedAt) {
    const ageDays = (Date.now() - new Date(job.postedAt).getTime()) / 86400000;
    if (Number.isFinite(ageDays) && ageDays >= 0) {
      if (ageDays <= 3) {
        score += 12;
        reasons.push('posted in the last few days');
      } else if (ageDays <= 14) {
        score += 7;
        reasons.push('posted recently');
      } else if (ageDays > 60) {
        score -= 10;
        reasons.push('posting is over two months old');
      }
    }
  }

  // 6. Seniority alignment, 6 points per level of distance.
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

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    reason: reasons.length ? reasons.slice(0, 3).join('; ') : 'baseline relevance',
    scoredBy: 'heuristic',
  };
}
