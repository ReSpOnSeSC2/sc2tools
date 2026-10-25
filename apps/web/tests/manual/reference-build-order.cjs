/* Run after the required-engine production build. Every API write is local
 * disposable fixture data; browser external traffic is blocked. */
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{execFileSync}=require('node:child_process');
const{chromium,expect}=require('@playwright/test'),axe=require('axe-core');
const root=process.cwd(),shots='../../docs/handoff/screenshots',calls=[],unexpected=[],saved=new Map();
let origin,checks=0,captures=0,holdSaveBody=false,releaseSaveBody;
const css=fs.readdirSync('.next/static/css',{recursive:true}).filter(name=>name.endsWith('.css')).map(name=>fs.readFileSync(path.join('.next/static/css',name),'utf8')).join('\n');
const fonts=`@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay}`;
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,origin||'http://127.0.0.1'),p=url.pathname,json=(body,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body))};
 if(p.startsWith('/v1/')){
  const owner=String(req.headers.authorization||'').replace(/^Bearer /,'');const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):undefined;calls.push({path:p,method:req.method,owner,body});
  if(!['synthetic-a','synthetic-b'].includes(owner))return json({},401);
  if(p==='/v1/me/profile')return json({displayName:'Synthetic owner'});
  if(p==='/v1/custom-builds/preview-matches')return json({matches:[],almost_matches:[],scanned_games:12,truncated:false});
  if(p.startsWith('/v1/community/my-build-publication/'))return json({published:false,authorName:'Synthetic owner',publishAnonymously:false,mirrorPending:false});
  if(p.startsWith('/v1/custom-builds/')){const slug=decodeURIComponent(p.split('/').at(-1));if(req.method==='PUT'){saved.set(owner+':'+slug,{...body,slug});if(holdSaveBody){holdSaveBody=false;res.writeHead(200,{'Content-Type':'application/json'});res.write('{"saved":true,');await new Promise(resolve=>{releaseSaveBody=resolve});return res.end('"reclassify":null,"community":{"mirrorPending":true}}')}return json({saved:true,reclassify:null})}return json(saved.get(owner+':'+slug)||{},saved.has(owner+':'+slug)?200:404)}
  if(p==='/v1/replays')return json({items:[{gameId:'source-game',date:'2026-10-25T12:00:00Z',map:'Synthetic Sanctuary',myRace:'Protoss',result:'win',opponent:{displayName:'Synthetic opponent'}}],page:{hasMore:false,nextCursor:null}});
  if(p==='/v1/games/source-game/build-order')return json({game_id:'source-game',my_race:'Protoss',opp_race:'Zerg',events:[{time:5,name:'Probe',category:'unit',race:'Protoss',supply:13},{time:18,name:'Pylon',is_building:true,race:'Protoss',supply:14},{time:60,name:'Gateway',is_building:true,race:'Protoss',supply:16,supplyApprox:true}],opp_events:[]});
  unexpected.push({p,method:req.method});return json({},404);
 }
 if(p==='/fixture.js'){res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync('.tmp/reference-build-order-fixture.js'))}
 if(p==='/fixture'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(`<!doctype html><html lang="en" data-theme="${url.searchParams.get('theme')==='dark'?'dark':'light'}"><head><title>Local reference build-order proof</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`)}
 const base=p.startsWith('/fonts/')?path.join(root,'app/fonts'):path.join(root,'public'),file=path.resolve(base,p.startsWith('/fonts/')?p.slice(7):p.slice(1));
 if(!file.startsWith(base+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.statusCode=404;return res.end()}
 res.setHeader('Content-Type',({'.woff2':'font/woff2','.png':'image/png','.svg':'image/svg+xml','.webp':'image/webp'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
});
async function geometry(page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);checks++;const dialog=page.getByRole('dialog').first();if(await dialog.count()){expect(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);checks++}}
async function shot(page,name){if(process.env.REFERENCE_NO_SHOTS==='1')return;await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:`${shots}/reference-build-order-${name}.png`});captures++}
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
 execFileSync(process.execPath,['tests/manual/reference-build-order-fixture.cjs'],{cwd:root,env:{...process.env,REFERENCE_FIXTURE_ORIGIN:origin},stdio:'inherit'});fs.mkdirSync(shots,{recursive:true});const browser=await chromium.launch({headless:true});
 try{
  for(const width of [300,320,390,768,1440])for(const theme of ['light','dark']){
   const context=await browser.newContext({viewport:{width,height:1000},colorScheme:theme}),page=await context.newPage(),errors=[];
   page.on('pageerror',error=>errors.push(error.message));await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
   await page.goto(`${origin}/fixture?theme=${theme}`);await page.getByRole('button',{name:'Open pasted builder'}).click();
   await page.getByRole('textbox',{name:'Paste a build order'}).fill('14 - Future action\nbad row');await expect(page.getByText(/Line 2 · Fix/)).toBeVisible();await expect(page.getByRole('button',{name:'Use pasted order'})).toBeDisabled();checks+=2;
   await page.getByRole('textbox',{name:'Paste a build order'}).fill('14 - Future action\n13 0:18 Pylon\n2:00 Gateway\n6:10 Stargate');await expect(page.getByRole('button',{name:'Use pasted order'})).toBeEnabled();await geometry(page);await shot(page,`paste-${theme}-${width}`);
   await page.getByRole('button',{name:'Use pasted order'}).click();await expect(page.getByRole('tab',{name:'Build order'})).toHaveAttribute('aria-selected','true');await expect(page.getByRole('button',{name:'Save build',exact:true})).toBeEnabled();await expect(page.getByRole('button',{name:'Save & re-match'})).toBeDisabled();checks+=3;
   await page.getByRole('textbox',{name:/^Name/}).fill(`Reference ${theme} ${width}`);
   await page.getByRole('textbox',{name:'Step 1 time'}).fill('7:99');await expect(page.getByRole('button',{name:'Save build',exact:true})).toBeDisabled();checks++;await page.getByRole('textbox',{name:'Step 1 time'}).fill('');
   await page.getByRole('button',{name:'Move step 3 up'}).click();await expect(page.getByRole('textbox',{name:'Step 2 time'})).toHaveValue('2:00');checks++;
   await page.getByRole('textbox',{name:'Step 2 note'}).fill('Shared instruction | keep workers safe');
   await page.getByRole('button',{name:'Trim to first 5:00'}).click();await expect(page.getByRole('combobox',{name:'Step 4 action'})).toHaveCount(0);await expect(page.getByRole('textbox',{name:'Step 1 time'})).toHaveValue('');checks+=2;
   const action=page.getByRole('combobox',{name:'Step 2 action'});await action.fill('Stargate');await action.press('ArrowDown');await action.press('Enter');await expect(action).toHaveValue('Stargate');checks++;
   await geometry(page);await shot(page,`editor-${theme}-${width}`);
   if((width===300&&theme==='light')||(width===768&&theme==='dark')){await page.getByRole('tab',{name:'Build order'}).scrollIntoViewIfNeeded();await geometry(page);await shot(page,`editor-top-${theme}-${width}`)}
   await page.addScriptTag({content:axe.source});const violations=await page.getByRole('dialog').evaluate(async node=>(await window.axe.run(node,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}})).violations.map(item=>({id:item.id,targets:item.nodes.map(row=>row.target)})));expect(violations).toEqual([]);checks++;
   await page.getByRole('button',{name:'Save build',exact:true}).click();await expect(page.getByRole('region',{name:'Reference build order'})).toBeVisible();await expect(page.getByRole('dialog')).toHaveCount(0);checks+=2;
   const write=calls.filter(call=>call.method==='PUT').at(-1);expect(write.body.rules).toEqual([]);expect(write.body.reclassify).toBe(false);expect(write.body.buildOrder.steps[0].t).toBe(null);expect(write.body.buildOrder.steps).toHaveLength(3);checks+=4;
   await page.getByLabel(`Build actions for Reference ${theme} ${width}`).click();await page.getByRole('button',{name:'Copy Markdown'}).click();const fallback=page.getByRole('textbox',{name:'Copy this build order'});await expect(fallback).toBeVisible();await expect(fallback).toBeFocused();expect(await fallback.inputValue()).toContain('| — | 14 | Future action');expect(await fallback.inputValue()).toContain('Shared instruction \\| keep workers safe');checks+=4;
   await geometry(page);await shot(page,`export-${theme}-${width}`);await page.getByRole('button',{name:'Done',exact:true}).click();await page.getByLabel(`Build actions for Reference ${theme} ${width}`).click();const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download .txt'}).click();expect((await download).suggestedFilename()).toMatch(/\.txt$/);checks++;
   while(await page.getByRole('button',{name:'Dismiss notification'}).count()){await page.getByRole('button',{name:'Dismiss notification'}).first().click();checks++}
   await page.getByRole('button',{name:'Open game builder'}).click();await page.getByRole('button',{name:/Synthetic Sanctuary/}).click();await page.getByRole('tab',{name:'Build order'}).click();await expect(page.getByRole('combobox',{name:'Step 3 action'})).toHaveCount(0);await expect(page.getByRole('textbox',{name:'Step 1 time'})).toHaveValue('0:18');await expect(page.getByText('≈ Supply is approximate, taken from a prior recorded sample.')).toBeVisible();checks+=3;
   await geometry(page);await shot(page,`source-${theme}-${width}`);
   await page.evaluate(()=>window.fixtureAuth('synthetic-b'));await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByRole('region',{name:'Reference build order'})).toHaveCount(0);expect(errors).toEqual([]);checks+=3;await context.close();
  }
  const context=await browser.newContext({viewport:{width:320,height:1000}}),page=await context.newPage();await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());await page.goto(`${origin}/fixture`);
  const openReference=async name=>{await page.getByRole('button',{name:'Open pasted builder'}).click();await page.getByRole('textbox',{name:'Paste a build order'}).fill('14 - Future action');await page.getByRole('button',{name:'Use pasted order'}).click();await page.getByRole('textbox',{name:/^Name/}).fill(name)};
  await openReference('Held JWT');const beforeToken=calls.filter(call=>call.method==='PUT').length;await page.evaluate(()=>window.fixtureHoldToken());await page.getByRole('button',{name:'Save build',exact:true}).click();await page.evaluate(()=>{window.fixtureAuth('synthetic-b');window.fixtureReleaseToken()});await expect(page.getByRole('dialog')).toHaveCount(0);await page.waitForTimeout(75);expect(calls.filter(call=>call.method==='PUT')).toHaveLength(beforeToken);checks+=2;
  await page.evaluate(()=>window.fixtureAuth('synthetic-a'));await openReference('Held response body');const beforeRepair=calls.filter(call=>call.path.includes('/my-build-publication/')).length;holdSaveBody=true;await page.getByRole('button',{name:'Save build',exact:true}).click();await expect.poll(()=>Boolean(releaseSaveBody)).toBe(true);await page.evaluate(()=>window.fixtureAuth('synthetic-b'));releaseSaveBody();await page.waitForTimeout(75);await expect(page.getByRole('region',{name:'Reference build order'})).toHaveCount(0);expect(calls.filter(call=>call.path.includes('/my-build-publication/'))).toHaveLength(beforeRepair);await expect(page.getByText(/^Saved "Held response body"/)).toHaveCount(0);checks+=3;await context.close();
  expect(unexpected).toEqual([]);expect(calls.filter(call=>call.method==='PUT')).toHaveLength(11);checks+=2;
  console.log(JSON.stringify({result:'PASS',checks,captures,requests:calls.length,externalRequests:0}));
 }finally{releaseSaveBody?.();await browser.close();server.closeAllConnections();server.close()}
})().catch(error=>{console.error(error);process.exitCode=1;releaseSaveBody?.();server.closeAllConnections();server.close()});
