/* Run from apps/web after a production build. Real Socket.IO and GameDeskService,
 * disposable in-memory persistence/provider adapters; all traffic loopback-only. */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process'), { chromium, expect } = require('@playwright/test');
const { Server } = require(path.resolve('../api/node_modules/socket.io')), axe = require('axe-core');
const { GameDeskService } = require(path.resolve('../api/src/services/gameDesk'));
const { withEndedGameControl } = require(path.resolve('../api/src/services/liveGameEndedControl'));
const root = process.cwd(), shots = '../../docs/handoff/screenshots'; fs.mkdirSync(shots, { recursive: true });
const tokens = ['synthetic-desk-a', 'synthetic-desk-b'], states = new Map(), calls = [], unexpected = [], connections = [];
let origin, io, checks = 0, captures = 0, holdNext = null, releaseHeld = null;
const initialLive = (token) => ({ type: 'liveGameState', phase: 'match_in_progress', gameKey: `${token}-game`, displayTime: 185, capturedAt: Date.now()/1000, receivedAt: Date.now(), user: {race:'Protoss'}, opponent: { name: token === tokens[0] ? 'Synthetic opponent' : 'Second opponent', race: 'Zerg', toonHandle:'1-S2-1-42', profile: {mmr:4200,league:'Master',pulse_character_id:'1-S2-1-42',confidence:1} }, opponentChannels: {twitch:'https://www.twitch.tv/synthetic_opponent'}, streamerHistory: {oppName:token === tokens[0] ? 'Synthetic opponent' : 'Second opponent',oppPulseId:'1-S2-1-42',headToHead:{wins:3,losses:2},opponentIdentityMatched:true,opponentNotes:{text:'PRIVATE-NOTE-CANARY',readAloud:true},recentGames:[{gameId:'PRIVATE-REPLAY-CANARY',result:'Win'}],openingHistory:[{name:'Hatch first',samples:5,of:7}]} });
function reset(token) {
  const live = initialLive(token);
  states.set(token, { live, verified:null, studio:{highlight:null,poll:null,goals:[{label:'Games today',current:3,target:10}],blockedUsers:[],scene:{mode:'brb',message:'Short break',countdownEndsAt:Date.now()+192000,setAtMs:Date.now()},timer:null,streamStartMs:Date.now()-600000,vodUrl:null,gameWidgetsPaused:false,updatedAt:new Date().toISOString()}, session:{wins:3,losses:2,games:5,mmrStart:4000,mmrCurrent:4020,streak:{kind:'win',count:2}}, round:{gameKey:live.gameKey,opponent:live.opponent.name,tally:{win:3,loss:1,total:4},locksAtMs:Date.now()+60000}, anchor:null });
}
tokens.forEach(reset);
const emit = (token,event,value) => io.to(`overlay:${token}`).emit(event,value);
const publish = token => { const state=states.get(token); if (!state) return; state.live.receivedAt=Date.now(); emit(token,'overlay:liveGame',state.live); };
function phase(token, value) { const state=states.get(token); const input=value==='menu'?{type:'liveGameState',phase:'menu',gameKey:null}: {...state.live,phase:value}; state.live=withEndedGameControl(input,state.live,Date.now());publish(token); }
const summary = token => { const state=states.get(token);return {wall:[],oracles:[],prediction:state.round,latestRoundKey:state.round?.gameKey || state.live.lastEndedGame?.gameKey || state.live.gameKey,oracleRecap:{calls:0,majorityRight:0,last:null},clipMoments:[]}; };
const snapshot = socket => { const token=socket.handshake.auth.overlayToken,state=states.get(token); socket.emit('overlay:config',{config:{},overlayProfile:{revision:0,widgets:{}}});socket.emit('overlay:multichat',state.studio);socket.emit('overlay:session',state.session);socket.emit('overlay:liveGame',{...state.live,receivedAt:Date.now()}); };
const desk = new GameDeskService({
  tokens:{withWrite:async(_token,work)=>work(),list:async owner=>[{token:owner}]},
  users:{updateOne:async({userId},patch)=>{const state=states.get(userId);state.anchor=[state.anchor,patch.$max.sessionAnchorAt].filter(Boolean).sort().at(-1);return{matchedCount:1}},findOne:async({userId})=>({sessionAnchorAt:states.get(userId).anchor})},
  studio:{get:async token=>states.get(token).studio,update:async(token,patch)=>{const state=states.get(token);state.studio={...state.studio,...patch,updatedAt:new Date().toISOString()};emit(token,'overlay:multichat',state.studio);return state.studio},advanceStreamStart:async(token,anchor)=>{const state=states.get(token);state.studio={...state.studio,streamStartMs:anchor,updatedAt:new Date().toISOString()};emit(token,'overlay:multichat',state.studio);return state.studio}},
  engagement:{_cancelAdmitted:async(token,key)=>{const state=states.get(token);if(state.round?.gameKey!==key)return false;state.round=null;emit(token,'overlay:engagement',{type:'prediction-cancelled',gameKey:key});return true},_manualSettleAdmitted:async(token,key,result)=>{const state=states.get(token);if(state.round?.gameKey!==key)return false;const tally=state.round.tally;state.round=null;emit(token,'overlay:engagement',{type:'prediction-settled',gameKey:key,result,manual:true,tally,pointsEach:0,correctCount:0,topOracles:[]});return true}},
  games:{invalidateSessionForReset(){},todaySession:async token=>{const state=states.get(token);state.session={wins:0,losses:0,games:0,sessionAnchorAt:state.anchor};emit(token,'overlay:session',state.session);return state.session}},
  broker:{latest:owner=>states.get(owner).live,latestOverlayLive:owner=>states.get(owner).verified},
  channels:{forMatch:async(_owner,live)=>live.opponentChannels||null},bot:{queueShoutout:()=>false},
});
const cssFiles = fs.readdirSync('.next/static/css',{recursive:true}).filter(name=>name.endsWith('.css'));
const cssBase = cssFiles.map(name=>fs.readFileSync(path.join('.next/static/css',name),'utf8')).join('\n');
const fonts = `@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay}`;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,origin||'http://127.0.0.1'),pathname=url.pathname;
  const json=(data,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data))};
  if(pathname.startsWith('/v1/')){
    const token=pathname.split('/')[3],state=states.get(token); calls.push({method:req.method,path:pathname});
    if(!state){unexpected.push({pathname,method:req.method});return json({},404)}
    if(pathname.endsWith('/studio')){
      if(req.method==='POST'){
        const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');calls.at(-1).body=body;
        try{const value=body.action?await desk.act(token,token,body):await desk.deps.studio.update(token,body);if(holdNext===body.action){holdNext=null;await new Promise(resolve=>{releaseHeld=resolve})}return json(value)}catch(error){return json({error:{code:error.code||'unavailable'}},error.status||500)}
      }return json(state.studio);
    }
    if(pathname.endsWith('/config'))return json({config:{twitch:{enabled:true,channel:'synthetic'},kick:{enabled:false},youtube:{enabled:false}},tts:{enabled:false}});
    if(pathname.endsWith('/engagement'))return json(summary(token));
    if(pathname.endsWith('/viewers'))return json({platforms:[{platform:'twitch',viewers:24,live:true}],total:24,partial:false});
    if(pathname.endsWith('/presence'))return json({surfaces:{'all-in-one':0,widget:1,scene:0,dock:1,unknown:0},totalSources:2,sampledAt:new Date().toISOString()});
    if(pathname.endsWith('/builds'))return json({builds:[]});
    if((pathname.endsWith('/ingest')||pathname.endsWith('/engage'))&&req.method==='POST')return json({ok:true});
    unexpected.push({pathname,method:req.method});return json({},404);
  }
  if(pathname==='/fixture.js'){res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync('.tmp/game-desk-fixture.js'))}
  if(pathname==='/fixture'){
    res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(`<!doctype html><html lang="en" data-theme="${url.searchParams.get('theme')==='dark'?'dark':'light'}"><head><title>Local Game Desk proof</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${cssBase}\n${fs.readFileSync('.tmp/game-desk-fixture.css','utf8')}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`)
  }
  const base=pathname.startsWith('/fonts/')?path.join(root,'app/fonts'):path.join(root,'public'),file=path.resolve(base,pathname.startsWith('/fonts/')?pathname.slice(7):pathname.slice(1));
  if(!file.startsWith(base+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.statusCode=404;return res.end()}
  res.setHeader('Content-Type',({'.woff2':'font/woff2','.png':'image/png','.svg':'image/svg+xml','.webp':'image/webp'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
});
io=new Server(server,{transports:['websocket','polling']});io.use((socket,next)=>next(states.has(socket.handshake.auth.overlayToken)?undefined:new Error('invalid_overlay_token')));
io.on('connection',socket=>{connections.push({token:socket.handshake.auth.overlayToken,surface:socket.handshake.auth.surface,widget:socket.handshake.auth.widget});socket.join(`overlay:${socket.handshake.auth.overlayToken}`);snapshot(socket);socket.on('overlay:resync',()=>snapshot(socket));socket.on('overlay:heartbeat',()=>socket.emit('overlay:heartbeat',{gameKey:states.get(socket.handshake.auth.overlayToken).live.gameKey}))});
const hit=locator=>locator.evaluate(node=>{const box=node.getBoundingClientRect(),target=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);return{hit:!!target&&(node===target||node.contains(target)),height:box.height,width:box.width}});
async function capture(page,name){await page.evaluate(()=>scrollTo(0,0));await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));await page.screenshot({path:`${shots}/game-desk-${name}.png`});captures++}
async function dialogConfirm(page,name){const dialog=page.getByRole('dialog');await expect(dialog.getByRole('button',{name:'Cancel',exact:true})).toBeFocused();await dialog.getByRole('button',{name,exact:true}).click();await expect(dialog).toHaveCount(0);checks++}
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
  execFileSync(process.execPath,['tests/manual/game-desk-fixture.cjs'],{stdio:'inherit',env:{...process.env,GAME_DESK_FIXTURE_ORIGIN:origin}});
  const timer=setInterval(()=>tokens.forEach(publish),1000),browser=await chromium.launch({headless:true});
  try{
    for(const width of [300,320,390,768,1440])for(const theme of ['light','dark']){
      tokens.forEach(reset);const context=await browser.newContext({viewport:{width,height:950},reducedMotion:'reduce',hasTouch:width<1000,isMobile:width<1000});
      await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
      await context.addInitScript(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('Synthetic OBS clipboard denial')}}});Object.defineProperty(window,'speechSynthesis',{configurable:true,value:{getVoices:()=>[],addEventListener(){},removeEventListener(){},cancel(){},speak(){throw new Error('Speech blocked in fixture')}}})});
      const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.goto(`${origin}/fixture?theme=${theme}`);const game=page.locator('#dock-game'),header=page.locator('[data-dock-status-header]');
      await expect(game.getByText('Synthetic opponent',{exact:true})).toBeVisible();await expect(header.getByText('Connected',{exact:true})).toBeVisible();await expect(game.getByText('PvZ · Map unavailable live',{exact:true})).toBeVisible();checks+=3;
      await expect(header.getByText('3W–2L · +20 MMR',{exact:true})).toBeVisible();await expect(game.getByRole('progressbar')).toHaveAttribute('aria-valuetext','3 win, 1 loss');await expect(game.getByRole('button',{name:'Resolve Win',exact:true})).toBeDisabled();checks+=3;
      await page.evaluate(()=>document.fonts.ready);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(page.getByRole('heading',{level:1})).toHaveCount(1);expect(await page.locator('body').innerText()).not.toMatch(/PRIVATE-(NOTE|REPLAY)-CANARY|1-S2-1-42/);checks+=3;
      if(width>=1024){const aligned=()=>page.evaluate(()=>Math.abs(document.querySelector('#dock-chat').getBoundingClientRect().top-document.querySelector('#dock-game').getBoundingClientRect().top)<2);expect(await aligned()).toBe(true);await page.getByRole('button',{name:'Pin Poll to top',exact:true}).click();expect(await aligned()).toBe(true);await page.getByRole('button',{name:'Unpin Poll',exact:true}).click();expect(await aligned()).toBe(true);checks+=3}
      await capture(page,`active-${theme}-${width}`);
      for(const name of ['Shout out','Cancel round','Start new session','Hide game widgets']){const control=game.getByRole('button',{name,exact:true});await control.scrollIntoViewIfNeeded();const target=await hit(control);expect(target.hit).toBe(true);expect(target.height).toBeGreaterThanOrEqual(width<1000?40:28);checks++}
      await game.getByRole('button',{name:'Shout out',exact:true}).click();await game.getByRole('button',{name:'Copy shout-out',exact:true}).click();const copy=game.getByRole('textbox',{name:'Copy shout-out manually'});await expect(copy).toBeFocused();expect(await copy.inputValue()).toContain('https://www.twitch.tv/synthetic_opponent');expect(await copy.evaluate(node=>node.selectionEnd===node.value.length)).toBe(true);checks+=3;
      if(width===300||width===1440)await capture(page,`shoutout-${theme}-${width}`);
      await game.getByRole('button',{name:'Hide copy field',exact:true}).click();
      const widget=await context.newPage();await widget.goto(`${origin}/fixture?theme=${theme}&widget=opponent`);await expect(widget.getByText('Synthetic opponent',{exact:true})).toBeVisible();checks++;
      await game.getByRole('button',{name:'Hide game widgets',exact:true}).click();await expect(header.getByText('Game widgets hidden',{exact:true})).toBeVisible();await expect(widget.getByText('Synthetic opponent',{exact:true})).toHaveCount(0);await expect(page.getByText('Great hold!',{exact:true})).toBeVisible();checks+=3;if(width===300&&theme==='dark'||width===1440&&theme==='light')await capture(page,`paused-${theme}-${width}`);
      await game.getByRole('button',{name:'Show game widgets',exact:true}).click();await expect(widget.getByText('Synthetic opponent',{exact:true})).toBeVisible();await widget.close();checks++;
      // A menu heartbeat follows the brief native match_ended phase. The same
      // bounded cloud receipt keeps manual controls available without live facts.
      phase(tokens[0],'match_ended');phase(tokens[0],'menu');await expect(game.getByText('In menu',{exact:true})).toBeVisible();await expect(game.getByRole('button',{name:'Resolve Win',exact:true})).toBeEnabled();await expect(header.getByLabel('Current opponent')).toHaveCount(0);checks+=3;
      const oracle=await context.newPage();await oracle.goto(`${origin}/fixture?theme=${theme}&widget=chat-oracle`);
      await game.getByRole('button',{name:'Resolve Win',exact:true}).click();await dialogConfirm(page,'Resolve manually');await expect(oracle.getByText(/Resolved manually/i)).toBeVisible();await expect(oracle.getByText(/No points/i)).toBeVisible();await expect(game.getByText(/No open round/)).toBeVisible();checks+=3;
      if(width===300||width===1440)await capture(oracle,`manual-oracle-${theme}-${width}`);await oracle.close();
      await game.getByRole('button',{name:'Start new session',exact:true}).click();await dialogConfirm(page,'Start new session');await expect(header.getByText('0W–0L · MMR change unavailable',{exact:true})).toBeVisible();checks++;
      // All-scroll scene/session facts and jump offsets use the measured header.
      if(width<1000){await page.getByRole('navigation',{name:'Dock sections'}).getByRole('button',{name:'Goals',exact:true}).click();await expect(page.locator('#dock-goals-toggle')).toBeFocused();const boxes=await page.evaluate(()=>({header:document.querySelector('[data-dock-status-header]').getBoundingClientRect().bottom,section:document.querySelector('#dock-goals').getBoundingClientRect().top}));expect(boxes.section).toBeGreaterThanOrEqual(boxes.header-1);checks++}
      await page.evaluate(()=>scrollTo(0,500));await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));expect(await header.evaluate(node=>Math.abs(node.getBoundingClientRect().top)<2)).toBe(true);checks++;
      await page.addScriptTag({content:axe.source});const violations=await page.evaluate(async()=>(await window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}})).violations.map(issue=>({id:issue.id,nodes:issue.nodes.map(node=>({target:node.target,html:node.html,failure:node.failureSummary}))})));expect(violations).toEqual([]);expect(errors).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);checks+=3;
      // Missing approved channels fail closed. Cancel and manual gates remain
      // tied to the actual current round, including expired/verified receipts.
      reset(tokens[0]);const state=states.get(tokens[0]);delete state.live.opponentChannels;publish(tokens[0]);emit(tokens[0],'overlay:engagement',{type:'prediction-open',...state.round});await expect(game.getByRole('button',{name:'Shout out',exact:true})).toBeDisabled();await expect(game.getByText('Approved channels unavailable for this opponent.',{exact:true})).toBeVisible();checks+=2;if(width===300&&theme==='dark'||width===1440&&theme==='light')await capture(page,`unavailable-${theme}-${width}`);
      phase(tokens[0],'match_ended');phase(tokens[0],'menu');state.live.lastEndedGame.endedAt=Date.now()-31*60_000;publish(tokens[0]);await expect(game.getByRole('button',{name:'Resolve Win',exact:true})).toBeDisabled();state.live.lastEndedGame.endedAt=Date.now();publish(tokens[0]);emit(tokens[0],'overlay:live',{gameKey:state.round.gameKey,result:'win'});await expect(game.getByRole('button',{name:'Resolve Win',exact:true})).toBeDisabled();checks+=2;
      await game.getByRole('button',{name:'Cancel round',exact:true}).click();await dialogConfirm(page,'Cancel round');await expect(game.getByText(/No open round/)).toBeVisible();checks++;
      // Held mutation must retain busy dialog focus despite Escape/backdrop.
      await game.getByRole('button',{name:'Start new session',exact:true}).click();holdNext='sessionReset';await page.getByRole('dialog').getByRole('button',{name:'Start new session',exact:true}).click();const progress=page.getByRole('dialog').getByText('Saving game control…',{exact:true});await expect(progress).toBeFocused();await page.keyboard.press('Escape');await expect(progress).toBeFocused();await page.mouse.click(2,2);await expect(progress).toBeFocused();if(width===300&&theme==='dark'||width===1440&&theme==='light')await capture(page,`busy-${theme}-${width}`);releaseHeld();releaseHeld=null;await expect(page.getByRole('dialog')).toHaveCount(0);checks+=3;
      // Late successful response from A cannot display in B's mounted Dock.
      reset(tokens[0]);publish(tokens[0]);emit(tokens[0],'overlay:multichat',states.get(tokens[0]).studio);await expect(game.getByText('Synthetic opponent',{exact:true})).toBeVisible();holdNext='shoutout';await game.getByRole('button',{name:'Shout out',exact:true}).click();await expect.poll(()=>typeof releaseHeld).toBe('function');await page.evaluate(token=>window.fixtureOwner(token),tokens[1]);await expect(game.getByText('Second opponent',{exact:true})).toBeVisible();releaseHeld();releaseHeld=null;await expect(game.getByRole('button',{name:'Copy shout-out',exact:true})).toHaveCount(0);await expect(page.getByRole('dialog')).toHaveCount(0);checks+=3;
      console.log(JSON.stringify({width,theme,checks,captures}));await context.close();
    }
    expect(unexpected).toEqual([]);checks++;console.log(JSON.stringify({checks,captures,cssFiles,actions:calls.filter(call=>call.body?.action).map(call=>call.body.action),socketSurfaces:[...new Set(connections.map(item=>item.surface))],externalTraffic:'blocked',persistence:'synthetic disposable adapters'}));
  }finally{clearInterval(timer);releaseHeld?.();await browser.close();await new Promise(resolve=>io.close(resolve));server.closeAllConnections()}
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;releaseHeld?.();io.close();server.closeAllConnections()});
