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
  { kind: 'greenhouse', identifier: 'databricks', label: 'Databricks' },
  { kind: 'ashby', identifier: 'openai', label: 'OpenAI' },
  { kind: 'greenhouse', identifier: 'stripe', label: 'Stripe' },
  { kind: 'greenhouse', identifier: 'anthropic', label: 'Anthropic' },
  { kind: 'greenhouse', identifier: 'datadog', label: 'Datadog' },
  { kind: 'greenhouse', identifier: 'mongodb', label: 'MongoDB' },
  { kind: 'greenhouse', identifier: 'cloudflare', label: 'Cloudflare' },
  { kind: 'greenhouse', identifier: 'brex', label: 'Brex' },
  { kind: 'greenhouse', identifier: 'elastic', label: 'Elastic' },
  { kind: 'greenhouse', identifier: 'gitlab', label: 'GitLab' },
  { kind: 'greenhouse', identifier: 'affirm', label: 'Affirm' },
  { kind: 'greenhouse', identifier: 'airbnb', label: 'Airbnb' },
  { kind: 'greenhouse', identifier: 'coinbase', label: 'Coinbase' },
  { kind: 'greenhouse', identifier: 'figma', label: 'Figma' },
  { kind: 'greenhouse', identifier: 'twilio', label: 'Twilio' },
  { kind: 'greenhouse', identifier: 'reddit', label: 'Reddit' },
  { kind: 'ashby', identifier: 'ramp', label: 'Ramp' },
  { kind: 'greenhouse', identifier: 'asana', label: 'Asana' },
  { kind: 'ashby', identifier: 'cursor', label: 'Cursor' },
  { kind: 'greenhouse', identifier: 'instacart', label: 'Instacart' },
  { kind: 'lever', identifier: 'spotify', label: 'Spotify' },
  { kind: 'ashby', identifier: 'replit', label: 'Replit' },
  { kind: 'greenhouse', identifier: 'discord', label: 'Discord' },
  { kind: 'greenhouse', identifier: 'dropbox', label: 'Dropbox' },
  { kind: 'ashby', identifier: 'linear', label: 'Linear' },
  { kind: 'smartrecruiters', identifier: 'BoschGroup', label: 'Bosch' },
];

/**
 * How many seeds to attach. Each is one outbound request per refresh, and a
 * Worker has a per-request subrequest budget to stay inside alongside the
 * aggregators.
 */
export const SEED_LIMIT = 20;
