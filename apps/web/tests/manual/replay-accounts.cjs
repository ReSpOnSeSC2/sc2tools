/* Run after the final production CSS build. Local synthetic APIs only. */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');
execFileSync(process.execPath, ['tests/manual/replay-accounts-fixture.cjs'], { stdio: 'inherit' });
const web = process.cwd(), repo = path.resolve(web, '../..'), origin = 'http://127.0.0.1:3247';
const css = fs.readdirSync('.next/static/css').filter(name => name.endsWith('.css')).map(name => fs.readFileSync(path.join('.next/static/css', name), 'utf8')).join('\n');
const fonts = "@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2')}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2')}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay}body{font-family:FixtureSans,sans-serif}";
const accounts = [{ handle: '2-S2-1-100', label: 'Main', region: 'EU', leagueId: 5, mmr: 4800 }, { handle: '1-S2-1-200', label: 'Practice', region: 'NA', leagueId: null, mmr: null }];
const game = { gameId: 'synthetic-game', date: '2026-10-24T12:00:00Z', result: 'Victory', map: 'Blackrock LE', durationSec: 630, playerCount: 2, matchFormat: '1v1', myRace: 'Protoss', myBuild: 'PvZ - Stargate into Glaives', myMmr: 4700, macroScore: 72, opponent: { displayName: 'Synthetic rival', race: 'Zerg', mmr: 4750 }, matchup: 'PvZ', replayAvailable: false };
let checks = 0;
const csvRequests = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin), send = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (url.pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); return res.end(fs.readFileSync(path.join(repo, '.cache/replay-accounts-fixture.js'))); }
  if (url.pathname.startsWith('/app')) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(`<!doctype html><html data-theme="${url.searchParams.get('theme') === 'light' ? 'light' : 'dark'}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${fonts}</style></head><body class="bg-bg text-text"><div id="root"></div><script src="/fixture.js"></script></body></html>`); }
  if (url.pathname === '/v1/game-accounts') return send({ items: accounts });
  if (url.pathname === '/v1/replays') return send({ profile: { handle: 'synthetic-owner', displayName: 'Synthetic owner' }, items: [game], page: { hasMore: true, nextCursor: 'synthetic-cursor' }, total: 2, summary: { total: 2, wins: 1, losses: 1, ties: 0, avgDurationSec: 630 } });
  if (url.pathname === '/v1/random-summary') return send({ perRace: { Protoss: { games: 2 } } });
  if (url.pathname === '/v1/seasons') return send({ items: [] });
  if (url.pathname === '/v1/me/replay-sharing') return send({ enabled: false, handle: null });
  if (url.pathname === '/v1/me/preferences/analyzerViews') return send({ views: [], defaultViewId: null });
  if (url.pathname === '/v1/export.csv') { csvRequests.push(url.searchParams); res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('X-Export-Truncated', 'true'); res.setHeader('Cache-Control', 'private, no-store'); return res.end("\uFEFFdate,opponent\r\n2026-10-24,'=1+1\r\n"); }
  if (url.pathname.startsWith('/fonts/')) { const base = path.resolve(web, 'app/fonts'), file = path.resolve(base, url.pathname.slice(7)); if (file.startsWith(base + path.sep) && fs.existsSync(file)) { res.setHeader('Content-Type', 'font/woff2'); return res.end(fs.readFileSync(file)); } }
  res.statusCode = 404; res.end();
});
(async () => {
  await new Promise(resolve => server.listen(3247, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [width, theme] of [320, 390, 768, 1440].flatMap(width => [[width, 'light'], [width, 'dark']])) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, acceptDownloads: true, reducedMotion: 'reduce' });
      const errors = [], page = await context.newPage(); page.on('pageerror', error => { errors.push(error.message); console.error('Fixture page error:', error.message); });
      await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
      await page.goto(`${origin}/app/replays?filters=1&preset=all&theme=${theme}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Replay Library' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Export CSV', exact: true })).toBeVisible();
      await page.getByRole('button', { name: /^Filters/ }).click();
      await page.getByText('Account · All accounts', { exact: true }).click();
      await page.getByRole('checkbox', { name: /Main · EU · Master/ }).check();
      const filter = JSON.parse(await page.locator('[data-fixture-filters]').textContent()); expect(filter.accounts).toBe('2-S2-1-100'); checks++;
      const checkbox = page.getByRole('checkbox', { name: /Main · EU · Master/ }); const target = await checkbox.locator('..').boundingBox(); expect(target.height).toBeGreaterThanOrEqual(44); checks++;
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: `../../docs/handoff/screenshots/replay-accounts-picker-${theme}-${width}.png` });
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(page.getByRole('button', { name: /Remove filter Accounts: 2-S2-1-100/ })).toBeVisible(); checks++;
      await page.getByRole('textbox', { name: 'Search replays' }).fill('Synthetic rival');
      await page.getByRole('combobox', { name: 'Filter by result' }).selectOption('win');
      await page.getByRole('combobox', { name: 'Filter by matchup' }).selectOption('PvZ');
      await expect.poll(() => page.getByRole('textbox', { name: 'Search replays' }).inputValue()).toBe('Synthetic rival');
      const downloaded = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
      const download = await downloaded; const file = await download.path(); const data = fs.readFileSync(file);
      expect(data.subarray(0, 3).toString('hex')).toBe('efbbbf'); expect(data.toString('utf8')).toContain("'=1+1"); checks++;
      const query = csvRequests.at(-1); expect(query.get('accounts')).toBe('2-S2-1-100'); expect(query.get('search'), query.toString()).toBe('Synthetic rival'); expect(query.get('result')).toBe('win'); expect(query.get('matchup')).toBe('PvZ'); expect(query.has('cursor')).toBe(false); expect(query.has('limit')).toBe(false); checks++;
      await expect(page.getByText(/Export limited to the first 50,000/)).toBeVisible(); checks++;
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); checks++;
      await page.screenshot({ path: `../../docs/handoff/screenshots/replay-accounts-export-${theme}-${width}.png` });
      await page.evaluate(() => window.fixtureAuth('other-synthetic-owner'));
      await expect(page.getByRole('button', { name: /Remove filter Accounts/ })).toHaveCount(0); await expect(page.getByText(/Export limited to the first/)).toHaveCount(0); checks++;
      const link = new URL(await page.getByRole('link', { name: /Open replay analysis/ }).first().getAttribute('href'), origin);
      expect(new URLSearchParams(link.searchParams.get('fromFilters')).has('accounts')).toBe(false); checks++;
      expect(errors).toEqual([]); checks++; await context.close();
    }
    console.log(JSON.stringify({ checks, screenshots: 16, externalNetwork: 'blocked' }));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
