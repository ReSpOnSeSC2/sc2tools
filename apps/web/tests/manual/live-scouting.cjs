/* Run from apps/web after production build. Loopback-only synthetic data, no actual accounts. */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process'), { chromium, expect } = require('@playwright/test');
const { Server } = require(path.resolve('../api/node_modules/socket.io'));
execFileSync(process.execPath, ['tests/manual/live-scouting-fixture.cjs'], { stdio: 'inherit' });
const root = process.cwd(), origin = 'http://127.0.0.1:3253', shots = '../../docs/handoff/screenshots'; fs.mkdirSync(shots, { recursive: true });
const css = fs.readdirSync('.next/static/css', { recursive: true }).filter(name => name.endsWith('.css')).map(name => fs.readFileSync(path.join('.next/static/css', name), 'utf8')).join('\n') + fs.readFileSync('.tmp/live-scouting-fixture.css', 'utf8');
const fonts = `@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay}`;
const makeLive = () => ({ type: 'liveGameState', phase: 'match_loading', displayTime: 185, capturedAt: Date.now()/1000, receivedAt: Date.now(), gameKey: 'synthetic-one', opponent: { name: 'Synthetic opponent', race: 'Zerg', profile: { mmr: 4200, league: 'Master' } }, streamerHistory: { oppName: 'Synthetic opponent', oppPulseId: '1-S2-1-42', opponentIdentityMatched: true, opponentNotesWritable: true, headToHead: { wins: 3, losses: 2 }, opponentNotes: { text: 'Synthetic private reminder', readAloud: true }, openingHistory: [{ name: 'Hatch first', samples: 5, of: 7 }, { name: 'Pool first', samples: 2, of: 7 }], bestAnswer: { build: 'Phoenix', total: 3, winRate: 2/3 }, recentGames: [{ gameId: 'synthetic-replay', result: 'Win', map: 'Synthetic map', lengthText: '9:20', myBuild: 'Phoenix', oppBuild: 'Hatch first' }] } });
let current = makeLive(), stale = false, failNote = false, checks = 0; const readers = new Set(), writes = [], unexpected = [];
const packet = () => ({ ...current, receivedAt: Date.now() - (stale ? 31_000 : 0) });
let io; const publish = () => { const value = packet(); for (const res of readers) res.write(`data: ${JSON.stringify(value)}\n\n`); io.emit('overlay:liveGame', value); };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, origin), pathname = url.pathname;
  const json = (value, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (pathname === '/v1/me/live') {
    if (req.headers.authorization !== 'Bearer synthetic-local-token') return json({},401);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); res.write(`: ok\n\ndata: ${JSON.stringify(packet())}\n\n`); readers.add(res); req.on('close',()=>readers.delete(res)); return;
  }
  if (pathname.startsWith('/v1/')) {
    if (req.method !== 'GET') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (pathname === '/v1/opponents/1-S2-1-42/notes' && req.method === 'PUT' && req.headers.authorization === 'Bearer synthetic-local-token') {
        expect(body.preserveReadAloud).toBe(true); expect(body.notesReadAloud).toBeUndefined(); writes.push(body);
        if (failNote) { failNote = false; return json({error:{code:'unavailable'}},503); }
        current.streamerHistory.opponentNotes.text = body.notes; return json({ notes: body.notes, notesReadAloud: false });
      }
      unexpected.push({pathname, method:req.method}); return json({},405);
    }
    if (pathname.endsWith('/presence')) return json({ surfaces: { 'all-in-one': 0, widget: 0, scene: 0, dock: 1 }, totalSources: 1, sampledAt: new Date().toISOString() });
    if (pathname.endsWith('/config')) return json({config:{}});
    return json({});
  }
  if (pathname === '/fixture.js') { res.setHeader('Content-Type','text/javascript; charset=utf-8'); return res.end(fs.readFileSync('.tmp/live-scouting-fixture.js')); }
  if (pathname === '/app' || pathname === '/app/live' || pathname.startsWith('/dock/')) { res.setHeader('Content-Type','text/html; charset=utf-8'); return res.end(`<!doctype html><html data-theme="${url.searchParams.get('theme')==='dark'?'dark':'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`); }
  const base = pathname.startsWith('/fonts/') ? path.join(root,'app/fonts') : path.join(root,'public'), file = path.resolve(base, pathname.startsWith('/fonts/') ? pathname.slice(7) : pathname.slice(1));
  if (!file.startsWith(base+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode=404; return res.end(); }
  res.setHeader('Content-Type', ({'.woff2':'font/woff2','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp'})[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
});
io = new Server(server, { transports:['websocket','polling'] }); io.use((socket,next)=>next(socket.handshake.auth.overlayToken==='synthetic-dock-local'?undefined:new Error('invalid_overlay_token')));
io.on('connection',socket=>{socket.emit('overlay:liveGame',packet());socket.emit('overlay:session',{wins:4,losses:2,games:6,mmrStart:4000,mmrCurrent:4020});socket.emit('overlay:multichat',{});});
(async()=>{
  await new Promise(resolve=>server.listen(3253,'127.0.0.1',resolve)); const timer=setInterval(publish,1000), browser=await chromium.launch({headless:true});
  try { for(const width of [320,390,768,1440])for(const theme of ['light','dark']) {
    current=makeLive();stale=false;const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'}), page=await context.newPage(), errors=[];
    await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());page.on('pageerror',error=>{errors.push(error.message);console.error('Fixture page error:',error.message)});
    await page.goto(`${origin}/app?theme=${theme}`);try{await expect(page.getByText('Your record: 3W 2L')).toBeVisible()}catch(error){console.error(await page.locator('body').innerText());await page.screenshot({path:'.tmp/live-scouting-fixture-failure.png'});throw error}await expect(page.getByText('Synthetic private reminder')).toBeVisible();checks++;
    await expect(page.getByText('· 5 of 7 games')).toBeVisible();await expect(page.getByText('4,200 MMR')).toBeVisible();checks++;
    await page.evaluate(()=>document.fonts.ready);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`${shots}/live-scouting-today-${theme}-${width}.png`});checks++;
    await page.getByRole('button',{name:'Add note',exact:true}).click();const field=page.getByRole('textbox',{name:'Note for next meeting'});await field.fill(`Synthetic note ${width}`);
    current.phase='match_in_progress';publish();await expect(field).toHaveValue(`Synthetic note ${width}`);checks++;
    failNote=true;await page.getByRole('button',{name:'Save note',exact:true}).click();await expect(page.getByText(/Couldn’t save this note/)).toBeVisible();await expect(field).toHaveValue(`Synthetic note ${width}`);checks++;
    const attempts=writes.length;await page.getByRole('button',{name:'Save note',exact:true}).click();await expect.poll(()=>writes.length).toBe(attempts+1);await expect(page.getByRole('button',{name:'Saving…',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Save note',exact:true})).toBeDisabled();await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'Brief',exact:true})).toBeVisible();checks++;
    stale=true;publish();await expect(page.getByRole('region',{name:'Live scouting'})).toHaveCount(0);checks++;stale=false;current=makeLive();publish();
    await page.goto(`${origin}/app/live?theme=${theme}`);await expect(page.getByText('Your record: 3W 2L')).toBeVisible();const replay=page.locator('a[href="/app/game/synthetic-replay"]');await expect(replay).toHaveAttribute('href','/app/game/synthetic-replay');if(width>=640)await expect(replay).toBeVisible();else await expect(replay).toBeHidden();checks++;
    await page.evaluate(()=>document.fonts.ready);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`${shots}/live-scouting-screen-${theme}-${width}.png`});checks++;
    current.phase='menu';publish();await expect(page.getByText('Waiting for your next game')).toBeVisible();checks++;current=makeLive();publish();
    await page.goto(`${origin}/dock/synthetic-dock-local?theme=${theme}`);const scout=page.locator('#dock-scout');await expect(scout.getByText('Your record: 3W 2L')).toBeVisible();expect(await scout.locator('a,textarea').count()).toBe(0);await expect(scout.getByText('Synthetic private reminder')).toHaveCount(0);expect(await scout.textContent()).not.toContain('1-S2-1-42');checks++;
    await scout.scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`${shots}/live-scouting-dock-${theme}-${width}.png`});checks++;
    expect(errors).toEqual([]);await context.close();console.log(JSON.stringify({width,theme,checks}));
  } expect(unexpected).toEqual([]);expect(writes).toHaveLength(16);console.log(`${checks} live-scouting browser checks passed; actual local SSE/Socket.IO,16 synthetic note attempts, no nonlocal traffic`);
  } finally {clearInterval(timer);for(const res of readers)res.end();await browser.close();await new Promise(resolve=>io.close(resolve));server.closeAllConnections();}
})().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;io.close();server.closeAllConnections();});
