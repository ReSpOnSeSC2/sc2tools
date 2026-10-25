/* Run after the production build. Every request is loopback/synthetic. No
 * account, OAuth provider, Twitch prediction, marker, OBS or installer runs. */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process'), { chromium, expect } = require('@playwright/test');
const { sanitizeTwitchAutomation } = require(path.resolve('../api/src/services/twitchAutomationPolicy'));
const root = process.cwd(), shots = '../../docs/handoff/screenshots', calls = [], unexpected = [], blocked = [], prefs = new Map();
let origin, scenario = 'off', prediction = null, checks = 0, captures = 0, holdPost = false, releasePost;
const cssNames = fs.readdirSync('.next/static/css', { recursive: true }).filter(name => name.endsWith('.css'));
const css = cssNames.map(name => fs.readFileSync(path.join('.next/static/css', name), 'utf8')).join('\n');
const fonts = `@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay}`;
const active = () => ({ gameKey: 'synthetic-current-game', prediction: 'active', marker: 'created', canCancel: true, canResolve: false, reason: null, deadlineAt: null });
function status(owner) { return { preferences: prefs.get(owner) || sanitizeTwitchAutomation({}), serverEnabled: scenario !== 'off', configured: true, connected: true, predictionPermission: true, markerPermission: true, eligible: scenario === 'off' ? null : true, isLive: true, reason: scenario === 'off' ? 'server_not_enabled' : null, rankedQueueSupported: false, capabilityReason: 'ranked_status_unavailable', current: prediction }; }
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, origin || 'http://127.0.0.1'), p = url.pathname;
  const json = (body, code = 200) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
  if (p.startsWith('/v1/')) {
    const owner = String(req.headers.authorization || '').replace(/^Bearer /, ''), call = { path: p, method: req.method, owner }; calls.push(call);
    if (p === '/v1/me/twitch-automation') return json(status(owner));
    if (p === '/v1/me/preferences/twitchAutomation' && req.method === 'PUT') { const parts = []; for await (const chunk of req) parts.push(chunk); call.body = JSON.parse(Buffer.concat(parts).toString()); const value = sanitizeTwitchAutomation(call.body, true); prefs.set(owner, value); return json(value); }
    if (p === '/v1/me/integrations/twitch/connect' && req.method === 'POST') { const parts = []; for await (const chunk of req) parts.push(chunk); call.body = JSON.parse(Buffer.concat(parts).toString()); return json({ authorizeUrl: 'https://id.twitch.tv/oauth2/authorize?state=synthetic-only&scope=' + encodeURIComponent(call.body.purpose === 'predictions' ? 'channel:manage:predictions' : 'channel:manage:broadcast') }); }
    if (/^\/v1\/multichat\/synthetic-[ab]\/twitch-automation$/.test(p)) {
      const token = p.split('/')[3];
      if (req.method === 'POST') { const parts = []; for await (const chunk of req) parts.push(chunk); call.body = JSON.parse(Buffer.concat(parts).toString()); if (holdPost) { holdPost = false; await new Promise(resolve => { releasePost = resolve; }); } prediction = { ...prediction, prediction: call.body.action === 'cancel' ? 'canceled' : 'resolved', canCancel: false, canResolve: false }; return json({ current: prediction }); }
      const value = status(token); return json({ current: value.current, serverEnabled: value.serverEnabled, reason: value.reason, predictionsEnabled: value.preferences.predictionsEnabled, markersEnabled: value.preferences.markersEnabled });
    }
    unexpected.push(call); return json({}, 404);
  }
  if (p === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync('.tmp/twitch-automation-fixture.js')); }
  if (p === '/fixture') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(`<!doctype html><html lang="en" data-theme="${url.searchParams.get('theme') === 'dark' ? 'dark' : 'light'}"><head><title>Local Twitch automation proof</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${fs.existsSync('.tmp/twitch-automation-fixture.css') ? fs.readFileSync('.tmp/twitch-automation-fixture.css', 'utf8') : ''}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`); }
  const base = p.startsWith('/fonts/') ? path.join(root, 'app/fonts') : path.join(root, 'public'), file = path.resolve(base, p.startsWith('/fonts/') ? p.slice(7) : p.slice(1));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', ({ '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
});
async function noOverflow(page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); checks++; }
async function shot(page, name, target) { await target.scrollIntoViewIfNeeded(); await page.evaluate(() => document.fonts.ready); expect(await target.evaluate(node => { const r = node.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; })).toBe(true); await page.screenshot({ path: `${shots}/twitch-automation-${name}.png`, fullPage: /^(settings|server-off)-/.test(name) }); captures++; checks++; }
const writes = () => calls.filter(row => row.method === 'PUT');
(async () => {
  fs.mkdirSync(shots, { recursive: true }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  execFileSync(process.execPath, ['tests/manual/twitch-automation-fixture.cjs'], { stdio: 'inherit', env: { ...process.env, TWITCH_FIXTURE_ORIGIN: origin } });
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [300, 320, 390, 768, 1440]) for (const theme of ['light', 'dark']) {
      prefs.clear(); prediction = null; scenario = 'off'; const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', hasTouch: width < 1000, isMobile: width < 1000 });
      await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : (blocked.push(route.request().url()), route.abort()));
      const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/fixture?theme=${theme}`); await expect(page.getByText(/paused by the server owner/)).toBeVisible(); await expect(page.getByRole('button', { name: 'Reconnect Predictions' })).toBeDisabled(); checks += 2;
      expect(await page.getByRole('switch').count()).toBe(2); await expect(page.getByRole('switch').first()).toBeDisabled(); checks += 2; await noOverflow(page);
      if (width === 320 || width === 1440) await shot(page, `server-off-${theme}-${width}`, page.getByRole('heading', { name: 'Twitch automation', exact: true }));
      scenario = 'ready'; await page.getByRole('button', { name: 'Refresh status' }).click(); const marker = page.getByRole('switch', { name: 'Add a stream marker at each game start' }); await expect(marker).toBeEnabled();
      for (const control of [marker, page.getByRole('button', { name: 'Refresh status' })]) { expect(await control.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44); checks++; }
      await page.getByRole('button', { name: 'Refresh status' }).focus(); await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: 'Reconnect Predictions' })).toBeFocused(); checks++;
      const before = writes().length; await marker.click(); expect(writes()).toHaveLength(before); checks++;
      await page.getByLabel('Prediction window (30–300 seconds)').fill('29'); await expect(page.getByRole('button', { name: 'Save Twitch automation' })).toBeDisabled(); await page.getByLabel('Prediction window (30–300 seconds)').fill('120'); checks++;
      await page.getByLabel('Prediction title template').fill('{unsupported}'); await expect(page.getByRole('button', { name: 'Save Twitch automation' })).toBeDisabled(); await page.getByLabel('Prediction title template').fill('Will {me} beat {opp} ({oppRace} {oppMmr})?'); checks++;
      await page.getByRole('button', { name: 'Save Twitch automation' }).click(); await expect(page.getByText('Twitch automation preferences saved.')).toBeVisible(); expect(prefs.get('synthetic-a')).toMatchObject({ markersEnabled: true, predictionsEnabled: false }); checks++;
      await page.getByRole('button', { name: 'Reconnect Predictions' }).click(); await expect(page.getByText(/Complete the Twitch connection in its window/)).toBeVisible(); expect(calls.filter(row => row.path.endsWith('/connect')).at(-1).body).toEqual({ purpose: 'predictions' }); expect((await page.evaluate(() => window.fixturePopupUrls))[0]).toMatch(/^https:\/\/id\.twitch\.tv\/oauth2\/authorize/); checks += 2;
      await page.getByRole('button', { name: 'Reconnect markers' }).click(); await expect.poll(() => calls.filter(row => row.path.endsWith('/connect')).at(-1).body.purpose).toBe('streaming'); await expect.poll(async () => (await page.evaluate(() => window.fixturePopupUrls)).length).toBe(2); checks += 2;
      expect(writes()).toHaveLength(before + 1); checks++; await noOverflow(page); await shot(page, `settings-${theme}-${width}`, page.getByRole('heading', { name: 'Twitch automation', exact: true }));
      // Hold the real hook's next JWT, switch owner, and release a token for B.
      await page.evaluate(() => window.fixtureHoldJwt()); await marker.click(); await page.getByRole('button', { name: 'Save Twitch automation' }).click(); await page.evaluate(() => window.fixtureAuth('synthetic-b')); await expect(marker).toHaveAttribute('aria-checked', 'false'); await page.evaluate(() => window.fixtureReleaseJwt('synthetic-b')); expect(writes()).toHaveLength(before + 1); checks += 2;
      prediction = active(); const dock = await context.newPage(); dock.on('pageerror', error => errors.push(error.message)); await dock.goto(`${origin}/fixture?view=dock&theme=${theme}`); await expect(dock.getByText('Prediction · Open', { exact: true })).toBeVisible();
      const cancel = dock.getByRole('button', { name: 'Cancel / refund' }); await cancel.click(); const dialog = dock.getByRole('dialog'); await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused(); const postBefore = calls.filter(row => row.method === 'POST' && row.path.includes('/multichat/')).length; await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(cancel).toBeFocused(); expect(calls.filter(row => row.method === 'POST' && row.path.includes('/multichat/'))).toHaveLength(postBefore); checks += 3;
      await cancel.click(); await noOverflow(dock); await shot(dock, `confirm-refund-${theme}-${width}`, dock.getByRole('dialog')); await dock.getByRole('button', { name: 'Request refund' }).click(); await expect(dock.getByText('Twitch confirmed cancellation and refunded the prediction.')).toBeVisible(); expect(calls.filter(row => row.method === 'POST' && row.path.includes('/multichat/')).at(-1).body).toEqual({ action: 'cancel', gameKey: 'synthetic-current-game', confirmed: true }); checks += 2;
      await noOverflow(dock); await shot(dock, `dock-confirmed-${theme}-${width}`, dock.getByRole('heading', { name: 'Twitch Channel Points' }));
      prediction = active(); await dock.evaluate(() => window.fixtureToken('synthetic-b')); await expect(dock.getByText('Prediction · Open')).toBeVisible(); holdPost = true; releasePost = null;
      await dock.getByRole('button', { name: 'Cancel / refund' }).click(); await dock.getByRole('button', { name: 'Request refund' }).click(); await expect.poll(() => typeof releasePost).toBe('function');
      const waiting = dock.getByText('Waiting for Twitch confirmation…', { exact: true }); await expect(waiting).toBeFocused(); await dock.keyboard.press('Escape'); await expect(waiting).toBeFocused(); await dock.mouse.click(1, 1); await expect(waiting).toBeFocused(); checks += 3;
      if (width === 320 || width === 1440) await shot(dock, `busy-confirmation-${theme}-${width}`, dock.getByRole('dialog'));
      releasePost(); await expect(dock.getByText('Twitch confirmed cancellation and refunded the prediction.')).toBeVisible();
      prediction = { ...active(), prediction: 'unknown', canCancel: false, reason: 'provider_unconfirmed' }; await dock.evaluate(() => window.fixtureToken('synthetic-a')); await expect(dock.getByText('Prediction · Unconfirmed')).toBeVisible(); await expect(dock.getByRole('button', { name: 'Cancel / refund' })).toHaveCount(0); await expect(dock.getByText(/prediction ID was not confirmed/)).toBeVisible(); checks += 3;
      if (width === 320 || width === 1440) await shot(dock, `unconfirmed-${theme}-${width}`, dock.getByRole('heading', { name: 'Twitch Channel Points' }));
      if (width === 320 || width === 1440) { const guide = await context.newPage(); guide.on('pageerror', error => errors.push(error.message)); await guide.goto(`${origin}/fixture?view=guide&theme=${theme}#twitch-predictions`); const article = guide.getByRole('article', { name: 'Twitch Predictions & game markers guide' }); await expect(article).toContainText('cannot prove ranked queue status'); await noOverflow(guide); await shot(guide, `learn-${theme}-${width}`, article.getByRole('heading', { name: 'Twitch Predictions & game markers' })); checks++; }
      expect(errors).toEqual([]); checks++; await context.close();
    }
    expect(unexpected).toEqual([]); expect(blocked).toEqual([]); checks += 2;
    console.log(JSON.stringify({ checks, captures, widths: [300, 320, 390, 768, 1440], themes: ['light', 'dark'], productionCss: cssNames, externalRequests: blocked.length, unexpectedApi: unexpected.length, boundary: 'Real Settings/Dock/Learn + productionCSS/fonts; explicit local Clerk/Next/Twitch API + popup boundary, no provider/OBS/account action' }, null, 2));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
