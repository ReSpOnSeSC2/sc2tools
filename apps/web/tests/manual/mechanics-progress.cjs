/* Run from apps/web after a production build. All API/auth data is synthetic,
 * every request is confined to localhost, and backfill never reaches an app. */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');
const { points, report } = require('./mechanics-progress-fixture.cjs');
execFileSync(process.execPath, ['tests/manual/mechanics-progress-fixture.cjs'], { stdio: 'inherit' });
const root = process.cwd(), origin = 'http://127.0.0.1:3220', calls = [];
const css = fs.readdirSync('.next/static/css').filter(name => name.endsWith('.css')).map(name => fs.readFileSync(path.join('.next/static/css', name), 'utf8')).join('\n');
const fonts = "@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2')}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2')}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay;--font-serif:serif}";
const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin), from = new URL(req.headers.referer || origin), json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (url.pathname.startsWith('/v1/')) calls.push({ path: url.pathname, search: url.search, method: req.method });
  if (url.pathname === '/v1/timeseries') { const interval = url.searchParams.get('interval') || 'week'; return json({ interval, points: points(interval).map(point => from.searchParams.has('empty') ? { ...point, avgMacroScore: null, macroN: 0 } : point) }); }
  if (url.pathname === '/v1/macro/report') return json(from.searchParams.has('empty') ? { ...report, gamesTotal: 0, gamesScored: 0 } : report);
  if (url.pathname === '/v1/macro/summary') return json({ gamesTotal: from.searchParams.has('empty') ? 0 : 41, gamesWithMacro: 23, gamesMissingMacro: 18, avgScore: 68.9, leaks: [{ name: 'Supply Blocked', count: 8, totalMinerals: 2400 }] });
  if (url.pathname === '/v1/me') return json({ agentLastSeenAt: from.searchParams.has('offline') ? null : new Date().toISOString() });
  if (url.pathname === '/v1/macro/backfill/start') return json({ ok: true, jobId: 'fixture-backfill', total: 4 });
  if (url.pathname === '/v1/macro/backfill/status') return json({ status: 'running', done: 1, total: 4 });
  if (url.pathname === '/v1/benchmarks') return json({ table: { leagueId: 4, league: 'Diamond', matchup: 'PvZ', n: 100, updatedAt: '2026-10-20T12:00:00Z', metrics: { macroScore: { n: 100, deciles: [30,40,50,60,70,75,80,85,90] } } } });
  if (url.pathname === '/v1/builds') return json([{ name: 'Blink pressure', total: 9, wins: 5, losses: 4, winRate: 5/9 }]);
  if (url.pathname === '/v1/timeseries/my-builds') { const interval = url.searchParams.get('interval') || 'week'; return json({ interval, points: points(interval).flatMap((point, i) => [{ bucket: point.bucket, key: 'Blink pressure', wins: Math.floor((i+1)*.6), losses: i+1-Math.floor((i+1)*.6), total: i+1 }, { bucket: point.bucket, key: 'Stargate opening', wins: 1, losses: 1, total: 2 }]) }); }
  if (url.pathname.startsWith('/v1/')) return json({});
  if (url.pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync('.tmp/mechanics-progress-fixture.js')); }
  if (url.pathname.startsWith('/app')) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(`<!doctype html><html data-theme="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`); }
  const base = url.pathname.startsWith('/fonts/') ? path.join(root, 'app/fonts') : path.join(root, 'public');
  const file = path.resolve(base, url.pathname.startsWith('/fonts/') ? url.pathname.slice(7) : url.pathname.slice(1));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', ({ '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise(resolve => server.listen(3220, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true }); let checks = 0;
  try {
    for (const width of [320,390,768,1440]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, timezoneId: 'UTC', reducedMotion: 'reduce' });
      await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
      const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
      for (const theme of ['light','dark']) {
        await page.goto(origin + '/app/macro'); await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
        await page.getByLabel('Mechanics period').selectOption('day'); await expect(page.getByRole('img', { name: /Macro score by calendar day/ })).toBeVisible(); checks++;
        const card = page.getByTestId('mechanics-trend-card');
        await expect(card.locator('circle[data-hollow="true"]')).toHaveCount(1); checks++;
        const geometry = await card.locator('circle').evaluateAll(nodes => nodes.map(node => ({ date: node.getAttribute('data-date'), x: Number(node.getAttribute('cx')) })));
        expect((geometry[1].x-geometry[0].x)/(geometry.at(-1).x-geometry[0].x)).toBeCloseTo(.1,3); checks++;
        expect((await card.getByTestId('mechanics-trend-line').getAttribute('d')).match(/M/g).length).toBe(2); checks++;
        const before = calls.filter(call => call.path === '/v1/timeseries').length;
        await card.getByRole('button', { name: 'APM', exact: true }).click(); await expect(card.getByRole('img', { name: /APM by calendar day/ })).toBeVisible();
        await card.getByRole('button', { name: 'SQ', exact: true }).click(); await expect(card.getByText('72 · 2 measured games', { exact: true })).toBeVisible();
        expect(calls.filter(call => call.path === '/v1/timeseries').length).toBe(before); checks++;
        await card.getByRole('button', { name: 'Macro score', exact: true }).click(); await page.getByLabel('League reference').selectOption('4'); await expect(card.getByTestId('mechanics-reference')).toHaveCount(1); await expect(card.getByText(/Dashed line: Diamond PvZ median/)).toBeVisible(); checks++;
        await card.evaluate(element => scrollTo(0, scrollY + element.getBoundingClientRect().top - 20));
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Macro overflow ' + width); checks++;
        if ((await card.locator('button,select').evaluateAll(nodes => nodes.some(node => node.getBoundingClientRect().height < 43)))) throw new Error('Small mechanics controls'); checks++;
        await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: `../../docs/handoff/screenshots/mechanics-progress-${theme}-${width}.png` });
      }
      await page.goto(origin + '/app/macro?empty=1'); await page.getByRole('button', { name: 'Score my older games' }).click(); await expect(page.getByRole('status').filter({ hasText: 'Scoring older games: 1/4' })).toBeVisible(); checks++;
      await page.goto(origin + '/app/macro?empty=1&offline=1'); await expect(page.getByRole('link', { name: 'Get the desktop app' })).toBeVisible(); checks++;
      await page.goto(origin + '/app/builds'); await expect(page.getByLabel('Build mix period')).toHaveValue('day'); await expect(page.getByRole('heading', { name: 'Build mix over time' })).toBeVisible(); checks++;
      for (const theme of ['light','dark']) {
        await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
        await page.locator('div[title][style*="background-color"]').first().waitFor({ state: 'attached' });
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Builds overflow ' + width); checks++;
        const contrast = await page.locator('div[title][style*="background-color"]').evaluateAll(cells => {
          const numbers = value => value.match(/[\d.]+/g).map(Number);
          const background = numbers(getComputedStyle(document.documentElement).getPropertyValue('--bg-surface'));
          const luminance = rgb => rgb.map(value => { const c = value/255; return c <= .04045 ? c/12.92 : ((c+.055)/1.055)**2.4; }).reduce((sum, value, i) => sum + value*[.2126,.7152,.0722][i], 0);
          return cells.map(cell => { const style = getComputedStyle(cell), fill = numbers(style.backgroundColor), alpha = fill[3] ?? 1, rgb = fill.slice(0,3).map((value,i) => value*alpha + background[i]*(1-alpha)); const a = luminance(numbers(style.color)), b = luminance(rgb); return alpha > 0 ? (Math.max(a,b)+.05)/(Math.min(a,b)+.05) : 0; });
        });
        if (!contrast.length || Math.min(...contrast) < 4.5) throw new Error('Build mix count contrast ' + JSON.stringify({ theme, contrast })); checks++;
        if (width === 390 || width === 1440) { await page.getByRole('heading', { name: 'Build mix over time' }).evaluate(element => scrollTo(0, scrollY + element.getBoundingClientRect().top - 30)); await page.screenshot({ path: `../../docs/handoff/screenshots/mechanics-build-mix-${theme==='light'?'':theme+'-'}${width}.png` }); }
      }
      if (errors.length) throw new Error(JSON.stringify(errors)); console.log(JSON.stringify({ width, checks, errors })); await context.close();
    }
    console.log(`${checks} mechanics browser checks passed`);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
