/* Real settings/chrome/SWR; only explicit Next/Clerk/socket boundaries and loopback synthetic APIs.
 * Run from apps/web after the production build: node tests/manual/widget-manager.cjs
 */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process'), { chromium, expect } = require('@playwright/test');
execFileSync(process.execPath, ['tests/manual/widget-manager-fixture.cjs'], { stdio: 'inherit' });
const root = process.cwd(), origin = 'http://127.0.0.1:3240';
const css = fs.readdirSync('.next/static/css', { recursive: true }).filter(name => name.endsWith('.css')).map(name => fs.readFileSync(path.join('.next/static/css', name), 'utf8')).join('\n');
const extra = fs.existsSync('.tmp/widget-manager-fixture.css') ? fs.readFileSync('.tmp/widget-manager-fixture.css', 'utf8') : '';
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
  if (pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync('.tmp/widget-manager-fixture.js')); }
  if (pathname === '/settings') { const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light'; res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(`<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${extra}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`); }
  const base = pathname.startsWith('/fonts/') ? path.join(root, 'app/fonts') : path.join(root, 'public'), file = path.resolve(base, pathname.startsWith('/fonts/') ? pathname.slice(7) : pathname.slice(1));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', ({ '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
});

(async () => {
  await new Promise(resolve => server.listen(3240, '127.0.0.1', resolve)); const browser = await chromium.launch({ headless: true }); let checks = 0;
  try {
    for (const width of [320, 390, 768, 1440]) for (const theme of ['light', 'dark']) {
      enabled = ['session', 'randomizer'];
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] }); await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
      const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/settings?tab=overlay&section=widgets&widget=session&theme=${theme}`);
      const card = page.locator('[data-widget-id="session"]'); await expect(card.getByRole('button', { name: 'Copy', exact: true })).toBeFocused(); checks++;
      await expect(card.locator('code')).not.toContainText(secret); await expect(card.getByText('Recommended 480 × 360')).toBeVisible(); checks++;
      await card.getByRole('button', { name: 'Copy', exact: true }).click(); expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(`/overlay/${secret}/widget/session`); checks++;
      await card.getByRole('button', { name: 'Reveal', exact: true }).click(); await expect(card.locator('code')).toContainText(secret); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await card.getByRole('button', { name: 'Hide URL', exact: true }).click(); await expect(card.locator('code')).not.toContainText(secret); checks++;
      const drag = new URL(await card.getByRole('link', { name: 'Drag into OBS', exact: true }).getAttribute('href')); expect(drag.searchParams.get('layer-width')).toBe('480'); expect(drag.searchParams.get('layer-height')).toBe('360'); checks++;
      const controls = await card.locator('button').evaluateAll(nodes => nodes.filter(node => getComputedStyle(node).display !== 'none').map(node => ({ label: node.textContent, h: node.getBoundingClientRect().height }))); expect(controls.filter(node => /Copy|Copied|Reveal|Test/.test(node.label)).every(node => node.h >= 44)).toBe(true); checks++;
      await page.getByRole('searchbox', { name: 'Find a widget' }).fill('session'); await expect(page.locator('[data-widget-id]')).toHaveCount(2); await page.getByRole('checkbox', { name: 'Enabled only', exact: true }).check(); await expect(page.locator('[data-widget-id]')).toHaveCount(1); checks++;
      await card.getByRole('button', { name: 'Test', exact: true }).click(); const liveDialog = page.getByRole('dialog', { name: "Send sample data while you're playing?" }); await expect(liveDialog).toBeVisible(); await expect(liveDialog.getByRole('link', { name: /Preview here instead/ })).toHaveAttribute('href', /demo=1/); await liveDialog.getByRole('button', { name: 'Cancel', exact: true }).click(); checks++;
      await page.getByRole('searchbox', { name: 'Find a widget' }).fill(''); await page.getByRole('checkbox', { name: 'Enabled only', exact: true }).uncheck();
      await page.getByRole('button', { name: 'Your first stream', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'Enable your first stream?' }); await expect(dialog).toBeVisible(); await expect(dialog.getByText(/Session record.*already enabled/)).toBeVisible(); const before = calls.filter(call => call.method === 'PUT').length; await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(calls.filter(call => call.method === 'PUT')).toHaveLength(before); expect(new URL(page.url()).searchParams.has('pack')).toBe(false); checks++;
      await page.getByRole('button', { name: 'Your first stream', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Enable setup', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); expect(enabled).toContain('randomizer'); expect(enabled).toContain('opponent'); checks++;
      const nav = page.getByRole('navigation', { name: 'Overlay settings sections' }); await nav.getByRole('link', { name: 'Chat & alerts', exact: true }).click(); const rank = page.getByLabel(/Loyalty rank theme/); await expect(rank).toBeVisible(); await rank.selectOption('zerg'); await nav.getByRole('link', { name: 'Look', exact: true }).click(); await nav.getByRole('link', { name: 'Chat & alerts', exact: true }).click(); await expect(rank).toHaveValue('zerg'); checks++;
      await nav.getByRole('link', { name: 'Setup', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Add Stream Dock to OBS', exact: true })).toBeVisible(); await expect(page.locator('#stream-dock code')).not.toContainText(secret); checks++;
      await page.goto(`${origin}/settings?tab=overlay&section=widgets&theme=${theme}`); await page.getByRole('searchbox', { name: 'Find a widget' }).fill('opponent'); await page.evaluate(() => document.fonts.ready); await page.locator('[data-widget-id="opponent"]').evaluate(node => scrollTo(0, node.getBoundingClientRect().top + scrollY - 144)); await page.screenshot({ path: `../../docs/handoff/screenshots/widget-manager-${theme}-${width}.png` });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]); checks++;
      console.log(JSON.stringify({ width, theme, checks })); await context.close();
    }
    expect(unexpectedWrites).toEqual([]); console.log(`${checks} real widget-manager browser checks passed; only synthetic loopback mutations allowed, all nonlocal traffic blocked`);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error.message); process.exitCode = 1; server.close(); });
