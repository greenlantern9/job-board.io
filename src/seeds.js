// A starting set of company job boards.
//
// Aggregators are wide but shallow: for a search like "technical program
// manager" all five of them combined returned nothing, while a handful of
// company boards had the role several times over. Senior and specialised roles
// live on company career pages, not on remote-job feeds.
//
// Discovery finds companies from the criteria, but it needs an Anthropic key.
// Without one a board used to fall back to aggregators alone, which is the
// worst version of the product. These seeds mean the free path still reaches
// several thousand real postings from named employers.
//
// Every entry was verified against its live API. Slugs that returned nothing
// were dropped rather than shipped hopefully - a source that silently yields
// zero is worse than one that is absent.

export const SEED_COMPANIES = [
  { kind: 'greenhouse', identifier: 'databricks', label: 'Databricks', category: 'software' },
  { kind: 'ashby', identifier: 'openai', label: 'OpenAI', category: 'software' },
  { kind: 'greenhouse', identifier: 'stripe', label: 'Stripe', category: 'software' },
  { kind: 'greenhouse', identifier: 'anthropic', label: 'Anthropic', category: 'software' },
  { kind: 'greenhouse', identifier: 'datadog', label: 'Datadog', category: 'software' },
  { kind: 'greenhouse', identifier: 'mongodb', label: 'MongoDB', category: 'software' },
  { kind: 'greenhouse', identifier: 'cloudflare', label: 'Cloudflare', category: 'software' },
  { kind: 'greenhouse', identifier: 'brex', label: 'Brex', category: 'software' },
  { kind: 'greenhouse', identifier: 'elastic', label: 'Elastic', category: 'software' },
  { kind: 'greenhouse', identifier: 'gitlab', label: 'GitLab', category: 'software' },
  { kind: 'greenhouse', identifier: 'affirm', label: 'Affirm', category: 'software' },
  { kind: 'greenhouse', identifier: 'airbnb', label: 'Airbnb', category: 'software' },
  { kind: 'greenhouse', identifier: 'coinbase', label: 'Coinbase', category: 'software' },
  { kind: 'greenhouse', identifier: 'figma', label: 'Figma', category: 'software' },
  { kind: 'greenhouse', identifier: 'twilio', label: 'Twilio', category: 'software' },
  { kind: 'greenhouse', identifier: 'reddit', label: 'Reddit', category: 'software' },
  { kind: 'ashby', identifier: 'ramp', label: 'Ramp', category: 'software' },
  { kind: 'greenhouse', identifier: 'asana', label: 'Asana', category: 'software' },
  { kind: 'ashby', identifier: 'cursor', label: 'Cursor', category: 'software' },
  { kind: 'greenhouse', identifier: 'instacart', label: 'Instacart', category: 'software' },
  { kind: 'lever', identifier: 'spotify', label: 'Spotify', category: 'software' },
  { kind: 'ashby', identifier: 'replit', label: 'Replit', category: 'software' },
  { kind: 'greenhouse', identifier: 'discord', label: 'Discord', category: 'software' },
  { kind: 'greenhouse', identifier: 'dropbox', label: 'Dropbox', category: 'software' },
  { kind: 'ashby', identifier: 'linear', label: 'Linear', category: 'software' },
  { kind: 'smartrecruiters', identifier: 'BoschGroup', label: 'Bosch', category: 'software' },

  // Verified additions, probed against the live APIs before being written down.
  // Weighted deliberately away from technology: the original set was entirely
  // software employers, which is why a photography or coaching board found
  // nothing among them. A field with no companies here falls back to the
  // aggregators and to discovery rather than borrowing someone else's.
  //
  // Thirty-seven other candidates were tried and dropped - health and trades
  // in particular returned nothing usable, so those fields still depend on
  // discovery. Shipping a slug that yields zero would only cost a request.

  // Creative, media and design
  { kind: 'greenhouse', identifier: 'squarespace', label: 'Squarespace', category: 'creative' },
  { kind: 'greenhouse', identifier: 'hearst', label: 'Hearst', category: 'creative' },
  { kind: 'greenhouse', identifier: 'a24', label: 'A24', category: 'creative' },
  { kind: 'ashby', identifier: 'runway', label: 'Runway', category: 'creative' },
  { kind: 'greenhouse', identifier: 'buzzfeed', label: 'BuzzFeed', category: 'creative' },

  // Teaching and coaching
  { kind: 'greenhouse', identifier: 'duolingo', label: 'Duolingo', category: 'teaching' },
  { kind: 'greenhouse', identifier: 'khanacademy', label: 'Khan Academy', category: 'teaching' },
  { kind: 'greenhouse', identifier: 'coursera', label: 'Coursera', category: 'teaching' },
  { kind: 'greenhouse', identifier: 'outschool', label: 'Outschool', category: 'teaching' },

  // Customer service and support
  { kind: 'greenhouse', identifier: 'monzo', label: 'Monzo', category: 'support' },
  { kind: 'greenhouse', identifier: 'chime', label: 'Chime', category: 'support' },
  { kind: 'greenhouse', identifier: 'wise', label: 'Wise', category: 'support' },

  // Consumer, retail and hospitality
  { kind: 'greenhouse', identifier: 'lyft', label: 'Lyft', category: 'other' },
  { kind: 'greenhouse', identifier: 'peloton', label: 'Peloton', category: 'other' },
  { kind: 'greenhouse', identifier: 'sweetgreen', label: 'Sweetgreen', category: 'other' },
  { kind: 'greenhouse', identifier: 'glossier', label: 'Glossier', category: 'other' },

  // More technology, deepening the field that already worked
  { kind: 'lever', identifier: 'palantir', label: 'Palantir', category: 'software' },
  { kind: 'greenhouse', identifier: 'flexport', label: 'Flexport', category: 'software' },
  { kind: 'greenhouse', identifier: 'robinhood', label: 'Robinhood', category: 'software' },
  { kind: 'ashby', identifier: 'vanta', label: 'Vanta', category: 'software' },
  { kind: 'greenhouse', identifier: 'gusto', label: 'Gusto', category: 'software' },
  { kind: 'greenhouse', identifier: 'vercel', label: 'Vercel', category: 'software' },
  { kind: 'ashby', identifier: 'supabase', label: 'Supabase', category: 'software' },
  { kind: 'greenhouse', identifier: 'airtable', label: 'Airtable', category: 'software' },
  // Visa verified with two open roles, which is not worth a source slot - and
  // the end-to-end suite uses it as its example of a company the seeds do not
  // cover, so seeding it would quietly break that check rather than the seed
  // list being the thing that gives way.
  { kind: 'greenhouse', identifier: 'marqeta', label: 'Marqeta', category: 'software' },
];

/**
 * How many seeds to attach. Each is one outbound request per refresh, and a
 * Worker has a per-request subrequest budget to stay inside alongside the
 * aggregators.
 */
export const SEED_LIMIT = 20;
