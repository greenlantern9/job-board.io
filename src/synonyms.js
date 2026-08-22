// What employers call the job, versus what you call it.
//
// Matching used to be literal: a board asking for a "photographer" never saw a
// posting titled "Visual Storyteller", and one asking for "customer service"
// missed every "Client Success Associate". That put the burden on the person
// searching to guess an employer's vocabulary, which is exactly backwards - the
// whole point of the board is that they should not have to.
//
// So each term is expanded to the family it belongs to. A single word in the
// posting from anywhere in the family counts as a hit for the word the user
// typed. This is deliberately hand-written rather than derived: a wrong synonym
// is worse than a missing one, because it fills the board with confidently
// irrelevant results.

/**
 * Families of terms that mean the same job.
 *
 * Every member maps to every other, so the direction someone happens to phrase
 * it in does not matter. Kept to genuine equivalents - "editor" belongs with
 * video work and with writing, and lives in both families rather than being
 * forced into one.
 */
/**
 * Industries, kept apart from role families because they answer a different
 * question. A role word describes the posting and must be found in it; an
 * industry word describes the employer, and may be satisfied by what the
 * employer as a whole advertises - a "Program Manager, Mission Operations" at
 * a company whose other titles say avionics and propulsion IS an aerospace
 * program manager, whatever that one title omits.
 */
const INDUSTRY_FAMILIES = [
  ['aerospace', 'aeronautics', 'astronautics', 'avionics', 'spacecraft',
    'propulsion', 'orbital', 'satellite', 'spaceflight', 'aircraft', 'aviation'],
  ['defense', 'defence', 'missile', 'radar', 'warfighter', 'munitions'],
  ['biotech', 'biotechnology', 'genomics', 'bioinformatics', 'biologics',
    'immunology', 'oncology'],
  ['fintech', 'payments', 'banking', 'lending', 'trading', 'brokerage'],
];

/** Every word that names or implies an industry rather than a role. */
export const INDUSTRY_TERMS = new Set(INDUSTRY_FAMILIES.flat());

const FAMILIES = [
  // Camera, image and moving image, deliberately one family.
  //
  // Employers use these interchangeably: the same surf-camp job is advertised
  // as "Photographer", "Videographer", "Content Creator" and "Visual
  // Storyteller" depending on who wrote the listing. Splitting them into
  // separate families meant a search for one missed the other three, which is
  // precisely the guess-the-vocabulary problem this file exists to remove.
  ['photographer', 'photography', 'photo', 'photographic', 'shooter',
    'videographer', 'videography', 'video', 'cinematographer', 'cinematography',
    'filmmaker', 'film', 'storyteller', 'visual storyteller', 'content creator',
    'creator', 'documentarian', 'camera operator'],
  ['editor', 'editing', 'post production', 'post-production'],
  ['retoucher', 'retouching', 'colourist', 'colorist', 'grading'],
  // Design and brand
  ['designer', 'design', 'art director', 'creative', 'visual designer'],
  ['brand', 'branding', 'identity'],
  // Words that travel with creative work
  ['media', 'multimedia', 'production', 'creative services'],
  ['social media', 'social', 'reels', 'shortform', 'short-form', 'ugc'],

  // Support and service
  ['customer service', 'customer support', 'client services', 'client success',
    'customer success', 'support', 'helpdesk', 'help desk', 'service desk'],
  ['troubleshooting', 'technical support', 'diagnostics', 'field service'],
  // Teaching and guiding
  ['coach', 'coaching', 'instructor', 'instruction', 'trainer', 'training',
    'teacher', 'tutor', 'guide', 'mentor'],
  // Events
  ['wedding', 'weddings', 'bridal', 'engagement', 'elopement'],
  // "camp" sits in both this family and hospitality below - a surf camp is a
  // retreat and a place to stay, and a term is allowed to belong to more than
  // one family because the index unions them.
  ['event', 'events', 'retreat', 'retreats', 'workshop', 'workshops', 'camp', 'camps'],
  ['hospitality', 'resort', 'lodge', 'camp', 'guesthouse', 'hostel'],
  // Trades and energy
  ['solar', 'photovoltaic', 'pv', 'renewable', 'renewables'],
  ['installer', 'installation', 'technician', 'fitter', 'engineer field'],
  // Engagement shape
  ['contract', 'contractor', 'freelance', 'freelancer', 'self-employed', 'gig',
    'project-based', 'project based', 'temporary'],
  ['part time', 'part-time', 'casual', 'seasonal'],

  // Industries whose name almost never appears in their own job titles.
  //
  // Measured on live boards before this family existed: Anduril's 2,237 titles
  // carry avionics, propulsion, mission and rocket but not "aerospace";
  // SpaceX's 2,179 carry avionics, propulsion and satellite - not "aerospace"
  // and not even "program". A search for "aerospace program manager" therefore
  // scored both companies at or below a generic SaaS shop, because the
  // industry word describes the employer while matching reads titles. The
  // family maps the industry word to the title words its employers actually
  // use. Kept to words that are unambiguous in a job title - "flight",
  // "launch" and "mission" are used by airlines, marketing and product teams
  // respectively, and a wrong synonym is worse than a missing one.
  ...INDUSTRY_FAMILIES,
];

/** Joining words that carry no requirement of their own. */
const CONNECTIVES = new Set([
  'and', 'or', 'the', 'a', 'an', 'of', 'for', 'with', 'in', 'on', 'at', 'to', '&', '/', '+',
]);

/** term -> the set of terms that mean the same thing (including itself). */
const INDEX = new Map();
for (const family of FAMILIES) {
  for (const term of family) {
    const existing = INDEX.get(term) || new Set();
    for (const other of family) existing.add(other);
    INDEX.set(term, existing);
  }
}

/**
 * Everything a single word or phrase could reasonably be called.
 *
 * Returns the input alone when nothing is known about it - an unrecognised term
 * is matched literally, exactly as before.
 */
export function expandTerm(term) {
  const key = String(term || '').trim().toLowerCase();
  if (!key) return [];
  const family = INDEX.get(key);
  return family ? [...family] : [key];
}

/**
 * Expand the words inside a phrase, leaving its structure intact.
 *
 * "surf retreat photographer" becomes a matcher where "surf" must appear, and
 * something from the retreat family must appear, and something from the
 * photography family must appear - so a "Surf Camp Content Creator" matches
 * without the user having guessed that wording. The phrase still has to be
 * satisfied as a whole; expansion widens each slot rather than loosening the
 * requirement that every slot be filled.
 */
export function expandPhrase(phrase) {
  const clean = String(phrase || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!clean) return [];

  // The whole phrase first. Families contain multi-word entries - "customer
  // service", "content creator" - and splitting on whitespace before looking
  // them up meant they could never be found: "customer" and "service" are not
  // family members on their own, so the expansion silently did nothing and the
  // match stayed as literal as before.
  const whole = INDEX.get(clean);
  if (whole) return [[...whole]];

  return clean
    .split(' ')
    .filter(Boolean)
    // Connectives are not requirements. "photo and video" was compiling to
    // three slots - photo, the literal word "and", and video - so a posting had
    // to contain the word "and" in its title to match. One result came back for
    // the most natural phrasing of the search.
    .filter((word) => !CONNECTIVES.has(word))
    .map((word) => expandTerm(word));
}

/** True when a term family is known - used only for reporting. */
export function hasSynonyms(term) {
  return INDEX.has(String(term || '').trim().toLowerCase());
}
