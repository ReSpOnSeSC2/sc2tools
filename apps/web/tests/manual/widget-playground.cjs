/* Real settings/chrome/SWR; only explicit Next/Clerk/socket boundaries and loopback synthetic APIs.
 * Run from apps/web after the production build: node tests/manual/widget-playground.cjs
 */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process'), { chromium, expect } = require('@playwright/test');
execFileSync(process.execPath, ['tests/manual/widget-playground-fixture.cjs'], { stdio: 'inherit' });
const root = process.cwd(), origin = 'http://127.0.0.1:3242';
const css = fs.readdirSync('.next/static/css', { recursive: true }).filter(name => name.endsWith('.css')).map(name => fs.readFileSync(path.join('.next/static/css', name), 'utf8')).join('\n');
const extra = fs.existsSync('.tmp/widget-playground-fixture.css') ? fs.readFileSync('.tmp/widget-playground-fixture.css', 'utf8') : '';
const fonts = `@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureSerif;src:url('/fonts/fraunces-latin-normal.woff2');font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay;--font-serif:FixtureSerif}`;
const secret = 'synthetic-local-overlay-token'; let enabled = ['session', 'randomizer']; const calls = [], unexpectedWrites = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, origin), pathname = url.pathname;
  const json = (value, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (pathname.startsWith('/v1/')) {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    calls.push({ path: pathname, method: req.method, body });
    if (pathname === '/v1/seasons') return json({ items: [], current: null, source: 'fallback', fetchedAt: null });
    if (pathname === '/v1/site/banner') return json({ banner: null });
    if (pathname === '/v1/ping') return json({ ok: true });
    if (req.headers.authorization !== 'Bearer synthetic-local-token') return json({ error: { code: 'auth_required' } }, 401);
    if (pathname === `/v1/overlay-tokens/${secret}/widgets` && req.method === 'PUT') {
      if (body.expectedEnabled && JSON.stringify([...body.expectedEnabled].sort()) !== JSON.stringify([...enabled].sort())) return json({ error: { code: 'widget_selection_changed' } }, 409);
      enabled = [...body.enabled]; return json({ enabledWidgets: enabled });
    }
    if (pathname === `/v1/overlay-tokens/${secret}/widgets` && req.method === 'PATCH') { enabled = body.enabled ? [...new Set([...enabled, body.widget])] : enabled.filter(id => id !== body.widget); return json({ enabledWidgets: enabled }); }
    if (pathname === '/v1/overlay-events/test' && req.method === 'POST') return json({ error: { code: 'live_match', message: 'Synthetic local live gate' } }, 409);
    if (req.method !== 'GET') { unexpectedWrites.push({ path: pathname, method: req.method }); return json({ error: { code: 'write_blocked' } }, 405); }
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
  if (pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync('.tmp/widget-playground-fixture.js')); }
  if (['/settings','/playground','/learn','/stream-studio'].includes(pathname)) { const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light'; res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(`<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${extra}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`); }
  const base = pathname.startsWith('/fonts/') ? path.join(root, 'app/fonts') : path.join(root, 'public'), file = path.resolve(base, pathname.startsWith('/fonts/') ? pathname.slice(7) : pathname.slice(1));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', ({ '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
});


