/* Run in apps/web after a production build: node tests/manual/map-veto.cjs.
 * Actual product components, SWR/authenticated fetch hooks, production CSS/fonts and local API fixtures.
 * No external requests or account operations are allowed by the browser contexts.
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');
const { cells, community } = require('./map-veto-fixture.cjs');
execFileSync(process.execPath, ['tests/manual/map-veto-fixture.cjs'], { stdio: 'inherit' });
const root = process.cwd(), origin = 'http://127.0.0.1:3218';
const css = fs.readdirSync('.next/static/css', { recursive: true }).filter(name => name.endsWith('.css')).map(name => fs.readFileSync(path.join('.next/static/css', name), 'utf8')).join('\n');
const fonts = `@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2')}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2')}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay;--font-serif:serif}`;
const pool = { mapPool: ['Ancient Cistern', 'Ruby Rock', 'Sanctuary III'], mapPoolSource: 'persisted', mapPoolFetchedAt: Date.now(), items: [] };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin);
  const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (url.pathname === '/v1/seasons') return json(pool);
  if (url.pathname === '/v1/guides') return json(community);
  const exact = url.searchParams.has('map_exact') ? JSON.parse(url.searchParams.get('map_exact')) : null;
  const matches = cells.filter(row => (exact ? exact.includes(row.map) : !url.searchParams.get('map') || row.map.toLowerCase().includes(url.searchParams.get('map').toLowerCase())) && (!url.searchParams.get('opp_race') || row.matchup === `vs ${url.searchParams.get('opp_race')}`));
  if (url.pathname === '/v1/maps/matchups') return json(matches);
  // Like the API, one row per map: an all-matchups request sums its matchup cells.
  if (url.pathname === '/v1/maps') return json([...new Set(matches.map(row => row.map))].map(name => { const rows = matches.filter(row => row.map === name), sum = key => rows.reduce((total, row) => total + row[key], 0); return { name, wins: sum('wins'), losses: sum('losses'), total: sum('total'), recent: ['loss', 'win', 'loss', 'loss', 'win'] }; }));
  if (url.pathname === '/v1/matchups') return json([{ name: 'vs Z', wins: 11, losses: 17, total: 37, winRate: 0.39, recent: ['win', 'loss'] }]);
  if (url.pathname === '/v1/me/profile') return json({ displayName: 'Sample player' });
  if (url.pathname === '/v1/games-list') return json({ total: 1, games: [{ id: 'sample-map-game', date: '2026-10-20T12:00:00Z', map: url.searchParams.get('map'), opponent: 'Sample rival', opp_race: url.searchParams.get('opp_race') || 'Z', my_race: 'P', result: 'Defeat', build: 'Blink pressure', game_length: 700 }] });
  if (url.pathname.startsWith('/v1/')) return json({});
  if (url.pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync('.tmp/map-veto-fixture.js')); }
  if (url.pathname.startsWith('/app') || url.pathname.startsWith('/guides')) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(`<!doctype html><html data-theme="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`); }
  const base = url.pathname.startsWith('/fonts/') ? path.join(root, 'app/fonts') : path.join(root, 'public');
  const file = path.resolve(base, url.pathname.startsWith('/fonts/') ? url.pathname.slice(7) : url.pathname.slice(1));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', ({ '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
});

(async () => {
  await new Promise(resolve => server.listen(3218, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true }); let checks = 0;
  try {
    for (const width of [320, 390, 768, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
      await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
      const page = await context.newPage(), errors = [], requests = [];
      page.on('pageerror', error => errors.push(error.message)); page.on('request', request => requests.push(new URL(request.url()).pathname));
      await page.goto(origin + '/app/maps'); await expect(page.getByRole('heading', { name: 'Current ladder pool' })).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Ranking matchup' })).toHaveValue(''); await expect(page.getByText('Suggested veto', { exact: true })).toHaveCount(1);
      await expect(page.locator('tbody tr').filter({ hasText: 'Suggested veto' })).toContainText('Ancient Cistern'); await expect(page.locator('tbody tr').filter({ hasText: 'Suggested veto' })).toContainText('All matchups');
      await expect(page.getByRole('img', { name: /^Recent all matchups, oldest to newest/ })).toHaveCount(3); checks++;
      await expect(page.getByRole('switch', { name: 'Current ladder pool only' })).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByRole('button', { name: 'View games on Custom Practice Map', exact: true })).toHaveCount(0); checks++;
      const detail = page.getByRole('list', { name: 'Map performance by matchup' }).locator('li').filter({ has: page.getByRole('button', { name: 'View games on Ancient Cistern LE', exact: true }) }).first();
      const ratio = await detail.locator('.h-full.bg-success').first().evaluate(element => ({ style: element.getAttribute('style'), ratio: element.getBoundingClientRect().width / element.parentElement.getBoundingClientRect().width, min: getComputedStyle(element).minWidth }));
      expect(ratio.ratio).toBeCloseTo(2 / 12, 2); checks++;
      // Ruby Rock (13-6) is above the 47.6% pool average and Sanctuary III (0-4) is under the floor, so one slot stays empty.
      await page.getByRole('combobox', { name: 'Veto count' }).selectOption('3'); await expect(page.getByText('Suggested veto', { exact: true })).toHaveCount(1);
      await expect(page.getByText('Only 1 veto suggested: no other map with at least 5 decided games is below your pool average (47.6%).')).toBeVisible(); checks++;
      await page.getByRole('button', { name: 'Copy veto list' }).click(); await expect(page.getByRole('status').filter({ hasText: 'Veto list copied.' })).toBeVisible();
      if ((await page.evaluate(() => navigator.clipboard.readText())) !== 'Suggested SC2 vetoes: Ancient Cistern') throw new Error('Wrong copied vetoes'); checks++;
      await page.evaluate(() => document.fonts.ready);
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) { await page.screenshot({ path: '.tmp/map-overflow.png', fullPage: true }); throw new Error(`Map overflow ${width}`); }
      await page.screenshot({ path: `../../docs/handoff/screenshots/map-veto-${width}.png`, fullPage: true }); checks++;
      await page.getByRole('button', { name: 'View vs Z games on Ancient Cistern', exact: true }).click();
      await expect(page.getByRole('dialog')).toContainText('Sample rival'); await expect(page.getByRole('dialog')).toContainText('Ancient Cistern LE'); checks++;
      await page.getByRole('button', { name: 'Filter everything to this map' }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByLabel('Applied global map')).toHaveText('Ancient Cistern LE'); checks++;
      await page.goto(origin + '/app/maps?focus=Sanctuary%20III%20LE'); await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.locator('#map-sanctuaryiii')).toHaveClass(/ring-2 ring-accent/); await page.keyboard.press('Escape'); await expect(page.locator('#map-sanctuaryiii')).toBeInViewport(); checks++;
      await page.goto(origin + '/guides/maps/ancient-cistern'); await expect(page.getByRole('heading', { name: 'You on this map' })).toBeVisible();
      await page.getByRole('combobox', { name: 'Your race' }).selectOption('P'); await expect(page.getByText(/Community 54.0/)).toBeVisible();
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`Guide overflow ${width}`); checks++;
      if (width === 390 || width === 1440) await page.screenshot({ path: `../../docs/handoff/screenshots/map-guide-personal-${width}.png`, fullPage: true });
      const before = requests.length; await page.goto(origin + '/guides/maps/ancient-cistern?signedOut=1'); await expect(page.getByRole('link', { name: 'Sign in to compare your map record' })).toBeVisible();
      if (requests.slice(before).includes('/v1/maps/matchups')) throw new Error('Private map request while signed out'); checks++;
      if (errors.length) throw new Error(JSON.stringify(errors)); console.log(JSON.stringify({ width, checks, errors })); await context.close();
    }
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
      await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
      await context.route('**/v1/seasons', route => route.fulfill({ json: { ...pool, mapPoolSource: 'fallback', mapPoolFetchedAt: null } }));
      const page = await context.newPage(); await page.goto(origin + '/app/maps'); await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
      await expect(page.getByRole('button', { name: 'Copy veto list' })).toBeDisabled(); await expect(page.getByRole('switch', { name: 'Current ladder pool only' })).toHaveAttribute('aria-checked', 'false'); checks++;
      await expect(page.getByRole('button', { name: 'View games on Custom Practice Map', exact: true })).toBeVisible();
      await page.screenshot({ path: `../../docs/handoff/screenshots/map-veto-stale-${theme}.png`, fullPage: true }); checks++; await context.close();
    }
    console.log(`${checks} real browser checks passed`);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
