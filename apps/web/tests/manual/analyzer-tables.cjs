/* Production CSS/fonts and real table, sheet, auth-fetch and CSV paths.
 * Synthetic local API only. Browser contexts block all external requests.
 */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');
execFileSync(process.execPath, ['tests/manual/analyzer-tables-fixture.cjs'], { stdio: 'inherit' });
const origin = 'http://127.0.0.1:3261', root = process.cwd();
const css = fs.readdirSync('.next/static/css', { recursive: true }).filter(name => name.endsWith('.css')).map(name => fs.readFileSync(path.join('.next/static/css', name), 'utf8')).join('\n');
const fonts = `@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2')}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2')}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay;--font-serif:serif}`;
const builds = [{ name: 'Gateway pressure with a long build name', wins: 8, losses: 2, total: 10, winRate: .8, myMatchups: { P: 6, T: 4 }, ratedGames: 8, winsAboveExpected: 1.25 }, { name: 'Adept timing', wins: 2, losses: 3, total: 5, winRate: .4, myMatchups: { P: 5 }, ratedGames: 0 }];
const matrix = builds.map((build, index) => ({ ...build, my_build: build.name, opp_strat: index ? 'A macro opening' : 'Z pressure opening' }));
const mapCells = [{ map: 'Ancient Cistern LE', matchup: 'vs P', wins: 4, losses: 6, total: 10, winRate: .4 }, { map: 'Ancient Cistern LE', matchup: 'vs T', wins: 1, losses: 1, total: 2, winRate: .5 }, { map: 'Ruby Rock LE', matchup: 'vs P', wins: 5, losses: 0, total: 5, winRate: 1 }];
let holdGames = false;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin);
  const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  if (url.pathname === '/v1/builds') return json(url.searchParams.has('map') ? [] : builds);
  if (url.pathname === '/v1/build-vs-strategy') return json(url.searchParams.has('map') ? [] : url.searchParams.get('opp_race') === 'T' ? [matrix[0]] : matrix);
  if (url.pathname === '/v1/games-list') {
    const value = { total: url.searchParams.has('map') ? 0 : 1, games: url.searchParams.has('map') ? [] : [{ id: 'synthetic-game', date: '2026-10-25T10:00:00Z', result: 'Win', build: matrix[0].my_build, opp_strategy: matrix[0].opp_strat, opp_race: 'Protoss', my_race: 'P', opponent: 'Synthetic rival', map: 'Ancient Cistern LE', game_length: 700 }] };
    return holdGames ? setTimeout(() => { if (!res.destroyed) json(value); }, 700) : json(value);
  }
  if (url.pathname === '/v1/seasons') return json({ items: [], mapPool: ['Ancient Cistern', 'Ruby Rock'], mapPoolSource: 'persisted', mapPoolFetchedAt: Date.now() });
  if (url.pathname === '/v1/maps/matchups') return json(mapCells);
  if (url.pathname === '/v1/maps') return json([]);
  if (url.pathname === '/v1/matchups') return json([{ name: 'vs P', wins: 9, losses: 6, total: 15, winRate: .6 }]);
  if (url.pathname === '/v1/me/profile') return json({ displayName: 'Synthetic owner' });
  if (url.pathname === '/v1/custom-builds') return json({ items: [] });
  if (url.pathname === '/v1/strategies') return json([]);
  if (url.pathname === '/v1/guides') return json({ maps: [] });
  if (url.pathname.startsWith('/v1/')) return json({ error: { code: 'not_found' } }, 404);
  if (url.pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); return res.end(fs.readFileSync('.tmp/analyzer-tables-fixture.js')); }
  if (url.pathname.startsWith('/app/')) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(`<!doctype html><html data-theme="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`); }
  const base = url.pathname.startsWith('/fonts/') ? path.join(root, 'app/fonts') : path.join(root, 'public');
  const file = path.resolve(base, url.pathname.startsWith('/fonts/') ? url.pathname.slice(7) : url.pathname.slice(1));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', ({ '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
});
const downloadText = async download => fs.readFileSync(await download.path(), 'utf8');
(async () => {
  await new Promise(resolve => server.listen(3261, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true }); let checks = 0;
  try {
    for (const width of [320, 390, 768, 1440]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', acceptDownloads: true });
      await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const open = async mode => { await page.goto(`${origin}/app/${mode}`); await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme); await page.evaluate(() => document.fonts.ready); };
      await open('builds'); await expect(page.getByRole('searchbox', { name: 'Search builds' })).toBeVisible();
      const name = page.getByRole('table').getByRole('button', { name: builds[0].name, exact: true });
      if (width >= 768) {
        await expect(page.getByRole('columnheader', { name: 'W/L split', exact: true })).toBeVisible();
        await page.locator('body').click({ position: { x: 1, y: 1 } });
        // Native Tab and Enter, with no click/focus substitution for activation.
        let reached = false; for (let i = 0; i < 30; i++) { await page.keyboard.press('Tab'); if (await name.evaluate(node => node === document.activeElement)) { reached = true; break; } }
        expect(reached).toBe(true); await page.keyboard.press('Enter');
        await expect(page.getByRole('dialog')).toBeVisible(); await page.keyboard.press('Escape'); checks += 2;
      }
      const vP = page.getByRole('button', { name: /Filter builds vs Protoss/ }).first();
      await vP.click(); await expect(page.getByLabel('Current global matchup')).toHaveText('P'); checks++;
      await page.getByRole('searchbox', { name: 'Search builds' }).fill('Adept');
      let pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export these rows as CSV' }).click(); let download = await pending, csv = await downloadText(download);
      expect(download.suggestedFilename()).toMatch(/^sc2tools-builds-\d{4}-\d{2}-\d{2}\.csv$/); expect(csv).toContain('Adept timing'); expect(csv).not.toContain(builds[0].name); checks++;
      await page.screenshot({ path: `../../docs/handoff/screenshots/analyzer-builds-${theme}-${width}.png`, fullPage: true });
      await page.getByRole('searchbox', { name: 'Search builds' }).fill('Nothing matches this'); await expect(page.getByRole('button', { name: 'Nothing to export' })).toBeDisabled(); checks++;
      await open('strategies'); await expect(page.getByRole('radio', { name: 'versus Protoss' })).toHaveAttribute('aria-checked', 'true');
      const heat = page.getByRole('radio', { name: 'Heatmap', exact: true }); await heat.focus(); await page.keyboard.press('ArrowRight'); await heat.click();
      const table = page.getByRole('table', { name: 'Build versus strategy heatmap' }); await expect(table).toBeVisible();
      await expect(table.getByRole('rowheader').first()).toHaveText(builds[0].name); await page.getByRole('radio', { name: 'A–Z', exact: true }).click(); await expect(table.getByRole('rowheader').first()).toHaveText('Adept timing'); checks += 2;
      const cell = table.getByRole('button', { name: new RegExp(`${builds[0].name} vs Z pressure`) });
      expect(await cell.evaluate(node => getComputedStyle(node).opacity)).toBe('1');
      await cell.click(); await expect(page.getByRole('dialog')).toContainText('Synthetic rival'); checks++;
      await page.screenshot({ path: `../../docs/handoff/screenshots/analyzer-strategy-sheet-${theme}-${width}.png`, fullPage: true });
      await page.keyboard.press('Escape'); await expect(cell).toBeFocused(); await cell.click(); await expect(page.getByRole('dialog')).toContainText('Synthetic rival'); checks++;
      holdGames = true; await page.evaluate(() => window.fixtureFilters({ race: 'P', map: 'Empty map' }));
      await expect(page.getByRole('dialog')).toHaveAccessibleName(/Loading games/); await expect(page.getByRole('dialog')).not.toContainText('Synthetic rival');
      await expect(page.getByRole('dialog')).toContainText('No games match this strategy'); holdGames = false; checks++;
      await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByRole('button', { name: 'Clear filters' }).click(); await expect(table).toBeVisible();
      await page.getByRole('searchbox', { name: 'Search builds or strategies' }).fill('Gateway'); pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export these rows as CSV' }).click(); download = await pending; csv = await downloadText(download); expect(csv).toContain('matrix matchup vs P'); expect(csv).toContain('0.8'); expect(csv).not.toContain('Adept timing'); checks++;
      await page.screenshot({ path: `../../docs/handoff/screenshots/analyzer-heatmap-${theme}-${width}.png`, fullPage: true });
      await open('maps'); await expect(page.getByRole('heading', { name: 'Current ladder pool' })).toBeVisible();
      const exports = page.getByRole('button', { name: 'Export these rows as CSV' }); await expect(exports).toHaveCount(3);
      for (let index = 0; index < 3; index++) { pending = page.waitForEvent('download'); await exports.nth(index).click(); download = await pending; csv = await downloadText(download); expect(csv).toContain('Scope,'); if (index === 0) expect(csv).toContain('displayed P/T/Z/All columns'); if (index === 2) { expect(csv).toContain('Ancient Cistern LE,vs P'); expect(csv).not.toContain('Ancient Cistern LE,vs T'); } checks++; }
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`Document overflow ${width}/${theme}`);
      await page.screenshot({ path: `../../docs/handoff/screenshots/analyzer-map-csv-${theme}-${width}.png`, fullPage: true });
      expect(errors).toEqual([]); console.log(JSON.stringify({ width, theme, checks })); await context.close();
    }
    console.log(`Analyzer table browser checks passed: ${checks}`);
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); server.closeAllConnections(); server.close(); process.exitCode = 1; });
