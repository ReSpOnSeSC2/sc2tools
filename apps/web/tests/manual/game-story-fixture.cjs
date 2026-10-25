/* Reuse the reviewed local API/auth/Next boundaries, with explicit story data.
 * Run from apps/web. This creates only ignored .tmp assets, with no network. */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
let source = fs.readFileSync('tests/manual/game-navigation-fixture.cjs', 'utf8')
  .replaceAll('game-navigation-fixture', 'game-story-fixture').replaceAll('3217', '3218');
function replaceOnce(from, to) {
  if (source.split(from).length !== 2) throw new Error('Story fixture boundary drifted: ' + from.slice(0, 60));
  source = source.replace(from, to);
}
replaceOnce("const game={gameId:'sample'", "const storyQ=new URLSearchParams(location.search);const game={gameId:'sample'");
replaceOnce("result:'Defeat'", "result:storyQ.get('variant')==='loss'?'Defeat':storyQ.get('variant')==='draw'?'Tie':'Victory'");
const originalSamples = source.match(/const samples=\[[^\r\n]+;/)?.[0];
if (!originalSamples) throw new Error('Missing sample fixture declaration');
replaceOnce(originalSamples, "const samples=Array.from({length:21},(_,i)=>({time:i*30,army_value:i<8?400+i*150:i<10?1700-(i-8)*500:1500+(i-10)*200,food_workers:12+i*3,food_used:12+i*9,food_made:15+i*12,minerals_current:50+i*50,vespene_current:25+i*20,minerals_collection_rate:500+i*150,vespene_collection_rate:100+i*75}));");
replaceOnce('const macro={ok:true', 'const baseMacro={ok:true');
const casualties = [
  { time: 190, owner: 'me', killer: 'opp', category: 'units', name: 'Marine' },
  { time: 195, owner: 'opp', killer: 'me', category: 'units', name: 'Marauder' },
  { time: 300, owner: 'me', killer: 'opp', category: 'units', name: 'SiegeTank' },
  { time: 301, owner: 'opp', killer: 'me', category: 'units', name: 'Marine' },
  { time: 450, owner: 'me', killer: 'opp', category: 'units', name: 'UnknownFixtureUnit' },
  { time: 451, owner: 'opp', killer: 'me', category: 'units', name: 'Marine' },
];
replaceOnce('const events=[', `const macro=storyQ.get('variant')==='empty'?{...baseMacro,stats_events:[],opp_stats_events:[],casualty_events:[],all_leaks:[],raw:{sq:71,supply_blocked_seconds:0}}:{...baseMacro,opp_stats_events:samples.map((s,i)=>({...s,army_value:i<8?500+i*100:i<10?1200-(i-8)*250:1600+(i-10)*100,food_workers:14+i*2,minerals_collection_rate:450+i*130})),casualty_events:storyQ.has('estimated')?undefined:${JSON.stringify(casualties)}};\nconst events=[`);
fs.mkdirSync('.tmp', { recursive: true });
fs.writeFileSync('.tmp/game-story-generator.cjs', source);
execFileSync(process.execPath, [path.resolve('.tmp/game-story-generator.cjs')], { stdio: 'inherit' });
