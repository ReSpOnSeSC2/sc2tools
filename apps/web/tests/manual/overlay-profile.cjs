/* Real SettingsShell, profile draft, widget cards and three overlay surfaces.
 * Only synthetic loopback APIs and explicit Next/Clerk/socket boundaries.
 * Run after the production build: node tests/manual/overlay-profile.cjs
 */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process'), { chromium, expect } = require('@playwright/test');
execFileSync(process.execPath, ['tests/manual/overlay-profile-fixture.cjs'], { stdio: 'inherit' });
const root = process.cwd(), origin = 'http://127.0.0.1:3252', token = 'synthetic-local-overlay-token', otherToken = 'synthetic-other-overlay-token';
const cssFiles = fs.readdirSync('.next/static/css').filter(name => name.endsWith('.css'));
const css = cssFiles.map(name => fs.readFileSync(path.join('.next/static/css', name), 'utf8')).join('\n');
const fonts = `@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay}`;
const empty = () => ({ profile: { v: 1, theme: {}, widgetOptions: {} }, profileRevision: 0 });
const profiles = new Map(), calls = [], unexpectedWrites = []; let checks = 0;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, origin), pathname = url.pathname;
  const json = (value, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (pathname.startsWith('/v1/')) {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    calls.push({ path: pathname, method: req.method, body, owner: req.headers.authorization });
    const selectedToken = req.headers.authorization === 'Bearer synthetic:synthetic-owner-b' ? otherToken : token;
    if (pathname === '/v1/overlay-tokens') return json({ items: [{ token: selectedToken, label: 'Local fixture', createdAt: '2026-10-25', enabledWidgets: ['session', 'scouting', 'mmr-delta'], ...(profiles.get(selectedToken) || empty()) }] });
    if (pathname === `/v1/overlay-tokens/${selectedToken}/profile` && req.method === 'PUT') {
      const previous = profiles.get(selectedToken) || empty(); if (previous.profileRevision !== body.expectedRevision) return json({ error: { code: 'overlay_profile_changed' } }, 409);
      const next = { profile: body.profile, profileRevision: previous.profileRevision + 1 }; profiles.set(selectedToken, next); return json(next);
    }
    if (req.method !== 'GET') { unexpectedWrites.push({ path: pathname, method: req.method }); return json({ error: { code: 'write_blocked' } }, 405); }
    if (pathname === '/v1/seasons') return json({ items: [], current: null });
    if (pathname === '/v1/site/banner') return json({ banner: null });
    if (pathname === '/v1/ping') return json({ ok: true });
    if (pathname === '/v1/me') return json({ userId: 'synthetic-owner-a', isAdmin: false, agentLastSeenAt: new Date().toISOString(), games: { total: 14, latest: new Date().toISOString() } });
    if (pathname === '/v1/me/profile') return json({ displayName: 'Fixture player' });
    if (pathname === '/v1/me/preferences/multichat') return json({ twitch: { enabled: false, channel: 'fixturechannel' } });
    if (pathname === '/v1/me/chatbot') return json({ enabled: false, username: '', channel: '', hasToken: false, status: { state: 'off' } });
    if (pathname === '/v1/me/integrations') return json({ platforms: [] });
    if (pathname.endsWith('/unread-count')) return json({ count: 0 });
    if (pathname === '/v1/coaching/me') return json({ role: 'none' });
    if (pathname === '/v1/coaching/alerts') return json({ pending: 0, items: [] });
    return json({});
  }
  if (pathname === '/api/site/stats') return json({ agentDownloads: 42, activeAgents: 1, activeUsers: 1 });
  if (pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync('.tmp/overlay-profile-fixture.js')); }
  if (pathname === '/settings' || pathname.startsWith('/overlay/')) {
    const theme = url.searchParams.get('uiTheme') === 'dark' ? 'dark' : 'light', initial = profiles.get(pathname.split('/')[2]) || empty();
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(`<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${fonts}</style></head><body><div id="root"></div><script>window.fixtureInitial=${JSON.stringify(initial)}</script><script src="/fixture.js"></script></body></html>`);
  }
  const base = pathname.startsWith('/fonts/') ? path.join(root, 'app/fonts') : path.join(root, 'public'), file = path.resolve(base, pathname.startsWith('/fonts/') ? pathname.slice(7) : pathname.slice(1));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', ({ '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
});
const pointHit = locator => locator.evaluate(node => { const rect = node.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return { hit: !!hit && (hit === node || node.contains(hit)), height: rect.height }; });

