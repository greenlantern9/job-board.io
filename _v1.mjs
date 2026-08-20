import { heuristicScore, jobAgeDays } from './src/rank.js';
import { ADMIT_SCORE_FLOOR, HYDRATE_LIMIT, PREFER_FRESHER_THAN_DAYS } from './src/ingest.js';
const day = (n) => new Date(Date.now() - n*86400000).toISOString();
const prompt = 'technical program manager roles';
const mk = (age, pay) => ({
  title: 'Technical Program Manager', company: 'Acme', location: 'Remote',
  description: 'Technical program manager. Drive cross-functional programs.',
  remote: true, postedAt: day(age), salaryMin: pay*0.9, salaryMax: pay,
});
console.log('ADMIT_SCORE_FLOOR', ADMIT_SCORE_FLOOR, 'HYDRATE_LIMIT', HYDRATE_LIMIT, 'PREFER_FRESHER_THAN_DAYS', PREFER_FRESHER_THAN_DAYS);
for (const [age,pay] of [[0.2,260000],[3,200000],[13,160000],[25,120000],[45,95000]]) {
  const j = mk(age,pay);
  const s = heuristicScore(j, { prompt, filters: {} });
  console.log('age', age, 'pay', pay, '=> reported', s.score, '| ageDays', jobAgeDays(j)?.toFixed(1), '| admitted', s.score>=ADMIT_SCORE_FLOOR, '|', s.reason);
}
