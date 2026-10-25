/* Run from apps/web after final production CSS: node tests/manual/chat-commands.cjs
 * Real UI/hook/SWR with a local ChatCommandService and deterministic stat lines.
 * Production CSS/fonts; every nonlocal browser request blocked. No provider,
 * actual account, database or chat-send call. Defaults:320/390/768/1440, both
 * themes. CHAT_WIDTHS can narrow a diagnostic rerun; final proof uses defaults. */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium, expect } = require('@playwright/test');
const buildFixture = require('./chat-commands-fixture.cjs');
const { ChatCommandService } = require(path.resolve(process.cwd(), '../api/src/services/chatCommandService'));
const registry = require(path.resolve(process.cwd(), '../api/src/services/chatCommands'));
const root = process.cwd(), origin = 'http://127.0.0.1:3269', shots = '../../docs/handoff/screenshots';
const css = fs.readdirSync('.next/static/css', { recursive: true }).filter(name => name.endsWith('.css')).map(name => fs.readFileSync(path.join('.next/static/css', name), 'utf8')).join('\n');
const fonts = `@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay}`;
let javascript = '', preferences = new Map(), checks = 0, captures = 0;
const requests = [], unexpected = [];
const stats = { mmr: '4200 MMR (+50 this session)', record: 'Today: 4W-2L | PvZ 3W-1L, PvP 1W-1L.', opponent: 'Synthetic rival · 2W-1L', streak: '2 wins in a row', winrate: 'PvZ: 75% (n=4) in 30 days; 70% (n=10) this season.' };
const commands = () => new ChatCommandService({
  overlayTokens: { resolve: async token => /^synthetic-overlay-[AB]$/.test(token) ? { userId: token.slice(-1) } : null },
  users: { getPreferences: async owner => preferences.get(owner) || { builtins: [], custom: [] } },
  chatbot: { commandLine: async (_token, command) => stats[command] || `Recorded ${command} reply.` },
});
let composer = commands();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, origin), p = url.pathname;
  const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'private,no-store' }); res.end(JSON.stringify(value)); };
  if (p.startsWith('/v1/')) {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const owner = /^Bearer synthetic-jwt-[AB]$/.test(req.headers.authorization || '') ? req.headers.authorization.slice(-1) : null;
    requests.push({ path: p, method: req.method, body, owner });
    if (p === '/v1/me/preferences/chatCommands') {
      if (!owner) return json({ error: { code: 'synthetic_auth_required' } }, 401);
      if (req.method === 'GET') return json(preferences.get(owner) || { builtins: [], custom: [] });
      if (req.method === 'PUT') { try { const saved = registry.sanitizeChatCommands(body, true); preferences.set(owner, saved); return json(saved); } catch { return json({ error: { message: 'Use valid command settings.' } }, 400); } }
    }
    if (p === '/v1/me/chat-commands/try' && req.method === 'POST') {
      if (!owner) return json({ error: { code: 'synthetic_auth_required' } }, 401);
      const reply = await composer.answer(body.token, body, { previewOwner: owner }); return json(reply, reply ? 200 : 404);
    }
    const live = p.match(/^\/v1\/multichat\/([^/]+)\/command$/);
    if (live && req.method === 'POST') { const reply = await composer.answer(live[1], { ...body, onStream: true }); return json(reply, reply ? 200 : 404); }
    unexpected.push({ p, method: req.method }); return json({ error: { code: 'unexpected_fixture_request' } }, 404);
  }
  if (p === '/fixture.js') { res.setHeader('content-type', 'text/javascript'); return res.end(javascript); }
  if (p === '/settings' || p === '/help') { res.setHeader('content-type', 'text/html'); return res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`); }
  const base = p.startsWith('/fonts/') ? path.join(root, 'app/fonts') : path.join(root, 'public');
  const file = path.resolve(base, p.startsWith('/fonts/') ? p.slice(7) : p.slice(1));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('content-type', ({ '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
});
(async () => {
  javascript = await buildFixture(); await new Promise(resolve => server.listen(3269, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const width of process.env.CHAT_WIDTHS ? process.env.CHAT_WIDTHS.split(',').map(Number) : [320, 390, 768, 1440]) for (const theme of ['light', 'dark']) {
      preferences = new Map(); composer = commands(); const start = requests.length;
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
      await context.addInitScript(theme => { const apply = () => { if (document.documentElement) document.documentElement.dataset.theme = theme; }; apply(); document.addEventListener('DOMContentLoaded', apply, { once: true }); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { if (window.fixtureClipboardFails) throw new Error('Synthetic clipboard denied'); window.fixtureCopied = text; } } }); }, theme);
      const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
      const capture = async (name, anchor) => { await anchor.scrollIntoViewIfNeeded(); await expect(anchor).toBeInViewport(); await page.evaluate(() => document.fonts.ready); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: `${shots}/chat-commands-${name}-${theme}-${width}.png` }); checks++; captures++; };
      await page.goto(origin + '/help'); await expect(page.getByText('!winrate [matchup|race]', { exact: true })).toBeVisible();
      expect(requests.length).toBe(start); expect(await page.getByRole('table', { name: 'Chat command settings' }).count()).toBe(0); checks += 2;
      await capture('guide', page.getByRole('heading', { name: 'Viewer engagement', exact: true }));
      await page.goto(origin + '/settings'); const table = page.getByRole('table', { name: 'Chat command settings' }); await expect(table).toBeVisible(); await expect(page.getByRole('button', { name: 'Copy for your bio' })).toBeEnabled();
      expect(requests.slice(start).filter(row => row.method !== 'GET').length).toBe(0); await expect(table.getByRole('row')).toHaveCount(width >= 1024 ? 12 : 11); checks += 2;
      const mmr = table.getByRole('row').filter({ has: page.getByRole('heading', { name: '!mmr', exact: true }) });
      await mmr.getByRole('textbox', { name: 'Alias for !mmr', exact: true }).fill('rating'); await mmr.getByRole('spinbutton', { name: 'Cooldown for !mmr', exact: true }).fill('35');
      await mmr.locator('summary').click(); for (const platform of ['twitch', 'youtube', 'tiktok', 'nightbot']) await mmr.getByRole('checkbox', { name: platform + ' for !mmr', exact: true }).uncheck();
      const streak = page.getByRole('checkbox', { name: 'Enable !streak', exact: true }); await streak.focus(); await page.keyboard.press('Space'); await expect(streak).not.toBeChecked();
      await expect(mmr.getByRole('button', { name: 'Try it · !mmr', exact: true })).toBeDisabled(); expect(requests.slice(start).filter(row => row.method !== 'GET').length).toBe(0); checks += 2;
      await page.getByRole('button', { name: 'Add custom command', exact: true }).click();
      const custom = table.getByRole('row').filter({ has: page.getByRole('heading', { name: 'Custom command 1', exact: true }) });
      await custom.getByRole('textbox', { name: 'Alias for Custom command 1', exact: true }).fill('hello'); await custom.getByRole('textbox', { name: 'Reply for Custom command 1', exact: true }).fill('Hello {user}! {record}');
      await page.getByRole('button', { name: 'Save chat commands', exact: true }).click(); await expect(custom.getByRole('button', { name: 'Try it · Custom command 1', exact: true })).toBeEnabled();
      const saved = requests.filter(row => row.method === 'PUT').at(-1); expect(saved.owner).toBe('A'); expect(saved.body.builtins.find(row => row.id === 'mmr')).toMatchObject({ trigger: 'rating', cooldownSec: 35, platforms: ['kick'] }); expect(saved.body.custom[0].trigger).toBe('hello'); checks += 3;
      await capture('builtins', mmr.getByRole('heading', { name: '!mmr', exact: true }));
      await page.getByRole('textbox', { name: 'Preview viewer', exact: true }).fill('Viewer'); await custom.getByRole('button', { name: 'Try it · Custom command 1', exact: true }).click();
      await expect(page.getByText('Hello Viewer! ' + stats.record, { exact: true })).toBeVisible(); checks++;
      await custom.getByRole('button', { name: 'Copy Nightbot · Custom command 1', exact: true }).click(); await expect.poll(() => page.evaluate(() => window.fixtureCopied)).toContain('/v1/chatbot/synthetic-overlay-A/hello?args=$(querystring)&user=$(querystring $(user))'); checks++;
      await capture('custom', custom.getByRole('heading', { name: 'Custom command 1', exact: true }));
      await page.evaluate(() => { window.fixtureClipboardFails = true; }); await custom.getByRole('button', { name: 'Copy Nightbot · Custom command 1', exact: true }).click();
      const fallback = page.getByRole('textbox', { name: 'Copy this Nightbot snippet', exact: true }); await expect(fallback).toBeFocused(); await expect(fallback).toHaveAttribute('readonly', ''); expect(await fallback.evaluate(node => node.selectionEnd === node.value.length)).toBe(true); checks += 2;
      await capture('preview', fallback);
      await page.getByRole('combobox', { name: 'Preview platform', exact: true }).selectOption('kick'); await mmr.getByRole('button', { name: 'Try it · !mmr', exact: true }).click(); await expect(page.getByText(stats.mmr, { exact: true })).toBeVisible(); checks++;
      await page.getByRole('button', { name: 'Try it · !streak', exact: true }).click(); await expect(page.getByText('This command is disabled for the selected context.', { exact: true })).toBeVisible(); checks++;
      await page.evaluate(() => window.fixtureMessage('!rating')); await expect(page.getByRole('status').filter({ hasText: 'Saved settings' })).toBeVisible(); await expect(page.getByLabel('Fixture live answer')).toHaveText('mmr: ' + stats.mmr); checks++;
      await page.getByRole('button', { name: 'Copy for your bio', exact: true }).click(); const bio = page.getByRole('textbox', { name: 'Copy this bio text', exact: true }); await expect(bio).toHaveValue(/!rating/); expect(await bio.inputValue()).not.toContain('!streak —'); checks++;
      await page.getByRole('button', { name: 'Add custom command', exact: true }).click(); const invalid = table.getByRole('row').filter({ has: page.getByRole('heading', { name: 'Custom command 2', exact: true }) });
      await invalid.getByRole('textbox', { name: 'Alias for Custom command 2', exact: true }).fill('win'); await invalid.getByRole('textbox', { name: 'Reply for Custom command 2', exact: true }).fill('Reserved name');
      const writesBeforeInvalid = requests.filter(row => row.method === 'PUT').length; await page.getByRole('button', { name: 'Save chat commands', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('reserved'); expect(requests.filter(row => row.method === 'PUT').length).toBe(writesBeforeInvalid); await invalid.getByRole('button', { name: 'Remove Custom command 2', exact: true }).click(); await expect(page.getByRole('button', { name: 'Save chat commands', exact: true })).toBeDisabled(); checks += 2;
      const targets = await custom.locator('button,input:not([type=checkbox]),summary').evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().height >= 43.5)); expect(targets).toBe(true); checks++;
      const before = requests.filter(row => row.method !== 'GET').length;
      await page.evaluate(() => { window.fixtureHeldToken = new Promise(resolve => { window.fixtureReleaseToken = resolve; }); });
      await mmr.getByRole('textbox', { name: 'Alias for !mmr', exact: true }).fill('private_alias'); await page.getByRole('button', { name: 'Save chat commands', exact: true }).click();
      await page.evaluate(() => { window.fixtureHeldToken = null; window.fixtureAuth('B'); }); await expect(page.getByRole('textbox', { name: 'Alias for !mmr', exact: true })).toHaveValue('mmr'); await expect(page.getByRole('textbox', { name: 'Reply for Custom command 1', exact: true })).toHaveCount(0); checks += 2;
      await page.evaluate(() => { window.fixtureHeldToken = null; window.fixtureReleaseToken('synthetic-jwt-A'); }); await page.waitForTimeout(100); expect(requests.filter(row => row.method !== 'GET').length).toBe(before); checks++;
      await page.evaluate(() => window.fixtureAuth(null, false)); await expect(page.getByRole('table', { name: 'Chat command settings' })).toHaveCount(0); expect(errors).toEqual([]); checks += 2;
      await context.close(); console.log(JSON.stringify({ width, theme, checks }));
    }
    expect(unexpected).toEqual([]); console.log(JSON.stringify({ checks, captures, nonlocalTraffic: 'blocked', cssFiles: fs.readdirSync('.next/static/css').filter(name => name.endsWith('.css')) }));
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