(async () => {
  await new Promise(resolve => server.listen(3252, '127.0.0.1', resolve)); const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [320, 390, 768, 1440]) for (const theme of ['light', 'dark']) {
      profiles.clear(); profiles.set(token, empty()); profiles.set(otherToken, empty()); calls.length = 0;
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
      await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
      await context.addInitScript(token => localStorage.setItem(`sc2tools:overlay-theme:${token}`, JSON.stringify({ accent: '#fedcba' })), token);
      const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/settings?tab=overlay&section=look&uiTheme=${theme}`); const nav = page.getByRole('navigation', { name: 'Overlay settings sections' });
      await expect(page.getByRole('heading', { name: 'Move your theme to your overlay' })).toBeVisible(); expect(calls.filter(call => call.method === 'PUT')).toHaveLength(0); checks++;
      if (width === 320 && theme === 'dark' || width === 1440 && theme === 'light') { await page.getByRole('heading', { name: 'Move your theme to your overlay' }).evaluate(node => scrollTo(0, node.getBoundingClientRect().top + scrollY - 150)); await page.screenshot({ path: `../../docs/handoff/screenshots/overlay-profile-migration-${theme}-${width}.png` }); }
      await page.getByRole('button', { name: 'Use previous theme', exact: true }).click(); await expect(page.getByLabel('Accent hex value')).toHaveValue('#fedcba'); expect(calls.filter(call => call.method === 'PUT')).toHaveLength(0); checks++;
      await page.getByLabel('Accent hex value').fill('#abcdef'); await nav.getByRole('link', { name: 'Widgets', exact: true }).click();
      await page.getByRole('searchbox', { name: 'Find a widget' }).fill('MMR delta'); const card = page.locator('[data-widget-id="mmr-delta"]'), display = card.getByRole('button', { name: 'Display for MMR delta', exact: true });
      await display.click(); const select = page.getByLabel('Display time for MMR delta'); await expect(select).toBeVisible();
      expect(await select.locator('option').allTextContents()).toEqual(['Default (10s)', '5s', '10s', '15s', '20s', '30s', '45s', '60s']);
      const hit = await pointHit(select); expect(hit.hit).toBe(true); expect(hit.height).toBeGreaterThanOrEqual(44); checks++;
      await select.selectOption('45'); await page.keyboard.press('Escape'); await expect(display).toHaveAttribute('aria-expanded', 'false'); await expect(display).toBeFocused(); checks++;
      await card.getByRole('button', { name: 'Copy', exact: true }).click(); const copied = new URL(await page.evaluate(() => navigator.clipboard.readText())); expect(copied.searchParams.has('theme')).toBe(false); checks++;
      const save = page.getByRole('button', { name: 'Save overlay display', exact: true }); await expect(save).toBeVisible(); expect((await pointHit(save)).height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); checks++;
      if (width === 320 && theme === 'dark' || width === 1440 && theme === 'light') await page.screenshot({ path: `../../docs/handoff/screenshots/overlay-profile-save-${theme}-${width}.png` });
      await save.click(); await expect(page.getByText(/Overlay display saved/)).toBeVisible(); const request = calls.find(call => call.method === 'PUT');
      expect(request.body).toEqual({ profile: { v: 1, theme: { accent: '#abcdef' }, widgetOptions: { 'mmr-delta': { durationSec: 45 } } }, expectedRevision: 0 }); await expect(page.getByRole('region', { name: 'Unsaved changes' })).toHaveCount(0); checks++;
      await page.reload(); await expect(page.getByRole('heading', { name: 'Move your theme to your overlay' })).toHaveCount(0); await page.getByRole('searchbox', { name: 'Find a widget' }).fill('MMR delta'); await display.click(); await expect(select).toHaveValue('45'); checks++;
      await page.evaluate(() => document.fonts.ready); await card.evaluate(node => scrollTo(0, node.getBoundingClientRect().top + scrollY - 150)); await page.screenshot({ path: `../../docs/handoff/screenshots/overlay-profile-display-${theme}-${width}.png` });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); checks++;
      await page.keyboard.press('Escape'); await page.getByRole('searchbox', { name: 'Find a widget' }).fill('Session record'); await page.locator('[data-widget-id="session"]').getByRole('button', { name: 'Display for Session record', exact: true }).click(); await expect(page.getByLabel('Display time for Session record')).toBeDisabled(); await expect(page.getByText('This widget controls its own visibility or stays on screen. A display-time override does not apply.', { exact: true })).toBeVisible(); await page.keyboard.press('Escape'); checks++;
      await nav.getByRole('link', { name: 'Look', exact: true }).click(); await expect(page.getByLabel('Accent hex value')).toHaveValue('#abcdef');
      await page.getByRole('heading', { name: 'Overlay theme', exact: true }).evaluate(node => scrollTo(0, node.getBoundingClientRect().top + scrollY - 150)); await page.screenshot({ path: `../../docs/handoff/screenshots/overlay-profile-look-${theme}-${width}.png` }); checks++;
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); checks++;
      await page.getByLabel('Accent hex value').fill('#123456'); await page.getByRole('tab', { name: 'Profile', exact: true }).click(); const guard = page.getByRole('dialog'); await expect(guard).toBeVisible(); await guard.getByRole('button', { name: /Keep editing|Stay/, exact: false }).click(); checks++;
      await page.getByRole('button', { name: 'Discard', exact: true }).click(); await expect(page.getByLabel('Accent hex value')).toHaveValue('#abcdef'); checks++;
      await page.evaluate(() => window.fixtureAuth('synthetic-owner-b')); await expect(page.getByLabel('Accent hex value')).toHaveValue(''); await expect(page.getByRole('region', { name: 'Unsaved changes' })).toHaveCount(0); checks++;
      expect(errors).toEqual([]); console.log(JSON.stringify({ width, theme, checks })); await context.close();
    }
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }); await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    for (const suffix of ['', '/widget/mmr-delta', '/scene/between-games']) {
      const page = await context.newPage(); await page.clock.install(); await page.goto(`${origin}/overlay/${token}${suffix}`); await page.waitForFunction(() => window.fixtureProfileReady === true);
      await page.evaluate(() => window.fixtureConfig({ v: 1, theme: { accent: '#abcdef' }, widgetOptions: { 'mmr-delta': { durationSec: 45 } } }, 2));
      if (!suffix.includes('/scene/')) await page.evaluate(() => window.fixtureLive({ gameKey: 'synthetic-initial', mmrDelta: 18, myMmr: 4218 }));
      await expect(page.locator('[style*="--ov-accent"]').first()).toHaveCSS('--ov-accent', '#abcdef'); checks++;
      await page.evaluate(() => window.fixtureConfig({ v: 1, theme: { accent: '#000000' }, widgetOptions: {} }, 1)); await expect(page.locator('[style*="--ov-accent"]').first()).toHaveCSS('--ov-accent', '#abcdef'); checks++;
      if (!suffix.includes('/scene/')) {
        await page.evaluate(() => window.fixtureLive({ gameKey: 'synthetic-one', mmrDelta: 18, myMmr: 4218 })); await expect(page.getByText('+18', { exact: true })).toBeVisible(); await page.clock.runFor(11_000); await expect(page.getByText('+18', { exact: true })).toBeVisible(); await page.clock.runFor(34_000); await expect(page.getByText('+18', { exact: true })).toHaveCount(0); checks++;
        for (const [duration, revision] of [[60, 3], [5, 4]]) { await page.evaluate(({ duration, revision }) => { window.fixtureConfig({ v: 1, theme: { accent: '#abcdef' }, widgetOptions: { 'mmr-delta': { durationSec: duration } } }, revision); window.fixtureLive({ gameKey: 'sample', mmrDelta: 18, isTest: true, testWidget: 'mmr-delta', testNonce: revision }); }, { duration, revision }); await expect(page.getByText('+18', { exact: true })).toBeVisible(); await page.clock.runFor(Math.min(duration, 20) * 1000 - 1); await expect(page.getByText('+18', { exact: true })).toBeVisible(); await page.clock.runFor(1); await expect(page.getByText('+18', { exact: true })).toHaveCount(0); checks++; }
      }
      await page.goto(`${origin}/overlay/${token}${suffix}?theme=`); await page.waitForFunction(() => window.fixtureProfileReady === true); await page.evaluate(() => window.fixtureConfig({ v: 1, theme: { accent: '#abcdef' }, widgetOptions: {} }, 3));
      if (!suffix.includes('/scene/')) await page.evaluate(() => window.fixtureLive({ gameKey: 'synthetic-two', mmrDelta: 18 }));
      expect(await page.locator('[style*="--ov-accent:"]').count()).toBe(0); checks++; await page.close();
    }
    await context.close(); expect(unexpectedWrites).toEqual([]); console.log(JSON.stringify({ checks, screenshots: 20, cssFiles, externalNetwork: 'blocked' }));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
