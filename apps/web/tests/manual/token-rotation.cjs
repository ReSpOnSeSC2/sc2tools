/* Real SettingsOverlay/URL consumers with production CSS/fonts. All mutations
 * target a loopback synthetic fixture; nonlocal traffic is blocked. */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const {execFileSync} = require('node:child_process'), {chromium, expect} = require('@playwright/test');
execFileSync(process.execPath, ['tests/manual/token-rotation-fixture.cjs'], {stdio:'inherit'});
const origin = 'http://127.0.0.1:3248', writes = [], unexpected = [];
const item = (token,label) => ({token,label,createdAt:'2026-10-25T00:00:00Z',revokedAt:null,enabledWidgets:['opponent','session'],profile:{v:1,theme:{},widgetOptions:{}},profileRevision:0});
let tokens = [], reserved = 'synthetic-test-replacement';
const css = fs.readdirSync('.next/static/css',{recursive:true}).filter(name=>name.endsWith('.css')).map(name=>fs.readFileSync(path.join('.next/static/css',name),'utf8')).join('\n');
const fonts = "@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay;--font-serif:serif}";
const server = http.createServer(async(req,res)=>{
 const url = new URL(req.url,origin), p = url.pathname;
 const json = (data,status=200)=>{res.statusCode=status;res.setHeader('content-type','application/json');res.end(JSON.stringify(data))};
 if(p.startsWith('/v1/')){
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=chunks.length?JSON.parse(Buffer.concat(chunks)):null;
  if(req.method!=='GET')writes.push({path:p,method:req.method,body});
  if(p==='/v1/overlay-tokens'&&req.method==='GET')return json({items:tokens});
  const token = decodeURIComponent(p.split('/')[3]||''), row = tokens.find(t=>t.token===token);
  if(row&&req.method==='PATCH'&&p===`/v1/overlay-tokens/${token}`){row.label=body.label;return json({label:row.label})}
  if(row&&req.method==='POST'&&p.endsWith('/rotate')){
   if(!row.rotationPending){row.rotationPending=true;return json({pending:true},202)}
   row.rotationPending=false;row.revokedAt='2026-10-25T00:01:00Z';row.replacedBy=reserved;tokens.unshift({...row,token:reserved,revokedAt:null,replacedBy:undefined,rotationPending:false});return json({pending:false,token:reserved});
  }
  if(req.method!=='GET'){unexpected.push({path:p,method:req.method});return json({error:{code:'unexpected_synthetic_write'}},405)}
  if(p==='/v1/seasons')return json({items:[],current:null,source:'fallback',fetchedAt:null});
  if(p==='/v1/site/banner')return json({banner:null});
  if(p==='/v1/ping')return json({ok:true});
  if(p==='/v1/me')return json({userId:'synthetic-local-fixture',isAdmin:false,games:{total:14}});
  if(p==='/v1/me/profile')return json({displayName:'Fixture player'});
  if(p==='/v1/devices/obs')return json({devices:[]});
  if(p==='/v1/me/chatbot')return json({enabled:false,username:'',channel:'',hasToken:false,status:{state:'off'}});
  if(p==='/v1/me/preferences/multichat')return json({twitch:{enabled:false}});
  if(p==='/v1/me/integrations')return json({platforms:[]});
  if(p==='/v1/coaching/me')return json({role:'none'});
  if(p==='/v1/coaching/alerts')return json({pending:0,items:[]});
  if(p.endsWith('/unread-count'))return json({count:0});
  return json({});
 }
 if(p==='/api/site/stats')return json({agentDownloads:42,activeAgents:0,activeUsers:1,generatedAt:new Date().toISOString(),activityWindowSeconds:60});
 if(p==='/fixture.js'){res.setHeader('content-type','text/javascript');return res.end(fs.readFileSync('.tmp/token-rotation-fixture.js'))}
 if(p.startsWith('/fonts/')){res.setHeader('content-type','font/woff2');return res.end(fs.readFileSync(path.join('app',p)))}
 if(p==='/settings'){res.setHeader('content-type','text/html;charset=utf-8');return res.end(`<!doctype html><html data-theme="${url.searchParams.get('theme')==='dark'?'dark':'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`)}
 const assetRoot=path.resolve('public'), asset=path.resolve(assetRoot,'.'+p);
 if(asset.startsWith(assetRoot+path.sep)&&fs.existsSync(asset)&&fs.statSync(asset).isFile()){res.setHeader('content-type',({'.webp':'image/webp','.png':'image/png','.svg':'image/svg+xml'})[path.extname(asset)]||'application/octet-stream');return res.end(fs.readFileSync(asset))}
 res.statusCode=404;res.end();
});
(async()=>{
 await new Promise(resolve=>server.listen(3248,'127.0.0.1',resolve));const browser=await chromium.launch({headless:true});let checks=0;
 try{
  for(const width of [375,1440])for(const theme of ['light','dark']){
   tokens=[item('synthetic-live','Live'),item('synthetic-test','Test')];
   const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'});await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
   const page=await context.newPage(), errors=[];page.on('pageerror',error=>errors.push(error.message));
   await page.goto(`${origin}/settings?tab=overlay&section=tokens&theme=${theme}`);
   const selector=page.getByRole('combobox',{name:'URLs shown for'});await expect(selector).toHaveValue('synthetic-live');await selector.selectOption('synthetic-test');await expect(page.getByRole('textbox',{name:'Token label'})).toHaveValue('Test');checks+=2;
   await page.getByRole('textbox',{name:'Token label'}).fill('Tournament');await page.getByRole('button',{name:'Save label',exact:true}).click();await expect(page.getByText('Token renamed.',{exact:true})).toBeVisible();checks++;
   await page.getByRole('button',{name:'Rotate',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('Viewer XP, oracle scores, predictions and clip moments');await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:`../../docs/handoff/screenshots/token-rotation-checklist-${theme}-${width}.png`});checks++;
   expect(await page.getByRole('dialog').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);await page.getByRole('button',{name:'Rotate and preserve data',exact:true}).click();await expect(page.getByRole('button',{name:'Continue rotation',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Revoke',exact:true})).toBeDisabled();checks+=3;
   await page.getByRole('button',{name:'Continue rotation',exact:true}).click();await expect(page.getByRole('combobox',{name:'URLs shown for'})).toHaveValue(reserved);checks++;
   await page.getByRole('navigation',{name:'Overlay settings sections'}).getByRole('link',{name:'Widgets',exact:true}).click();await page.getByRole('button',{name:'Reveal',exact:true}).first().click();await expect(page.locator('code').first()).toContainText(`/overlay/${reserved}`);checks++;
   await page.getByRole('navigation',{name:'Overlay settings sections'}).getByRole('link',{name:'Setup',exact:true}).click();const dock=page.locator('section').filter({has:page.getByRole('heading',{name:'Add Stream Dock to OBS',exact:true})});await dock.getByRole('button',{name:'Reveal',exact:true}).click();await expect(dock.locator('code')).toContainText(`/dock/${reserved}`);checks++;
   await dock.getByRole('button',{name:'Hide URL',exact:true}).click();await page.getByRole('combobox',{name:'URLs shown for'}).selectOption('synthetic-live');await dock.getByRole('button',{name:'Reveal',exact:true}).click();await expect(dock.locator('code')).toContainText('/dock/synthetic-live');checks++;
   await dock.getByRole('button',{name:'Hide URL',exact:true}).click();await page.getByRole('navigation',{name:'Overlay settings sections'}).getByRole('link',{name:'Tokens',exact:true}).click();await page.getByRole('combobox',{name:'URLs shown for'}).scrollIntoViewIfNeeded();await page.screenshot({path:`../../docs/handoff/screenshots/token-rotation-selector-${theme}-${width}.png`});
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);expect(await page.locator('img[src="/logo-64.webp"]').evaluateAll(nodes=>nodes.length>0&&nodes.every(node=>node.complete&&node.naturalWidth>0))).toBe(true);checks+=3;
   const before=writes.length;await page.evaluate(()=>{window.fixtureHeldToken=new Promise(resolve=>{window.releaseHeldToken=resolve})});await page.getByRole('textbox',{name:'Token label'}).fill('Held prior-owner draft');await page.getByRole('button',{name:'Save label',exact:true}).click();await page.evaluate(()=>window.fixtureAuth(null,false));await expect(page.getByRole('combobox',{name:'URLs shown for'})).toHaveCount(0);await page.evaluate(()=>window.releaseHeldToken('synthetic-old-session'));await page.waitForTimeout(100);expect(writes).toHaveLength(before);checks+=2;
   await context.close();console.log(JSON.stringify({width,theme,checks}));
  }
  expect(unexpected).toEqual([]);console.log(JSON.stringify({checks,syntheticLocalWrites:writes.length,nonlocalTraffic:'blocked'}));
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
})().catch(error=>{console.error(error);process.exitCode=1});
