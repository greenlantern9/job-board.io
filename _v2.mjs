import { heuristicScore as noclamp } from './src/_rank_noclamp.js';
import { heuristicScore } from './src/rank.js';
const day = (n) => new Date(Date.now() - n*86400000).toISOString();
const prompt = 'technical program manager roles';
const mk = (age, pay) => ({
  title: 'Technical Program Manager', company: 'Acme', location: 'Remote',
  description: 'Technical program manager. Drive cross-functional programs.',
  remote: true, postedAt: day(age), salaryMin: pay*0.9, salaryMax: pay,
});
console.log('age\tpay\tCLAIMED_pre\tCLAIMED_rep\tACTUAL_pre\tACTUAL_rep');
const claimed = [[0.2,260000,159,100],[3,200000,155,100],[13,160000,136,100],[25,120000,126,100],[45,95000,116,100]];
for (const [age,pay,cp,cr] of claimed) {
  const j = mk(age,pay);
  const n = noclamp(j, { prompt, filters: {} });
  const s = heuristicScore(j, { prompt, filters: {} });
  console.log(`${age}\t${pay}\t${cp}\t${cr}\t${n.score}\t${s.score}`);
}
