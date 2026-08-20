// One category per board, inferred and correctable.
//
// Four separate things were being guessed independently from the same sentence:
// which We Work Remotely feed to read, which Jobicy tag to send, which Muse
// category to request, and which field a posting belongs to. Four regex
// inferences over the same text, each able to disagree with the others - which
// is how a photography board ended up reading a support role at a games company
// as creative work.
//
// Making it one explicit value fixes all four at once. It is inferred from what
// the user wrote so nobody has to fill in a form field, shown so they can see
// what it decided, and correctable in one click when the guess is wrong. A
// required dropdown would have bought the same routing at the cost of making
// people map their own words onto someone else's taxonomy.

/**
 * The categories a board can hold.
 *
 * Kept deliberately short. A long taxonomy is harder to choose from and no more
 * accurate, and every entry has to earn itself by routing at least one source
 * differently from the others.
 */
export const CATEGORIES = [
  {
    id: 'creative',
    label: 'Photo, video and creative',
    hint: 'Photography, video, design, content, brand',
    match:
      /\b(photo\w*|video\w*|cinematograph\w*|filmmak\w*|content creator|storytell\w*|retouch\w*|colou?rist|illustrat\w*|animat\w*|art direct\w*|graphic design\w*|visual design\w*|brand\w*|creative|editorial|producer)\b/i,
    wwr: 'remote-design-jobs',
    jobicy: 'design',
    muse: 'Design',
  },
  {
    id: 'software',
    label: 'Software and data',
    hint: 'Engineering, data, infrastructure, security',
    match:
      /\b(software|engineer\w*|developer|programm\w*|devops|sre|backend|back-end|frontend|front-end|fullstack|full-stack|data scien\w*|machine learning|infrastructure|platform|security engineer)\b/i,
    wwr: 'remote-programming-jobs',
    jobicy: 'dev',
    muse: 'Software Engineering',
  },
  {
    id: 'support',
    label: 'Customer service and support',
    hint: 'Support, success, troubleshooting, helpdesk',
    match:
      /\b(customer (service|support|success)|client (success|services)|helpdesk|help desk|technical support|troubleshoot\w*|service desk)\b/i,
    wwr: 'remote-customer-support-jobs',
    jobicy: 'support',
    muse: 'Customer Service',
  },
  {
    id: 'marketing',
    label: 'Marketing and writing',
    hint: 'Marketing, growth, social, copywriting',
    match: /\b(market\w*|growth|seo|social media|copywrit\w*|content strateg\w*|communications)\b/i,
    wwr: 'remote-marketing-jobs',
    jobicy: 'marketing',
    muse: 'Marketing',
  },
  {
    id: 'sales',
    label: 'Sales and business development',
    hint: 'Sales, accounts, partnerships',
    match: /\b(sales|account executive|business development|partnerships|sdr|bdr|quota)\b/i,
    wwr: 'remote-sales-jobs',
    jobicy: 'sales',
    muse: 'Sales',
  },
  {
    id: 'product',
    label: 'Product and programme',
    hint: 'Product, programme and project management',
    match: /\b(product manage\w*|product owner|program manage\w*|programme manage\w*|project manage\w*|roadmap|tpm)\b/i,
    wwr: 'remote-product-jobs',
    jobicy: 'management',
    muse: 'Project Management',
  },
  {
    id: 'teaching',
    label: 'Teaching and coaching',
    hint: 'Instructing, coaching, guiding, training',
    match: /\b(teach\w*|tutor\w*|instructor|coach\w*|lecturer|professor|curriculum|guide|trainer)\b/i,
    wwr: '',
    jobicy: '',
    muse: 'Education',
  },
  {
    id: 'trades',
    label: 'Trades and field work',
    hint: 'Install, repair, solar, electrical, maintenance',
    match:
      /\b(electric\w*|plumb\w*|carpent\w*|welder|installer|installation|hvac|mechanic|field (service|technician)|solar|photovoltaic|maintenance)\b/i,
    wwr: '',
    jobicy: '',
    muse: '',
  },
  {
    id: 'care',
    label: 'Health and care',
    hint: 'Clinical, care, wellbeing',
    match:
      /\b(nurse|nursing|physician|clinician|therapist|caregiver|medical|mental health|psycholog\w*|counsell?or|paramedic|dentist|veterinar\w*|vet tech\w*|kennel|animal care)\b/i,
    wwr: '',
    jobicy: '',
    muse: 'Healthcare',
  },
  {
    id: 'other',
    label: 'Something else',
    hint: 'No category — search everything',
    match: null,
    wwr: '',
    jobicy: '',
    muse: '',
  },
];

const BY_ID = new Map(CATEGORIES.map((category) => [category.id, category]));

export function getCategory(id) {
  return BY_ID.get(String(id || '')) || null;
}

export function isCategory(id) {
  return BY_ID.has(String(id || ''));
}

/**
 * The category a sentence is describing, or 'other' when nothing fits.
 *
 * Ordered by the list above, and the first match wins - which is why the
 * role-defining categories are declared before creative. "Video" in a sentence
 * is usually the subject rather than the job, so a support or care role that
 * happens to mention it must not be read as creative work.
 */

/**
 * The order categories are tested in, which is deliberately not the order they
 * are displayed in.
 *
 * Trades goes before software because the software pattern accepts a bare
 * "engineer", and most engineers are not software engineers. An HVAC
 * manufacturer's board was filing "Field Service Engineer", "Electrical
 * Engineer" and "Plant Process Engineer" under software - fifty-four of its
 * hundred and eight postings - purely because software was tested first.
 *
 * Keeping the bare "engineer" matters: somebody typing "engineer" into the box
 * means software, and qualifying the pattern would break that. Testing the
 * specific trades first fixes the titles without touching the prompt.
 */
const PRECEDENCE = ['creative', 'trades', 'care', 'software', 'support', 'marketing', 'sales', 'product', 'teaching'];

export function inferCategory(text) {
  const value = String(text || '');
  if (!value.trim()) return 'other';
  for (const id of PRECEDENCE) {
    const category = getCategory(id);
    if (category && category.match && category.match.test(value)) return category.id;
  }
  return 'other';
}

/** The taxonomy value a given source wants, or '' when it has none for this
 *  category and should be skipped rather than sent a bad parameter. */
export function categoryFor(source, id) {
  const category = getCategory(id);
  return (category && category[source]) || '';
}
