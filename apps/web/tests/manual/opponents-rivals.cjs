/* Actual opponent consumers, production CSS/fonts, synthetic API/auth only.
 * Run from apps/web after production build: node tests/manual/opponents-rivals.cjs
 * Nonlocal traffic is blocked; no provider or real account operation occurs. */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process'), { chromium, expect } = require('@playwright/test');
execFileSync(process.execPath, ['tests/manual/opponents-rivals-fixture.cjs'], { stdio:'inherit' });
const root = process.cwd(), origin = 'http://127.0.0.1:3242', reads = [], writes = [];
const css = fs.readdirSync('.next/static/css', { recursive:true }).filter(name => name.endsWith('.css')).map(name => fs.readFileSync(path.join('.next/static/css',name),'utf8')).join('\n');
const fonts = "@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay;--font-serif:serif}";
const rows = Array.from({length:1500},(_,i)=>({ pulseId:'p-'+i, pulseCharacterId:String(101+i), toonHandle:'1-S2-1-'+(10000+i), name:i===0?'Neon expansion and a long account name':i===1?'NeonEU':i===2?'Frost':'Player '+String(i).padStart(4,'0'), race:['P','Z','T'][i%3], wins:i===0?2:3+(i%5), losses:i===0?6:1+(i%4), games:i===0?8:4+(i%5)+(i%4), winRate:i===0?.25:(3+i%5)/(4+i%5+i%4), mmr:4200+i%120, lastPlayed:new Date(Date.now()-i*60000).toISOString(), ...(i===0?{notesMeta:{preview:'Check the third base; wait for the scout.'}}:{}) }));
const impacts = rows.map((row,i)=>({...row,opponentRace:row.race,netMmr:i===0?-12:15,mmrWon:20,mmrLost:i===0?32:5,pairs:3,avgDelta:i===0?-4:5}));
const prefs = new Map();
const json = (res,value,status=200)=>{res.statusCode=status;res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};
const server = http.createServer((req,res)=>{
  const url = new URL(req.url,origin), ref = new URL(req.headers.referer||origin), mode = ref.searchParams.get('mode'), owner = req.headers.authorization?.replace('Bearer ','')||'';
  const records = mode==='empty'?[]:rows;
  if(url.pathname.startsWith('/v1/'))reads.push({path:url.pathname,query:url.search,owner,method:req.method});
  if(url.pathname==='/v1/player-channels/resolve') { let text='';req.on('data',chunk=>text+=chunk);return req.on('end',()=>json(res,{players:(JSON.parse(text).players||[]).map(player=>({...player,channels:player.pulseCharacterId==='101'||player.pulseCharacterId==='102'?{twitch:'https://www.twitch.tv/syntheticplayer'}:{}}))})); }
  if(url.pathname==='/v1/me/preferences/rivals') {
    if(!prefs.has(owner))prefs.set(owner,owner==='owner-a'?['acct:900','solo:p-2']:[]);
    if(req.method==='GET')return json(res,{keys:prefs.get(owner)});
    let text='';req.on('data',chunk=>text+=chunk);return req.on('end',()=>{const saved=JSON.parse(text);prefs.set(owner,saved.keys);writes.push({owner,keys:saved.keys});json(res,saved)});
  }
  if(url.pathname==='/v1/opponents/pulse-links')return json(res,{links:{101:{accountId:'900'},102:{accountId:'900'}},partial:false});
  if(url.pathname==='/v1/opponents'){
    if(mode==='error')return json(res,{error:{code:'synthetic_busy',message:'Synthetic local retry state'}},503);
    const before=url.searchParams.get('before'), candidates=records.filter(row=>!before||row.lastPlayed<before),limit=Number(url.searchParams.get('limit')||200),page=candidates.slice(0,limit);
    return json(res,{items:page,nextBefore:candidates.length>limit?page.at(-1).lastPlayed:null});
  }
  if(url.pathname==='/v1/mmr-by-matchup/opponents'){
    const offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||200), all=mode==='unmeasured'||mode==='empty'?[]:impacts;
    return json(res,{items:all.slice(offset,offset+limit),totalOpponents:all.length,offset,limit,summary:{netMmr:100,mmrWon:200,mmrLost:100,pairs:all.length*3,opponents:all.length,mostMmrGainedFrom:all[2],mostMmrLostTo:all[0]}});
  }
  if(url.pathname==='/v1/rivals/summary'){
    let text='';req.on('data',chunk=>text+=chunk);return req.on('end',()=>{const input=JSON.parse(text);json(res,{generatedAt:new Date().toISOString(),hasAnyGames:mode!=='empty',recentComplete:true,weekGames:{'p-0':3,'p-1':2,'p-2':2},rivals:input.groups.map(group=>({key:group.key,sampleGames:group.key==='acct:900'?14:8,matchingGames:group.key==='acct:900'?14:8,lastMeeting:rows[0].lastPlayed,streak:{kind:group.key==='acct:900'?'loss':'win',count:group.key==='acct:900'?3:2,atLeast:false},usualOpener:group.key==='acct:900'?{name:'Zerg - Pool pressure',samples:8,of:14}:null,pulse:group.key==='acct:900'?{change:{delta:-84,baselineAt:new Date(Date.now()-30*86400000).toISOString(),currentAt:new Date().toISOString()},fetchedAt:new Date().toISOString()}:null,live:group.key==='acct:900'?[{platform:'twitch',url:'https://www.twitch.tv/syntheticplayer',observedAt:new Date().toISOString()}]:[]}))})});
  }
  if(/^\/v1\/opponents\/[^/]+\/rival-key$/.test(url.pathname))return json(res,{keys:['acct:900','solo:p-0']});
  if(/^\/v1\/opponents\/[^/]+\/export.csv$/.test(url.pathname)){res.setHeader('content-type','text/csv;charset=utf-8');res.setHeader('content-disposition','attachment;filename="fixture.csv"');res.setHeader('X-Export-Truncated','true');return res.end('\uFEFFgameId,date\r\none,2026-10-25\r\n')}
  if(url.pathname.startsWith('/v1/'))return json(res,{error:{code:'unexpected_fixture_request'}},404);
  const file = url.pathname==='/fixture.js'?path.join(root,'.tmp/opponents-rivals-fixture.js'):path.join(root,'public',decodeURIComponent(url.pathname));
  if(url.pathname==='/fixture.js'||url.pathname.startsWith('/fonts/')||url.pathname.startsWith('/icons/')){if(fs.existsSync(file)&&fs.statSync(file).isFile()){res.setHeader('content-type',url.pathname.endsWith('.js')?'text/javascript;charset=utf-8':url.pathname.endsWith('.woff2')?'font/woff2':url.pathname.endsWith('.svg')?'image/svg+xml':'image/webp');return res.end(fs.readFileSync(file))}res.statusCode=404;return res.end()}
  res.setHeader('content-type','text/html;charset=utf-8');res.end('<!doctype html><html data-theme="'+(url.searchParams.get('theme')||'light')+'"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'\n'+fonts+'</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
});
(async()=>{
  await new Promise(resolve=>server.listen(3242,'127.0.0.1',resolve));const browser=await chromium.launch({headless:true});let checks=0;
  const fresh=async width=>{const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce',acceptDownloads:true});await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());return context};
  try{
    for(const width of [320,390,768,1440])for(const theme of ['light','dark']){
      prefs.set('owner-a',['acct:900','solo:p-2']);const context=await fresh(width),page=await context.newPage(),errors=[];page.on('pageerror',error=>{errors.push(error.message);console.log('LOCAL_FIXTURE_ERROR '+error.message)});
      await page.goto(origin+'/app/opponents?theme='+theme);await expect(page.getByRole('button',{name:'Export CSV',exact:true})).toBeEnabled();await expect(page.getByText('100 of 1,499 rows shown')).toBeVisible();checks++;
      await expect(page.getByRole('region',{name:'Rivalries'}).getByText('Hot rematch')).toBeVisible();checks++;
      if(width<768){await expect(page.getByRole('table')).toHaveCount(0);await expect(page.getByRole('list',{name:'Opponent history'}).getByRole('listitem')).toHaveCount(100);await expect(page.getByRole('combobox',{name:'Sort opponents'})).toBeVisible();checks++}
      else {await expect(page.getByRole('table',{name:'Opponent history'}).getByRole('row')).toHaveCount(101);checks++}
      await page.evaluate(()=>document.fonts.ready);await page.getByRole(width<768?'list':'table',{name:'Opponent history'}).evaluate(node=>node.scrollIntoView({block:'start'}));await page.screenshot({path:'../../docs/handoff/screenshots/opponents-list-'+theme+'-'+width+'.png'});checks++;
      await page.getByRole('button',{name:'Show 100 more',exact:true}).click();await expect(page.getByText('200 of 1,499 rows shown')).toBeVisible();checks++;
      const downloadEvent=page.waitForEvent('download');await page.getByRole('button',{name:'Export CSV',exact:true}).click();const download=await downloadEvent, text=fs.readFileSync(await download.path(),'utf8');expect(download.suggestedFilename()).toBe('sc2tools-opponents-all-time.csv');expect(text).toContain('Player 1499');expect(text.startsWith('\uFEFF')).toBe(true);checks++;
      await page.getByRole('button',{name:'Rivals (2)',exact:true}).click();const rivals=page.getByRole('region',{name:'Starred rivals'});await expect(rivals.getByRole('article')).toHaveCount(2);await expect(rivals.getByText('3 losses in a row').first()).toBeVisible();await expect(rivals.getByText('Pulse 30-day MMR: -84')).toBeVisible();await expect(rivals.getByRole('link',{name:'Live now',exact:true})).toBeVisible();checks++;
      await rivals.scrollIntoViewIfNeeded();await page.screenshot({path:'../../docs/handoff/screenshots/opponents-rivals-'+theme+'-'+width+'.png'});checks++;
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);checks++;
      await context.close();console.log(JSON.stringify({width,theme,checks}));
    }
    const context=await fresh(390),page=await context.newPage();await page.goto(origin+'/app/opponents?theme=light&mode=unmeasured');await expect(page.getByRole('button',{name:'Export CSV',exact:true})).toBeEnabled();await page.getByText('Columns',{exact:true}).click();await expect(page.getByRole('checkbox',{name:'Last MMR',exact:true})).not.toBeChecked();await page.getByRole('checkbox',{name:'Pulse ID',exact:true}).check();await page.reload();await page.getByText('Columns',{exact:true}).click();await expect(page.getByRole('checkbox',{name:'Pulse ID',exact:true})).toBeChecked();checks++;
    await page.getByText('Columns',{exact:true}).click();await page.getByRole('button',{name:'Reset',exact:true}).click();await page.getByRole('combobox',{name:'Sort opponents'}).selectOption('name');await page.reload();await expect(page.getByRole('combobox',{name:'Sort opponents'})).toHaveValue('name');checks++;
    await page.getByRole('button',{name:'Rivals (2)',exact:true}).click();const cards=page.getByRole('region',{name:'Starred rivals'});await cards.getByRole('button',{name:/Unstar Frost/}).click();await expect(page.getByRole('button',{name:'Rivals (1)',exact:true})).toBeVisible();expect(writes.at(-1).owner).toBe('owner-a');checks++;
    await page.evaluate(()=>{window.fixtureOwner='owner-b';dispatchEvent(new Event('fixture-auth'))});await expect(page.getByRole('button',{name:'Rivals (0)',exact:true})).toBeVisible();await expect(page.getByText('Star an opponent to keep them here.')).toBeVisible();checks++;
    await context.close();
    for(const mode of ['empty','error']){const c=await fresh(320),p=await c.newPage();await p.goto(origin+'/app/opponents?mode='+mode);await expect(mode==='empty'?p.getByText('No games synced yet'):p.getByRole('button',{name:/Retry|Try again/}).first()).toBeVisible();expect(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);checks++;await c.close()}
    const dossier=await fresh(390),p=await dossier.newPage();await p.goto(origin+'/app/opponents/p-0');await expect(p.getByRole('button',{name:'Unstar Saved rival'})).toBeVisible();const event=p.waitForEvent('download');await p.getByRole('button',{name:'Export CSV',exact:true}).click();await event;await expect(p.getByRole('status')).toContainText('first 5,000 matching games newest first');const exported=reads.filter(call=>call.path.endsWith('/export.csv')).at(-1),scope=new URLSearchParams(exported.query);expect(scope.get('analysisGameIds')).toBe('["one"]');expect(scope.get('result')).toBe('loss');checks++;await dossier.close();
    console.log(JSON.stringify({checks,reads:reads.length,syntheticPreferenceWrites:writes.length,nonlocalTraffic:'blocked'}));
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
})().catch(error=>{console.error(error);process.exitCode=1});
