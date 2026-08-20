import fs from 'fs';
import { heuristicScore as clamped } from './src/rank.js';
import { heuristicScore as unclamped } from './src/_rank_noclamp.js';
import { jobAgeDays } from './src/rank.js';
import { ADMIT_SCORE_FLOOR, PREFER_FRESHER_THAN_DAYS, PER_EMPLOYER_LIMIT } from './src/ingest.js';

const rows = JSON.parse(fs.readFileSync('_board.json','utf8'))[0].results;
const prompt = 'software engineer roles';
const filters = {"keywords":"","exclude":"","locations":"","remoteOnly":false,"minSalary":0,"companies":"","companyMode":"prioritize"};
const jobs = rows.map((r,i)=>({ idx:i, title:r.title, company:r.company, location:'', description:r.description||'',
  remote:!!r.remote, postedAt:r.posted_at, salaryMin:r.salary_min, salaryMax:r.salary_max }));

function select(scorer, label) {
  const rescored = jobs.map(j=>({ j, score: scorer(j,{prompt,filters}).score })).sort((a,b)=>b.score-a.score);
  const admitted = rescored.filter(x=>x.score>=ADMIT_SCORE_FLOOR);
  const fresh = x => { const d=jobAgeDays(x.j); return d===null||d<=PREFER_FRESHER_THAN_DAYS; };
  const relevant=[...admitted.filter(fresh),...admitted.filter(x=>!fresh(x))];
  const slots=10, want=slots+5, held=new Map(), chosen=[];
  for(const it of relevant){ if(chosen.length>=want) break;
    const k=String(it.j.company||'').trim().toLowerCase();
    if(k&&(held.get(k)||0)>=PER_EMPLOYER_LIMIT) continue;
    chosen.push(it); if(k) held.set(k,(held.get(k)||0)+1); }
  const top = chosen.slice(0,slots);
  console.log(`\n== ${label} == admitted ${admitted.length} distinct-scores ${new Set(rescored.map(x=>x.score)).size}`);
  top.forEach((x,i)=>console.log(' ',i,x.score,(x.j.postedAt||'').slice(0,10),String(x.j.company).slice(0,18).padEnd(18),String(x.j.title).slice(0,42)));
  return top.map(x=>x.j.idx);
}
const a = select(clamped,'CLAMPED (as shipped)');
const b = select(unclamped,'UNCLAMPED (hypothetical fix)');
console.log('\nsame set? ', JSON.stringify([...a].sort((x,y)=>x-y))===JSON.stringify([...b].sort((x,y)=>x-y)));
console.log('same order?', JSON.stringify(a)===JSON.stringify(b));
console.log('clamped idx  ', JSON.stringify(a));
console.log('unclamped idx', JSON.stringify(b));
console.log('in unclamped-top10 but NOT clamped-top10:', b.filter(x=>!a.includes(x)));
console.log('count returned: clamped', a.length, 'unclamped', b.length);
