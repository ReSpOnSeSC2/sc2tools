/* Real SettingsOverlay/chrome with production CSS. Every API is loopback synthetic;
 * native confirmation and OBS are mocked here and exercised separately with offscreen Qt/fake OBS.
 * Run from apps/web after a production build: node tests/manual/obs-sources.cjs */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process'), { chromium, expect } = require('@playwright/test');
execFileSync(process.execPath, ['tests/manual/obs-sources-fixture.cjs'], { stdio: 'inherit' });
const root = process.cwd(), origin = 'http://127.0.0.1:3247', secret = 'synthetic-local-overlay-token';
const css = fs.readdirSync('.next/static/css', { recursive: true }).filter(name => name.endsWith('.css')).map(name => fs.readFileSync(path.join('.next/static/css', name), 'utf8')).join('\n');
const fonts = `@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureSerif;src:url('/fonts/fraunces-latin-normal.woff2');font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay;--font-serif:FixtureSerif}`;
const devices = [{ id: 'a'.repeat(24), label: 'Local agent 1', supported: true, enabled: true }, { id: 'b'.repeat(24), label: 'Local agent 2', supported: true, enabled: true }];
let catalog = [], ack = 'added', held = null;
const calls = [], unexpectedWrites = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, origin), pathname = url.pathname;
  const json = (value, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (pathname === '/_fixture/control') {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks));
    if (body.catalog) catalog = body.catalog === 'one' ? devices.slice(0, 1) : body.catalog === 'two' ? devices : body.catalog === 'disabled' ? [{ ...devices[0], enabled: false }] : [];
    if (body.ack) ack = body.ack;
    if (body.release && held) { held(); held = null; }
    return json({ ok: true });
  }
  if (pathname.startsWith('/v1/')) {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    calls.push({ path: pathname, method: req.method, body });
    if (pathname === '/v1/seasons') return json({ items: [], current: null, source: 'fallback', fetchedAt: null });
    if (pathname === '/v1/site/banner') return json({ banner: null });
    if (pathname === '/v1/ping') return json({ ok: true });
    if (req.headers.authorization !== 'Bearer synthetic-local-token') return json({ error: { code: 'auth_required' } }, 401);
    if (pathname === '/v1/devices/obs/add-source' && req.method === 'POST') {
      expect(Object.keys(body).sort()).toEqual(['deviceId', 'widget']);
      const respond = () => json({ code: ack === 'hold' ? 'added' : ack, requestId: 'c'.repeat(32), deviceId: body.deviceId });
      if (ack === 'hold') { held = respond; return; } return respond();
    }
    if (req.method !== 'GET') { unexpectedWrites.push({ path: pathname, method: req.method }); return json({ error: { code: 'write_blocked' } }, 405); }
    if (pathname === '/v1/devices/obs') return json({ devices: catalog });
    if (pathname === '/v1/overlay-tokens') return json({ items: [{ token: secret, label: 'Local fixture', createdAt: '2026-10-25T00:00:00Z', lastSeenAt: null, revokedAt: null, enabledWidgets: ['session', 'opponent', 'randomizer'] }] });
    if (pathname === '/v1/me') return json({ userId: 'synthetic-local-fixture', isAdmin: false, games: { total: 14 } });
    if (pathname === '/v1/me/profile') return json({ displayName: 'Fixture player' });
    if (pathname === '/v1/me/preferences/multichat') return json({ twitch: { enabled: false, channel: 'fixturechannel' } });
    if (pathname === '/v1/me/chatbot') return json({ enabled: false, username: '', channel: '', hasToken: false, status: { state: 'off' } });
    if (pathname === '/v1/me/integrations') return json({ platforms: [] });
    if (pathname.endsWith('/unread-count')) return json({ count: 0 });
    if (pathname === '/v1/coaching/me') return json({ role: 'none' });
    if (pathname === '/v1/coaching/alerts') return json({ pending: 0, items: [] });
    return json({});
  }
  if (pathname === '/api/site/stats') return json({ agentDownloads: 42, activeAgents: 1, activeUsers: 1, generatedAt: new Date().toISOString(), activityWindowSeconds: 60 });
  if (pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync('.tmp/obs-sources-fixture.js')); }
  if (pathname === '/settings') { const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light'; res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(`<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`); }
  const base = path.resolve(root, 'public'), file = path.resolve(base, '.' + pathname);
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', ({ '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise(resolve => server.listen(3247, '127.0.0.1', resolve)); const browser = await chromium.launch({ headless: true }); let checks = 0;
  try {
    for (const width of [320, 390, 768, 1440]) for (const theme of ['light', 'dark']) {
      catalog = []; ack = 'added'; held = null;
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
      const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
      const control = body => page.request.post(origin + '/_fixture/control', { data: body });
      const posts = () => calls.filter(call => call.path === '/v1/devices/obs/add-source');
      const beforeGet = calls.filter(call => call.path === '/v1/devices/obs').length;
      await page.goto(`${origin}/settings?tab=overlay&section=widgets&widget=opponent&theme=${theme}`);
      await page.getByRole('searchbox', { name: 'Find a widget' }).fill('opponent');
      const card = page.locator('[data-widget-id="opponent"]'), add = card.getByRole('button', { name: 'Add to OBS', exact: true });
      await expect(add).toBeDisabled(); await expect(page.getByText('Open your paired desktop agent', { exact: false })).toBeVisible(); checks += 2;
      expect(calls.filter(call => call.path === '/v1/devices/obs').length - beforeGet).toBe(1); checks++;
      await control({ catalog: 'disabled' }); await page.getByRole('button', { name: 'Check again', exact: true }).click(); await expect(page.getByText('Enable website OBS requests in an updated desktop agent.', { exact: false })).toBeVisible(); await expect(add).toBeDisabled(); checks += 2;
      await control({ catalog: 'one', ack: 'declined' }); await page.getByRole('button', { name: 'Check again', exact: true }).click(); await expect(add).toBeEnabled();
      await add.scrollIntoViewIfNeeded();
      expect(await add.evaluate(node => { const r = node.getBoundingClientRect(); return r.height >= 44 && r.width >= 44 && node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)); })).toBe(true); checks++;
      const before = posts().length; await add.click(); await expect(page.getByRole('status').filter({ hasText: 'Cancelled on the desktop' })).toBeVisible(); expect(posts()).toHaveLength(before + 1); expect(posts().at(-1).body).toEqual({ widget: 'opponent', deviceId: devices[0].id }); checks += 3;
      await control({ ack: 'scene_changed' }); await add.click(); await expect(page.getByRole('status').filter({ hasText: 'program scene changed' })).toBeVisible(); checks++;
      await control({ ack: 'hold' }); await add.click(); await expect(card.getByRole('button', { name: 'Waiting for desktop…' })).toBeDisabled(); await expect(page.getByRole('status').filter({ hasText: 'Confirm Add source' })).toBeVisible(); checks += 2;
      await page.evaluate(() => document.fonts.ready); await card.evaluate(node => scrollTo(0, node.getBoundingClientRect().top + scrollY - 144));
      await page.screenshot({ path: `../../docs/handoff/screenshots/obs-source-pending-${theme}-${width}.png` });
      await control({ release: true }); await expect(page.getByRole('status').filter({ hasText: 'Source added' })).toBeVisible(); checks++;
      await control({ catalog: 'two', ack: 'already_present' }); const picker = page.getByRole('combobox', { name: 'Desktop agent' });
      // Ready state needs no Retry control: the real shared 30-second poll discovers the second device.
      await expect(picker).toBeVisible({ timeout: 35000 }); await expect(add).toBeDisabled(); await picker.selectOption(devices[1].id); await add.click(); await expect(page.getByRole('status').filter({ hasText: 'already in your current' })).toBeVisible(); expect(posts().at(-1).body.deviceId).toBe(devices[1].id); checks += 4;
      const ownerBefore = posts().length;
      await page.evaluate(() => { window.fixtureHeldToken = new Promise(resolve => { window.fixtureReleaseToken = resolve; }); });
      await add.click(); await page.evaluate(() => window.fixtureAuth('synthetic-local-fixture', false));
      await expect(card).toHaveCount(0); // The real Settings shell withholds private content during auth loading.
      await page.evaluate(() => { window.fixtureReleaseToken('synthetic-local-token'); window.fixtureHeldToken = null; window.fixtureAuth('owner-b'); });
      await expect(page.getByText('Choose a desktop agent first.', { exact: false })).toBeVisible(); expect(posts()).toHaveLength(ownerBefore); expect(await page.getByRole('status').filter({ hasText: 'Source added' }).count()).toBe(0); checks += 3;
      await picker.selectOption(devices[0].id); await control({ ack: 'hold' }); await add.click(); await expect(card.getByRole('button', { name: 'Waiting for desktop…' })).toBeDisabled();
      await expect.poll(() => held !== null).toBe(true);
      await page.evaluate(() => window.fixtureAuth('owner-c')); await control({ release: true }); await expect(page.getByText('Choose a desktop agent first.', { exact: false })).toBeVisible(); expect(await page.getByRole('status').filter({ hasText: 'Source added' }).count()).toBe(0); checks += 2;
      await picker.selectOption(devices[0].id); await card.evaluate(node => scrollTo(0, node.getBoundingClientRect().top + scrollY - 144));
      await expect(add).toBeEnabled(); checks++;
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]); checks += 2;
      await page.screenshot({ path: `../../docs/handoff/screenshots/obs-source-ready-${theme}-${width}.png` });
      await page.getByRole('searchbox', { name: 'Find a widget' }).fill('ghost');
      const ghost = page.locator('[data-widget-id="ghost-build"]');
      await expect(ghost.getByRole('button', { name: 'Add to OBS', exact: true })).toBeDisabled(); await expect(ghost.getByText('Add to OBS cannot include Ghost assignments.', { exact: false })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); checks += 3;
      if (width === 320 && theme === 'light') { await ghost.evaluate(node => scrollTo(0, node.getBoundingClientRect().top + scrollY - 144)); await page.screenshot({ path: '../../docs/handoff/screenshots/obs-source-ghost-light-320.png' }); }
      console.log(JSON.stringify({ width, theme, checks })); await context.close();
    }
    expect(unexpectedWrites).toEqual([]); console.log(`${checks} OBS source browser checks passed; synthetic loopback only, remote traffic blocked.`);
  } finally { await browser.close(); if (held) held(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; server.close(); });
