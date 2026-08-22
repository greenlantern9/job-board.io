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

  // One live board per newly connected platform, each probed before being
  // written down. They put the new kinds into the catalogue immediately;
  // classification then reads the real titles and corrects the field.
  { kind: 'recruitee', identifier: 'bunq', label: 'bunq', category: 'software' },
  { kind: 'workable', identifier: 'blueground', label: 'Blueground', category: 'other' },
  { kind: 'personio', identifier: 'everphone', label: 'Everphone', category: 'software' },

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
  // A second probe, weighted to the platforms the first pass barely touched.
  // Thirty-two of a hundred and seventeen candidates answered with real jobs;
  // the rest were dropped. Ashby proved much richer than Lever, which is worth
  // knowing: it is newer, so its customers skew to companies founded recently.
  //
  // This pass is also the first to reach health and trades at all, which every
  // earlier candidate had missed.

  // Technology
  { kind: 'ashby', identifier: 'harvey', label: 'Harvey', category: 'software' },
  { kind: 'ashby', identifier: 'sierra', label: 'Sierra', category: 'software' },
  { kind: 'ashby', identifier: 'decagon', label: 'Decagon', category: 'software' },
  { kind: 'ashby', identifier: 'perplexity', label: 'Perplexity', category: 'software' },
  { kind: 'ashby', identifier: 'baseten', label: 'Baseten', category: 'software' },
  { kind: 'ashby', identifier: 'writer', label: 'Writer', category: 'software' },
  { kind: 'ashby', identifier: 'sardine', label: 'Sardine', category: 'software' },
  { kind: 'ashby', identifier: 'watershed', label: 'Watershed', category: 'software' },
  { kind: 'ashby', identifier: 'gamma', label: 'Gamma', category: 'software' },
  { kind: 'ashby', identifier: 'modal', label: 'Modal', category: 'software' },
  { kind: 'ashby', identifier: 'browserbase', label: 'Browserbase', category: 'software' },
  { kind: 'ashby', identifier: 'unify', label: 'Unify', category: 'software' },

  // Creative, media and design
  { kind: 'ashby', identifier: 'elevenlabs', label: 'ElevenLabs', category: 'creative' },
  { kind: 'ashby', identifier: 'synthesia', label: 'Synthesia', category: 'creative' },
  { kind: 'ashby', identifier: 'suno', label: 'Suno', category: 'creative' },
  { kind: 'ashby', identifier: 'photoroom', label: 'Photoroom', category: 'creative' },
  { kind: 'greenhouse', identifier: 'pinterest', label: 'Pinterest', category: 'creative' },
  { kind: 'greenhouse', identifier: 'crunchyroll', label: 'Crunchyroll', category: 'creative' },
  { kind: 'greenhouse', identifier: 'ghost', label: 'Ghost', category: 'creative' },

  // Teaching and coaching
  { kind: 'ashby', identifier: 'speak', label: 'Speak', category: 'teaching' },
  { kind: 'ashby', identifier: 'multiverse', label: 'Multiverse', category: 'teaching' },
  { kind: 'greenhouse', identifier: 'guild', label: 'Guild', category: 'teaching' },

  // Health and care
  { kind: 'greenhouse', identifier: 'onemedical', label: 'One Medical', category: 'care' },

  // Customer service and support
  { kind: 'greenhouse', identifier: 'intercom', label: 'Intercom', category: 'support' },

  // Trades and field work
  { kind: 'greenhouse', identifier: 'palmetto', label: 'Palmetto', category: 'trades' },

  // Consumer, retail and logistics
  { kind: 'lever', identifier: 'gopuff', label: 'Gopuff', category: 'other' },
  { kind: 'lever', identifier: 'rover', label: 'Rover', category: 'other' },
  // A third pass, aimed squarely at the fields the catalogue was thinnest in.
  // Thirty-six of a hundred and eighteen answered, and it is the pass that
  // finally reached marketing, sales and product - all three of which had no
  // company boards at all, so those searches were running on aggregators alone.
  //
  // Anything listing a single open role was skipped: one job does not justify a
  // source slot that costs a request on every refresh.

  // Health and care
  { kind: 'greenhouse', identifier: 'zocdoc', label: 'Zocdoc', category: 'care' },
  { kind: 'greenhouse', identifier: 'cortica', label: 'Cortica', category: 'care' },
  { kind: 'ashby', identifier: 'abridge', label: 'Abridge', category: 'care' },
  { kind: 'greenhouse', identifier: 'komodohealth', label: 'Komodo Health', category: 'care' },
  { kind: 'greenhouse', identifier: 'omadahealth', label: 'Omada Health', category: 'care' },
  { kind: 'ashby', identifier: 'superpower', label: 'Superpower', category: 'care' },
  { kind: 'greenhouse', identifier: 'carrotfertility', label: 'Carrot Fertility', category: 'care' },
  { kind: 'greenhouse', identifier: 'modernhealth', label: 'Modern Health', category: 'care' },
  { kind: 'greenhouse', identifier: 'parsleyhealth', label: 'Parsley Health', category: 'care' },
  { kind: 'ashby', identifier: 'openevidence', label: 'OpenEvidence', category: 'care' },

  // Creative, media and design
  { kind: 'greenhouse', identifier: 'sothebys', label: "Sotheby's", category: 'creative' },
  { kind: 'ashby', identifier: 'pika', label: 'Pika', category: 'creative' },
  { kind: 'ashby', identifier: 'krea', label: 'Krea', category: 'creative' },
  { kind: 'ashby', identifier: 'playbook', label: 'Playbook', category: 'creative' },
  { kind: 'ashby', identifier: 'recraft', label: 'Recraft', category: 'creative' },

  // Marketing and writing
  { kind: 'greenhouse', identifier: 'braze', label: 'Braze', category: 'marketing' },
  { kind: 'greenhouse', identifier: 'klaviyo', label: 'Klaviyo', category: 'marketing' },
  { kind: 'greenhouse', identifier: 'later', label: 'Later', category: 'marketing' },
  { kind: 'greenhouse', identifier: 'iterable', label: 'Iterable', category: 'marketing' },
  { kind: 'greenhouse', identifier: 'hootsuite', label: 'Hootsuite', category: 'marketing' },

  // Product and programme
  { kind: 'greenhouse', identifier: 'mixpanel', label: 'Mixpanel', category: 'product' },
  { kind: 'greenhouse', identifier: 'launchdarkly', label: 'LaunchDarkly', category: 'product' },
  { kind: 'greenhouse', identifier: 'pendo', label: 'Pendo', category: 'product' },
  { kind: 'greenhouse', identifier: 'amplitude', label: 'Amplitude', category: 'product' },

  // Sales and business development
  { kind: 'greenhouse', identifier: 'zoominfo', label: 'ZoomInfo', category: 'sales' },
  { kind: 'ashby', identifier: 'attio', label: 'Attio', category: 'sales' },
  { kind: 'greenhouse', identifier: 'salesloft', label: 'Salesloft', category: 'sales' },

  // Customer service and support
  { kind: 'ashby', identifier: 'pylon', label: 'Pylon', category: 'support' },
  { kind: 'ashby', identifier: 'plain', label: 'Plain', category: 'support' },
  { kind: 'ashby', identifier: 'lorikeet', label: 'Lorikeet', category: 'support' },

  // Teaching and coaching
  { kind: 'greenhouse', identifier: 'udemy', label: 'Udemy', category: 'teaching' },
  { kind: 'greenhouse', identifier: '2u', label: '2U', category: 'teaching' },

  // Trades, energy and field work
  { kind: 'greenhouse', identifier: 'redwoodmaterials', label: 'Redwood Materials', category: 'trades' },
  { kind: 'ashby', identifier: 'gradient', label: 'Gradient', category: 'trades' },
  { kind: 'ashby', identifier: 'terra', label: 'Terra', category: 'trades' },
];

/**
 * How many seeds to attach. Each is one outbound request per refresh, and a
 * Worker has a per-request subrequest budget to stay inside alongside the
 * aggregators.
 */
export const SEED_LIMIT = 36;
