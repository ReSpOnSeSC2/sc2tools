/* Run from apps/web after the production build. All API/auth data is synthetic,
 * provider traffic is blocked, and real Socket.IO carries the actual consumers. */
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {execFileSync}=require('node:child_process'),{chromium,expect}=require('@playwright/test'),axe=require('axe-core');
const {Server}=require(path.resolve('../api/node_modules/socket.io'));
const {sanitizeChatAlerts}=require(path.resolve('../api/src/services/multichatAppearance'));
const rules=require(path.resolve('../api/src/config/gameMomentRules.json'));
const root=process.cwd(),shots='../../docs/handoff/screenshots',prefs=new Map(),clips=new Map(),calls=[],unexpected=[],connections=[];
const tokens=['synthetic-a','synthetic-b'];let origin,io,checks=0,captures=0,holdSave=false,releaseSave=null;
function reset(){for(const token of tokens){prefs.set(token,{alerts:{durationSec:3},sound:{eventSoundsEnabled:true,eventVolume:0.6}});clips.set(token,[])}}
reset();
const studio={gameWidgetsPaused:false,updatedAt:new Date().toISOString()};
const emit=(token,event,value)=>io.to(`overlay:${token}`).emit(event,value);
function moment(token,kind,id,atMs=Date.now()){
  const rule=rules.kinds.find(row=>row.id===kind),event={kind,gameId:id,atMs,headline:rule.label,detail:'Synthetic recorded ladder evidence · exact account and race.'};
  const clip={atMs,kind:'game-event',reason:`${event.headline} — ${event.detail}`,sampleLines:[],gameKey:id};clips.get(token).unshift(clip);
  emit(token,'overlay:engagement',{type:'clip-moment',moment:clip});emit(token,'overlay:moment',event);return event;
}
const css=fs.readdirSync('.next/static/css',{recursive:true}).filter(name=>name.endsWith('.css')).map(name=>fs.readFileSync(path.join('.next/static/css',name),'utf8')).join('\n');
const fonts=`@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay}`;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,origin||'http://127.0.0.1'),p=url.pathname;
  const json=(body,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body))};
  if(p.startsWith('/v1/')){
    const owner=String(req.headers.authorization||'').replace(/^Bearer /,''),token=p.split('/')[3];calls.push({path:p,method:req.method,owner});
    if(p==='/v1/me/preferences/multichat'){
      if(!tokens.includes(owner))return json({},401);
      if(req.method==='PUT'){
        const parts=[];for await(const chunk of req)parts.push(chunk);const body=JSON.parse(Buffer.concat(parts).toString());
        body.alerts=sanitizeChatAlerts(body.alerts);calls.at(-1).body=body;prefs.set(owner,body);
        if(holdSave){holdSave=false;await new Promise(resolve=>{releaseSave=resolve})}return json(body);
      }return json(prefs.get(owner));
    }
    if(p==='/v1/me')return json({isAdmin:false});
    if(p==='/v1/me/integrations')return json({platforms:[]});
    if(tokens.includes(token)){
      if(p.endsWith('/config'))return json({config:prefs.get(token)});
      if(p.endsWith('/studio'))return json(studio);
      if(p.endsWith('/engagement'))return json({wall:[],oracles:[],prediction:null,clipMoments:clips.get(token),oracleRecap:{calls:0,majorityRight:0,last:null}});
      if(p.endsWith('/ingest')&&req.method==='POST')return json({ok:true});
    }
    unexpected.push({path:p,method:req.method});return json({},404);
  }
  if(p==='/fixture.js'){res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync('.tmp/game-moment-alerts-fixture.js'))}
  if(p==='/fixture'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(`<!doctype html><html lang="en" data-theme="${url.searchParams.get('theme')==='dark'?'dark':'light'}"><head><title>Local game moment proof</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${fs.existsSync('.tmp/game-moment-alerts-fixture.css')?fs.readFileSync('.tmp/game-moment-alerts-fixture.css','utf8'):''}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`)}
  const base=p.startsWith('/fonts/')?path.join(root,'app/fonts'):path.join(root,'public'),file=path.resolve(base,p.startsWith('/fonts/')?p.slice(7):p.slice(1));
  if(!file.startsWith(base+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.statusCode=404;return res.end()}
  res.setHeader('Content-Type',({'.woff2':'font/woff2','.png':'image/png','.svg':'image/svg+xml','.webp':'image/webp','.mp3':'audio/mpeg'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
});
io=new Server(server,{transports:['websocket','polling']});io.use((socket,next)=>next(tokens.includes(socket.handshake.auth.overlayToken)?undefined:new Error('invalid_overlay_token')));
function snapshot(socket){socket.emit('overlay:config',{enabledWidgets:['chat-alerts']});socket.emit('overlay:multichat',studio)}
io.on('connection',socket=>{const token=socket.handshake.auth.overlayToken;connections.push({token,surface:socket.handshake.auth.surface,widget:socket.handshake.auth.widget});socket.join(`overlay:${token}`);snapshot(socket);socket.on('overlay:resync',()=>snapshot(socket));socket.on('overlay:heartbeat',()=>socket.emit('overlay:heartbeat',{gameKey:null}))});
async function shot(page,name){await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:`${shots}/game-moment-alerts-${name}.png`});captures++}
async function noOverflow(page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);checks++}
async function visible(page,label){await expect(page.getByText(label,{exact:true}).first()).toBeVisible();checks++}
async function send(page,kind,id){return moment(tokens[0],kind,id,await page.evaluate(()=>Date.now()))}
(async()=>{
  fs.mkdirSync(shots,{recursive:true});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
  execFileSync(process.execPath,['tests/manual/game-moment-alerts-fixture.cjs'],{stdio:'inherit',env:{...process.env,MOMENT_FIXTURE_ORIGIN:origin}});
  const browser=await chromium.launch({headless:true});
  try{
    for(const width of [300,320,390,768,1440])for(const theme of ['light','dark']){
      reset();const context=await browser.newContext({viewport:{width,height:950},reducedMotion:'reduce',hasTouch:width<1000,isMobile:width<1000});
      await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
      const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.goto(`${origin}/fixture?theme=${theme}`);const summary=page.locator('summary').filter({hasText:/^Game moments/});await expect(summary).toBeVisible();
      await summary.click();const panel=summary.locator('..');
      await expect(panel.getByText('Ladder · 0 of 9 on',{exact:true})).toBeVisible();await noOverflow(page);checks++;
      const before=calls.filter(call=>call.method==='PUT').length;
      await panel.getByRole('button',{name:'Test Five or ten wins',exact:true}).click();await visible(page,'TEST · Local preview');
      expect(calls.filter(call=>call.method==='PUT')).toHaveLength(before);checks++;
      expect(await panel.locator('.ca-kind').evaluate(node=>node.scrollWidth<=Math.ceil(node.getBoundingClientRect().width))).toBe(true);checks++;
      if(width===300||width===1440){await panel.getByText('TEST · Local preview',{exact:true}).scrollIntoViewIfNeeded();await shot(page,`preview-${theme}-${width}`)}
      for(const rule of rules.kinds){const control=panel.getByRole('switch',{name:rule.label,exact:true});await control.click();expect(await control.getAttribute('aria-checked')).toBe('true');expect(await control.evaluate(node=>node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);expect(await control.evaluate(node=>{const box=node.getBoundingClientRect(),label=node.firstElementChild.getBoundingClientRect();return label.top>=box.top&&label.bottom<=box.bottom})).toBe(true);checks+=3}
      const sound=panel.getByRole('combobox',{name:'Sound for Five or ten wins',exact:true});await sound.selectOption('victory');
      await panel.getByRole('combobox',{name:'MMR milestone spacing',exact:true}).selectOption('250');
      expect(await panel.getByRole('switch',{name:'Post moments through the configured Twitch bot',exact:true}).getAttribute('aria-checked')).toBe('false');checks++;
      await noOverflow(page);await panel.locator('summary').scrollIntoViewIfNeeded();await shot(page,`settings-${theme}-${width}`);
      await page.getByRole('button',{name:'Save',exact:true}).click();await visible(page,'Chat settings saved');
      expect(prefs.get(tokens[0]).alerts.gameMoments).toMatchObject({mmrStep:250,botPost:false,moments:{winStreak:{enabled:true,sound:'victory'}}});checks++;
      const sourceCount=connections.filter(row=>row.token===tokens[0]&&row.widget==='chat-alerts').length,configCount=calls.filter(call=>call.path===`/v1/multichat/${tokens[0]}/config`).length;
      const widget=await context.newPage();widget.on('pageerror',error=>errors.push(error.message));await widget.clock.install();await widget.goto(`${origin}/fixture?view=widget&theme=${theme}`);
      await expect.poll(()=>connections.filter(row=>row.token===tokens[0]&&row.widget==='chat-alerts').length).toBeGreaterThan(sourceCount);
      await expect.poll(()=>calls.filter(call=>call.path===`/v1/multichat/${tokens[0]}/config`).length).toBeGreaterThan(configCount);
      // Saved readiness is observed through the real card, rather than a delay.
      const first=await send(widget,'winStreak',`win-${width}-${theme}`);await visible(widget,'Five or ten wins');await visible(widget,'Ladder');
      expect(await widget.getByText('TW',{exact:true}).count()).toBe(0);await noOverflow(widget);checks++;
      await shot(widget,`ladder-${theme}-${width}`);
      const sounds=await widget.evaluate(()=>window.fixtureSounds||[]);expect(sounds.filter(row=>row.kind==='reward'&&row.sound==='victory')).toHaveLength(1);checks++;
      // Actual provider boundary sends a raid through the real higher-priority queue.
      await widget.evaluate(token=>window.fixtureProvider(token,[{id:'raid',kind:'raid',platform:'twitch',user:'Synthetic raid',detail:'joined the stream',atMs:Date.now()}]),tokens[0]);
      await visible(widget,'Synthetic raid');await expect(widget.getByText('Five or ten wins',{exact:true})).toHaveCount(0);checks++;
      if(width===300||width===1440)await shot(widget,`supporter-priority-${theme}-${width}`);
      await widget.clock.runFor(3100);await visible(widget,'Five or ten wins');
      expect((await widget.evaluate(()=>window.fixtureSounds||[])).filter(row=>row.kind==='reward'&&row.sound==='victory')).toHaveLength(1);checks++;
      emit(tokens[0],'overlay:moment',first);await widget.clock.runFor(3100);await expect(widget.getByText('Five or ten wins',{exact:true})).toHaveCount(0);checks++;
      emit(tokens[0],'overlay:multichat',{...studio,gameWidgetsPaused:true});await send(widget,'winStreak','paused');await expect(widget.getByText('Five or ten wins',{exact:true})).toHaveCount(0);
      emit(tokens[0],'overlay:multichat',studio);await widget.clock.runFor(500);await expect(widget.getByText('Five or ten wins',{exact:true})).toHaveCount(0);checks+=2;
      if(width===300&&theme==='light'){
        for(const rule of rules.kinds){await send(widget,rule.id,`all-${rule.id}`);await visible(widget,rule.label);await widget.clock.runFor(3100)}
        const log=await context.newPage();await log.goto(`${origin}/fixture?view=clips&theme=${theme}`);await visible(log,'Recorded MMR milestone — Synthetic recorded ladder evidence · exact account and race.');await shot(log,'clips-light-300');await log.close();
      }
      // Source and Settings owner switches discard private draft/queued state.
      await send(widget,'marathonWin','before-switch');await visible(widget,'Marathon win');await widget.evaluate(()=>window.fixtureToken('synthetic-b'));await expect(widget.getByText('Marathon win',{exact:true})).toHaveCount(0);checks++;
      emit(tokens[0],'overlay:moment',{...first,gameId:'late-a'});await widget.clock.runFor(100);await expect(widget.getByText('Five or ten wins',{exact:true})).toHaveCount(0);checks++;
      await panel.getByRole('switch',{name:'Five or ten wins',exact:true}).click();await panel.getByRole('button',{name:'Test Five or ten wins',exact:true}).click();
      await page.evaluate(()=>{window.fixtureAuth('synthetic-b');window.fixtureToken('synthetic-b')});await expect(page.getByText('TEST · Local preview',{exact:true})).toHaveCount(0);
      await summary.click();await expect(page.getByRole('switch',{name:'Five or ten wins',exact:true})).toHaveAttribute('aria-checked','false');checks+=2;
      await page.evaluate(()=>window.fixtureAuth(null));await visible(page,'Sign in to configure chat settings.');
      expect(errors).toEqual([]);await noOverflow(page);await noOverflow(widget);checks++;
      // Scan the newly added controls in the actual form; legacy unrelated fields
      // retain their separate existing accessibility coverage.
      await page.evaluate(()=>window.fixtureAuth('synthetic-b'));await summary.click();
      await page.addScriptTag({content:axe.source});const violations=await panel.evaluate(async node=>(await window.axe.run(node,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}})).violations.map(item=>({id:item.id,nodes:item.nodes.map(row=>({target:row.target,failure:row.failureSummary}))})));expect(violations).toEqual([]);checks++;
      console.log(JSON.stringify({width,theme,checks,captures}));await context.close();
    }
    expect(unexpected).toEqual([]);console.log(JSON.stringify({result:'PASS',checks,captures,connections:connections.length,requests:calls.length}));
  }finally{await browser.close();await new Promise(resolve=>io.close(resolve));server.close()}
})().catch(error=>{console.error(error);process.exitCode=1;io.close();server.close()});