(async () => {
 await new Promise(resolve => server.listen(3242, '127.0.0.1', resolve)); const browser=await chromium.launch({headless:true}); let checks=0;
 try {
  for(const width of [320,390,768,1440]) for(const theme of ['light','dark']) {
   const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'}); await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
   const page=await context.newPage(), errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.addInitScript(()=>{window.previewAttempts=[];const original=window.fetch;window.fetch=(...args)=>{window.previewAttempts.push(['fetch',String(args[0])]);return original(...args)};for(const key of ['WebSocket','EventSource','Audio','AudioContext','webkitAudioContext'])window[key]=function(){window.previewAttempts.push([key]);throw Error('Preview opened '+key)};if(window.speechSynthesis)window.speechSynthesis.speak=()=>window.previewAttempts.push(['speech']);});
   await page.goto(`${origin}/playground?theme=${theme}&audio=1&voice=1`);await expect(page.getByRole('region',{name:'Widget playground'})).toBeVisible();await page.evaluate(()=>document.fonts.ready);
   const picker=page.getByRole('combobox',{name:'Widget',exact:true});const ids=await picker.locator('option').evaluateAll(nodes=>nodes.map(n=>n.value).filter(id=>id!=='all'));
   for(const id of ids){await picker.selectOption(id);const stage=page.getByRole('img',{name:/sample preview$/});await expect(stage).toBeVisible();await page.waitForTimeout(40);const metrics=await stage.evaluate(node=>{const sample=node.firstElementChild,rect=sample.getBoundingClientRect(),box=node.getBoundingClientRect();return {html:sample.innerHTML.length,w:rect.width,h:rect.height,hostw:box.width,hosth:box.height,scroll:node.scrollWidth>node.clientWidth+2||node.scrollHeight>node.clientHeight+2}});expect(metrics.html, id).toBeGreaterThan(100);if(id==='chat-poll')expect(metrics.w, 'poll card should use the stage width').toBeGreaterThan(Math.min(200,metrics.hostw-30));expect(metrics.scroll,`${id} fit overflows ${JSON.stringify(metrics)}`).toBe(false);checks++;}
   for(const label of ['Pre-game','Victory','Defeat','Cheese','Hot streak','Chat burst','Poll']){await page.getByRole('button',{name:label,exact:true}).click();await expect(page.getByRole('button',{name:label,exact:true})).toHaveAttribute('aria-pressed','true');checks++;}
   await picker.selectOption('all');await expect(page.getByRole('img',{name:/sample preview$/})).toHaveCount(ids.length);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);checks++;
   await picker.selectOption('build-profile');await page.getByRole('button',{name:'Actual size',exact:true}).click();await expect(page.getByRole('img',{name:/sample preview$/})).toHaveAttribute('tabindex','0');await page.getByRole('button',{name:'Fit preview',exact:true}).click();checks++;
   await picker.selectOption(width<768?'chat-poll':'opponent');await page.getByRole('button',{name:'Replay sample',exact:true}).click();await page.waitForTimeout(150);await page.screenshot({path:`../../docs/handoff/screenshots/widget-playground-${theme}-${width}.png`});
   expect(await page.evaluate(()=>window.previewAttempts)).toEqual([]);expect(errors).toEqual([]);checks++;
   await page.goto(`${origin}/settings?tab=overlay&section=widgets&widget=opponent&theme=${theme}`);const card=page.locator('[data-widget-id="opponent"]');const preview=card.getByRole('button',{name:/^Preview .* locally$/});await preview.click();const dialog=page.getByRole('dialog',{name:/playground/i});await expect(dialog.getByRole('region',{name:'Widget playground'})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await dialog.getByRole('button',{name:'Close',exact:true}).click();await expect(preview).toBeFocused();checks++;
   await page.goto(`${origin}/learn?widget=ghost-build&theme=${theme}`);await page.getByRole('article',{name:'Ghost Build coach guide'}).locator('figure').scrollIntoViewIfNeeded();await expect(page.getByRole('article',{name:'Ghost Build coach guide'}).getByRole('region',{name:'Widget playground'})).toBeVisible();checks++;
   await page.goto(`${origin}/stream-studio?theme=${theme}`);await page.locator('#widget-playground').scrollIntoViewIfNeeded();await expect(page.locator('#widget-playground').getByRole('region',{name:'Widget playground'})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);checks++;
   expect(errors).toEqual([]);await context.close();console.log(JSON.stringify({width,theme,checks}));
  }
  expect(unexpectedWrites).toEqual([]);console.log(`${checks} real playground browser checks passed; local samples opened zero network/audio transports`);
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;server.close();});
