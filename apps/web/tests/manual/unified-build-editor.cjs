/* Run in apps/web after npm run build. All writes target this disposable
 * loopback API. No provider, production, authentication or replay traffic. */
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {execFileSync}=require('node:child_process'),{chromium,expect}=require('@playwright/test'),axe=require('axe-core');
const root=process.cwd(),shots='../../docs/handoff/screenshots',calls=[],unexpected=[],saved=new Map();
let origin,checks=0,captures=0,holdDetail=false,releaseDetail,malformedList=false,holdSave=false,releaseSave;
const legacy={slug:'legacy',name:'Legacy opener',race:'Protoss',vsRace:'Zerg',signature:[{unit:'Gateway',count:2,beforeSec:100,proxy:true}],notes:'Preserve private notes'};
const css=fs.readdirSync('.next/static/css',{recursive:true}).filter(name=>name.endsWith('.css')).map(name=>fs.readFileSync(path.join('.next/static/css',name),'utf8')).join('\n');
const fonts=`@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay}`;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,origin||'http://127.0.0.1'),p=url.pathname,json=(body,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body))};
  if(p.startsWith('/v1/')){
    const owner=String(req.headers.authorization||'').replace(/^Bearer /,'');const parts=[];for await(const chunk of req)parts.push(chunk);const body=parts.length?JSON.parse(Buffer.concat(parts).toString()):undefined;calls.push({path:p,query:url.search,method:req.method,owner,body});
    if(!['synthetic-a','synthetic-b'].includes(owner))return json({},401);
    if(p==='/v1/me/profile')return json({displayName:'Synthetic owner'});
    if(p==='/v1/custom-builds/reclassify-status')return json({status:'idle'});
    if(p==='/v1/custom-builds/stats')return json([]);
    if(p==='/v1/custom-builds/preview-matches')return json({matches:[],almost_matches:[],scanned_games:24,truncated:false});
    if(p==='/v1/custom-builds')return json({items:[...saved.entries()].filter(([key])=>key.startsWith(owner+':')).map(([,value])=>value),total:0,libraryTotal:saved.size,limit:50});
    if(p.startsWith('/v1/community/my-build-publication/'))return json({published:false,authorName:'Synthetic owner',publishAnonymously:false,mirrorPending:false});
    if(p.startsWith('/v1/custom-builds/')){const slug=decodeURIComponent(p.split('/').at(-1));if(req.method==='PUT'){if(holdSave){holdSave=false;await new Promise(resolve=>{releaseSave=resolve})}saved.set(owner+':'+slug,{...body,slug});return json({saved:true,reclassify:null})}return json(saved.get(owner+':'+slug)||legacy)}
    if(p==='/v1/replays'){
      if(malformedList){malformedList=false;return json({items:'older incompatible shape'})}
      const race=url.searchParams.get('race')||'P',next=url.searchParams.has('cursor'),label=url.searchParams.get('build');
      return json({items:[{gameId:`game-${race}-${next?2:1}`,date:'2026-10-25T15:00:00Z',map:next?'Second map':'Synthetic Sanctuary with a long map name',result:'win',myRace:{P:'Protoss',T:'Terran',Z:'Zerg'}[race]||'Random',myBuild:label||'Recorded opener',opponent:{displayName:'Synthetic opponent with a long name'}}],page:{hasMore:!next,nextCursor:next?null:'cursor-2'}});
    }
    if(/^\/v1\/games\/[^/]+\/build-order$/.test(p)){
      if(holdDetail){holdDetail=false;await new Promise(resolve=>{releaseDetail=resolve})}
      const id=decodeURIComponent(p.split('/')[3]),letter=id.split('-')[1],race={P:'Protoss',T:'Terran',Z:'Zerg'}[letter]||'Protoss',name={Protoss:'Gateway',Terran:'Barracks',Zerg:'SpawningPool'}[race];
      return json({ok:true,game_id:id,my_race:race,opp_race:'Zerg',events:[{time:60,name,is_building:true,is_proxy:true},{time:150,name:{Protoss:'Stargate',Terran:'Factory',Zerg:'RoachWarren'}[race],is_building:true}],opp_events:[]});
    }
    unexpected.push({p,method:req.method});return json({},404);
  }
  if(p==='/fixture.js'){res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync('.tmp/unified-build-editor-fixture.js'))}
  if(['/fixture','/builds','/definitions','/community'].includes(p)){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(`<!doctype html><html lang="en" data-theme="${url.searchParams.get('theme')==='dark'?'dark':'light'}"><head><title>Local unified editor proof</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`)}
  const base=p.startsWith('/fonts/')?path.join(root,'app/fonts'):path.join(root,'public'),file=path.resolve(base,p.startsWith('/fonts/')?p.slice(7):p.slice(1));
  if(!file.startsWith(base+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.statusCode=404;return res.end()}
  res.setHeader('Content-Type',({'.woff2':'font/woff2','.png':'image/png','.svg':'image/svg+xml','.webp':'image/webp'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
});
async function shot(page,name){await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:`${shots}/unified-build-editor-${name}.png`});captures++}
async function geometry(page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);checks++;const dialog=page.getByRole('dialog').first();if(await dialog.count()){expect(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);checks++}}
async function chooseToken(page,token){const input=page.getByRole('combobox',{name:'Rule 1 action'});await input.fill(token);await input.press('ArrowDown');await input.press('Enter');expect(await input.getAttribute('aria-invalid')).toBeNull();checks++;return input}
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
  execFileSync(process.execPath,['tests/manual/unified-build-editor-fixture.cjs'],{cwd:root,env:{...process.env,BUILD_EDITOR_FIXTURE_ORIGIN:origin},stdio:'inherit'});
  fs.mkdirSync(shots,{recursive:true});const browser=await chromium.launch({headless:true});
  try{
    for(const width of [300,320,390,768,1440])for(const theme of ['light','dark']){
      saved.clear();const context=await browser.newContext({viewport:{width,height:960},colorScheme:theme}),page=await context.newPage(),errors=[];
      context.on('page',child=>child.on('pageerror',error=>errors.push(error.message)));page.on('pageerror',error=>errors.push(error.message));
      await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
      await page.goto(`${origin}/builds?theme=${theme}`);await expect(page.getByRole('heading',{name:'No custom builds yet'})).toBeVisible();
      await expect(page.getByRole('button',{name:/From a pasted/})).toBeDisabled();await expect(page.getByRole('link',{name:/Copy a Community build/})).toHaveAttribute('href','/community');checks+=3;
      await geometry(page);await shot(page,`library-${theme}-${width}`);
      await page.getByRole('button',{name:'New build',exact:true}).click();await expect(page.getByRole('dialog',{name:'Start a new build'})).toBeVisible();checks++;await shot(page,`chooser-${theme}-${width}`);
      await page.addScriptTag({content:axe.source});const violations=await page.getByRole('dialog').evaluate(async node=>(await window.axe.run(node,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}})).violations.map(item=>({id:item.id,nodes:item.nodes.map(row=>row.target)})));expect(violations).toEqual([]);checks++;
      await page.getByRole('dialog',{name:'Start a new build'}).getByRole('button',{name:/Blank build/}).click();await page.getByRole('textbox',{name:/^Name/}).fill(`Private ${theme} ${width}`);
      await page.getByRole('button',{name:'At least',exact:true}).click();let input=page.getByRole('combobox',{name:'Rule 1 action'});await expect(input).toBeFocused();checks++;
      await input.fill('not-a-known-action');await expect(input).toHaveAttribute('aria-invalid','true');await expect(page.getByRole('button',{name:'Save build',exact:true})).toBeDisabled();checks+=2;
      await input.fill('Gateway');await input.press('ArrowDown');await expect(page.getByRole('listbox')).toBeVisible();
      expect(await page.getByRole('listbox').evaluate(node=>!!node.closest('[role=dialog]'))).toBe(true);checks++;
      const option=page.getByRole('option',{name:/^Gateway /}).first();const box=await option.boundingBox();expect(box.height).toBeGreaterThanOrEqual(44);
      expect(await option.evaluate(node=>{const b=node.getBoundingClientRect();return node.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))})).toBe(true);checks+=2;
      await geometry(page);await shot(page,`picker-${theme}-${width}`);
      await input.press('Escape');await expect(page.getByRole('listbox')).toHaveCount(0);await expect(page.getByRole('dialog')).toHaveCount(1);checks+=2;
      await chooseToken(page,'BuildGateway');await expect(page.getByRole('button',{name:'Save build',exact:true})).toBeEnabled();checks++;
      await page.getByText('How rules count',{exact:true}).click();await expect(page.getByRole('link',{name:'How build rules are counted'})).toHaveAttribute('href','/help/rules-explained');checks++;
      if(width===300&&theme==='dark'){
        holdSave=true;await input.focus();await expect(page.getByRole('listbox')).toBeVisible();
        await page.getByRole('button',{name:'Save build',exact:true}).evaluate(node=>node.click());await expect.poll(()=>typeof releaseSave).toBe('function');
        await expect(input).toBeDisabled();await expect(page.getByRole('listbox')).toHaveCount(0);checks+=2;releaseSave();releaseSave=undefined;
      }else await page.getByRole('button',{name:'Save build',exact:true}).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);checks++;
      const put=calls.filter(call=>call.method==='PUT').at(-1);expect(put.body).toMatchObject({createOnly:true,rules:[{name:'BuildGateway'}],shareWithCommunity:false});checks++;
      const notification=page.getByRole('button',{name:'Dismiss notification'});if(await notification.count())await notification.first().click();
      await page.getByRole('button',{name:'New build',exact:true}).click();await page.getByRole('button',{name:/From one of my games/}).click();
      await expect(page.getByRole('button',{name:/Use build order/})).toBeVisible();await geometry(page);await shot(page,`games-${theme}-${width}`);
      const before=calls.filter(call=>call.path.includes('/build-order')).length;
      await page.getByRole('button',{name:'Next replays'}).click();await expect(page.getByRole('button',{name:/Second map/})).toBeVisible();expect(calls.filter(call=>call.path.includes('/build-order'))).toHaveLength(before);checks++;
      await page.getByRole('button',{name:/Use build order/}).click();await expect(page.getByRole('button',{name:/Add rule:/}).first()).toBeVisible();
      expect(calls.filter(call=>call.path.includes('/build-order'))).toHaveLength(before+1);checks++;await page.getByRole('button',{name:/Add rule:/}).first().click();await expect(page.getByRole('combobox',{name:'Rule 1 action'})).toHaveValue('Gateway');checks++;
      await page.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByRole('button',{name:'Keep editing'})).toBeFocused();await page.getByRole('button',{name:'Keep editing'}).press('Escape');await expect(page.getByRole('dialog')).toHaveCount(1);checks+=2;
      await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.getByRole('button',{name:'Discard',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);checks++;
      if(width===300&&theme==='dark'){
        await page.getByRole('button',{name:'New build',exact:true}).click();malformedList=true;await page.getByRole('dialog').getByRole('button',{name:/From one of my games/}).click();await expect(page.getByRole('alert')).toContainText('unexpected response');checks++;
        await shot(page,'retry-dark-300');await page.getByRole('button',{name:'Retry',exact:true}).click();await expect(page.getByRole('button',{name:/Use build order/})).toBeVisible();checks++;
        holdDetail=true;releaseDetail=undefined;await page.getByRole('button',{name:/Use build order/}).click();await expect.poll(()=>typeof releaseDetail).toBe('function');
        await page.getByRole('combobox',{name:'Your race'}).selectOption('Zerg');await page.getByRole('combobox',{name:'Your race'}).selectOption('Protoss');releaseDetail();releaseDetail=undefined;
        await expect(page.getByRole('dialog',{name:'Choose one of your games'})).toBeVisible();await expect(page.getByRole('button',{name:/Use build order/})).toBeVisible();checks+=2;
        holdDetail=true;await page.getByRole('button',{name:/Use build order/}).click();await expect.poll(()=>typeof releaseDetail).toBe('function');
        await page.evaluate(()=>window.fixtureAuth('synthetic-b'));await page.evaluate(()=>window.fixtureAuth('synthetic-a'));releaseDetail();releaseDetail=undefined;
        await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByRole('button',{name:'New build',exact:true})).toBeVisible();checks+=2;
      }
      if(width===300&&theme==='light'){
        await page.goto(`${origin}/definitions?theme=${theme}`);const variant=page.getByRole('link',{name:'Make my own variant of PvZ - Stargate into Glaives'});await variant.click();await expect(page.getByRole('dialog',{name:'Start from a detected build'})).toBeVisible();await expect(page.getByRole('combobox',{name:'Detected build'})).toHaveValue('PvZ - Stargate into Glaives');checks+=2;
        await page.getByRole('button',{name:/Use build order/}).click();await expect(page.getByRole('textbox',{name:/^Name/})).toHaveValue('PvZ - Stargate into Glaives');await shot(page,'variant-light-300');checks++;
        await page.evaluate(()=>window.fixtureAuth('synthetic-b'));await expect(page.getByRole('dialog')).toHaveCount(0);checks++;
        await page.goto(`${origin}/fixture?view=edit&theme=light`);await expect(page.getByRole('textbox',{name:'Personal notes (private)'})).toHaveValue('Preserve private notes');await expect(page.getByRole('note')).toContainText('older signature format');await shot(page,'legacy-light-300');checks+=2;
        await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect.poll(()=>calls.filter(call=>call.method==='PUT').at(-1)?.path).toBe('/v1/custom-builds/legacy');const edit=calls.filter(call=>call.method==='PUT').at(-1);expect(edit.body).not.toHaveProperty('signature');expect(edit.body.notes).toBe('Preserve private notes');checks+=3;
        await page.goto(`${origin}/fixture?view=save&theme=light`);await page.getByRole('button',{name:'Save as new build',exact:true}).click();await expect(page.getByRole('textbox',{name:/^Name/})).toHaveValue('Direct replay opener');checks++;await shot(page,'direct-light-300');
      }
      expect(errors).toEqual([]);checks++;await context.close();console.log(JSON.stringify({width,theme,checks,captures}));
    }
    expect(unexpected).toEqual([]);expect(calls.filter(call=>call.path.endsWith('/preview-matches')).every(call=>call.body.rules.every(rule=>rule.name!=='not-a-known-action'))).toBe(true);checks+=2;
    console.log(JSON.stringify({result:'PASS',checks,captures,requests:calls.length}));
  }finally{releaseDetail?.();releaseSave?.();await browser.close();server.closeAllConnections();server.close()}
})().catch(error=>{console.error(error);process.exitCode=1;releaseDetail?.();releaseSave?.();server.closeAllConnections();server.close()});
