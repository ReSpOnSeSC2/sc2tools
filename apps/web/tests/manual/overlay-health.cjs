/* Real settings/chrome/SWR; only explicit Next/Clerk/socket boundaries and loopback synthetic APIs.
 * Run from apps/web after the production build: node tests/manual/overlay-health.cjs
 */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process'), { chromium, expect } = require('@playwright/test');
execFileSync(process.execPath, ['tests/manual/overlay-health-fixture.cjs'], { stdio: 'inherit' });
const root = process.cwd(), origin = 'http://127.0.0.1:3246';
const css = fs.readdirSync('.next/static/css', { recursive: true }).filter(name => name.endsWith('.css')).map(name => fs.readFileSync(path.join('.next/static/css', name), 'utf8')).join('\n');
const extra = fs.existsSync('.tmp/overlay-health-fixture.css') ? fs.readFileSync('.tmp/overlay-health-fixture.css', 'utf8') : '';
const fonts = `@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureSerif;src:url('/fonts/fraunces-latin-normal.woff2');font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay;--font-serif:FixtureSerif}`;
const secret = 'synthetic-local-overlay-token'; let enabled = ['session', 'scouting', 'multichat']; const calls = [], unexpectedWrites = [];
let io, unavailable=false;const {createRequire}=require('node:module'), apiRequire=createRequire(path.resolve(root,'../api/package.json'));const {Server}=apiRequire('socket.io'),{attachSocketAuth}=apiRequire('./src/socket/auth'),{readOverlayPresence}=apiRequire('./src/services/overlayPresence'),clientIo=require('socket.io-client').io;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, origin), pathname = url.pathname;
  const json = (value, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (pathname.startsWith('/v1/')) {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    calls.push({ path: pathname, method: req.method, body });
    if (pathname === '/v1/seasons') return json({ items: [], current: null, source: 'fallback', fetchedAt: null });
    if (pathname === '/v1/site/banner') return json({ banner: null });
    if (pathname === '/v1/ping') return json({ ok: true });
    if(pathname===`/v1/multichat/${secret}/presence`){if(unavailable)return json({error:{code:'overlay_presence_unavailable'}},503);const data=await readOverlayPresence(io,secret,'synthetic-local-fixture');return json({surfaces:Object.fromEntries(Object.entries(data.surfaces).map(([id,row])=>[id,row.count])),totalSources:data.totalSources,sampledAt:data.sampledAt});}
    if(pathname.startsWith(`/v1/multichat/${secret}/`)){if(req.method!=='GET'){unexpectedWrites.push({path:pathname,method:req.method});return json({error:{code:'write_blocked'}},405)}return json({});}
    if (req.headers.authorization !== 'Bearer synthetic-local-token') return json({ error: { code: 'auth_required' } }, 401);
    if (pathname === `/v1/overlay-tokens/${secret}/widgets` && req.method === 'PUT') {
      if (body.expectedEnabled && JSON.stringify([...body.expectedEnabled].sort()) !== JSON.stringify([...enabled].sort())) return json({ error: { code: 'widget_selection_changed' } }, 409);
      enabled = [...body.enabled]; return json({ enabledWidgets: enabled });
    }
    if (pathname === `/v1/overlay-tokens/${secret}/widgets` && req.method === 'PATCH') { enabled = body.enabled ? [...new Set([...enabled, body.widget])] : enabled.filter(id => id !== body.widget); return json({ enabledWidgets: enabled }); }
    if (pathname === '/v1/overlay-events/test' && req.method === 'POST') return json({ error: { code: 'live_match', message: 'Synthetic local live gate' } }, 409);
    if (req.method !== 'GET') { unexpectedWrites.push({ path: pathname, method: req.method }); return json({ error: { code: 'write_blocked' } }, 405); }
    if(pathname===`/v1/overlay-tokens/${secret}/presence`){if(unavailable)return json({error:{code:'overlay_presence_unavailable'}},503);return json(await readOverlayPresence(io,secret,'synthetic-local-fixture'));}
    if (pathname === '/v1/overlay-tokens') return json({ items: [{ token: secret, label: 'Local fixture', createdAt: '2026-10-25T00:00:00Z', lastSeenAt: null, revokedAt: null, enabledWidgets: enabled }] });
    if (pathname === '/v1/me') return json({ userId: 'synthetic-local-fixture', isAdmin: false, agentLastSeenAt: new Date().toISOString(), games: { total: 14, latest: new Date().toISOString() } });
    if (pathname === '/v1/me/profile') return json({ displayName: 'Fixture player' });
    if (pathname === '/v1/me/preferences/multichat') return json({ twitch: { enabled: false, channel: 'fixturechannel' } });
    if (pathname === '/v1/me/chatbot') return json({ enabled: false, username: '', channel: '', replyCommands: true, announceOracle: true, announceLevelUps: true, hasToken: false, status: { state: 'off', channel: null, lastError: null, lastConnectedAt: null } });
    if (pathname === '/v1/me/integrations') return json({ platforms: [] });
    if (pathname.endsWith('/unread-count')) return json({ count: 0 });
    if (pathname === '/v1/coaching/me') return json({ role: 'none' });
    if (pathname === '/v1/coaching/alerts') return json({ pending: 0, items: [] });
    return json({});
  }
  if (pathname === '/api/site/stats') return json({ agentDownloads: 42, activeAgents: 1, activeUsers: 1, generatedAt: new Date().toISOString(), activityWindowSeconds: 60 });
  if (pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync('.tmp/overlay-health-fixture.js')); }
  if (pathname === '/settings'||pathname.startsWith('/dock/')||pathname.startsWith('/overlay/')) { const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light'; res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(`<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${extra}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`); }
  const base = pathname.startsWith('/fonts/') ? path.join(root, 'app/fonts') : path.join(root, 'public'), file = path.resolve(base, pathname.startsWith('/fonts/') ? pathname.slice(7) : pathname.slice(1));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', ({ '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
});


io=new Server(server,{cors:{origin},transports:['websocket']});attachSocketAuth(io,{secretKey:'synthetic',resolveOverlayToken:async token=>token===secret?{userId:'synthetic-local-fixture',label:'Fixture',enabledWidgets:enabled}:null,resolveDeviceToken:async()=>({userId:'synthetic-local-fixture',deviceId:'0123456789abcdef01234567'}),resolveSession:async()=>({wins:4,losses:2,games:6})});
(async()=>{
 await new Promise(resolve=>server.listen(3246,'127.0.0.1',resolve));const browser=await chromium.launch({headless:true}),sources=[];let checks=0;
 const connect=async auth=>{const client=clientIo(origin,{transports:['websocket'],auth,reconnection:false});sources.push(client);await new Promise((resolve,reject)=>{client.once('connect',resolve);client.once('connect_error',reject)});return client};
 try{
  await connect({overlayToken:secret,presenceVersion:1,surface:'all-in-one'});await connect({overlayToken:secret,presenceVersion:1,surface:'widget',widget:'scouting'});await connect({overlayToken:secret,presenceVersion:1,surface:'widget',widget:'multichat'});await connect({overlayToken:secret});await connect({deviceToken:'synthetic-device'});
  for(const width of [320,390,768,1440])for(const theme of ['light','dark']){
   const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'});await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
   await page.goto(`${origin}/settings?tab=overlay&section=setup&theme=${theme}`);const board=page.getByRole('region',{name:'Overlay health'});await expect(board.getByText('Connected',{exact:true})).toBeVisible();await expect(board.getByText(/1 unknown source/)).toBeVisible();await expect(board.getByText('2 connected',{exact:true})).toBeVisible();checks++;
   await page.evaluate(()=>document.fonts.ready);await board.scrollIntoViewIfNeeded();await page.screenshot({path:`../../docs/handoff/screenshots/overlay-health-setup-${theme}-${width}.png`});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);checks++;
   unavailable=true;await board.getByRole('button',{name:'Refresh sources',exact:true}).click();await expect(board.getByText(/Couldn’t refresh source connections/)).toBeVisible();expect(await board.locator('.bg-success\\/15').count()).toBe(0);checks++;unavailable=false;await board.getByRole('button',{name:'Refresh sources',exact:true}).click();await expect(board.getByText(/Couldn’t refresh/)).toHaveCount(0);checks++;
   await page.getByRole('navigation',{name:'Overlay settings sections'}).getByRole('link',{name:'Widgets',exact:true}).click();await page.getByRole('searchbox',{name:'Find a widget'}).fill('Scouting');const card=page.locator('[data-widget-id="scouting"]');await expect(card.getByText('Duplicate audio · 2 sources')).toBeVisible();await expect(card.getByText(/Keep only one copy audible/)).toBeVisible();checks++;
   await card.scrollIntoViewIfNeeded();await page.screenshot({path:`../../docs/handoff/screenshots/overlay-health-widget-${theme}-${width}.png`});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);checks++;
   await page.getByRole('searchbox',{name:'Find a widget'}).fill('Multi-platform chat');const chat=page.locator('[data-widget-id="multichat"]');await expect(chat.getByText('In OBS ×1')).toBeVisible();await expect(chat.getByText(/Duplicate audio/)).toHaveCount(0);checks++;
   await page.goto(`${origin}/dock/${secret}?theme=${theme}`);const strip=page.getByLabel('Overlay source counts');await expect(strip.getByText('Widgets 2',{exact:true})).toBeVisible();await expect(strip.getByText('Docks 1',{exact:true})).toBeVisible({timeout:20000});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);checks++;
   await page.goto(`${origin}/overlay/${secret}?w=session&theme=${theme}`);await expect.poll(async()=>{const data=await readOverlayPresence(io,secret,'synthetic-local-fixture');return data.widgets.session?.count??0}).toBe(1);const counts=await readOverlayPresence(io,secret,'synthetic-local-fixture');expect(counts.surfaces['all-in-one'].count).toBe(1);checks++;
   expect(errors).toEqual([]);await context.close();console.log(JSON.stringify({width,theme,checks}));
  }
  expect(unexpectedWrites).toEqual([]);console.log(`${checks} real overlay-health browser checks passed; actual local Socket.IO inventory, production CSS, synthetic data only`);
 }finally{for(const client of sources)client.disconnect();await browser.close();await new Promise(resolve=>io.close(resolve));server.closeAllConnections();}
})().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;io.close();server.closeAllConnections();});
