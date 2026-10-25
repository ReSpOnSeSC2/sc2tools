/* Local-only actual consumers, production CSS/fonts, synthetic API/auth.
 * Non-local requests are blocked; no cloud/Agent/provider operation occurs. */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');
const { rows, ratings } = require('./strength-adjusted-fixture.cjs');
execFileSync(process.execPath, ['tests/manual/strength-adjusted-fixture.cjs'], { stdio: 'inherit' });
const root = process.cwd(), origin = 'http://127.0.0.1:3224', calls = [];
const css = fs.readdirSync('.next/static/css').filter(name => name.endsWith('.css')).map(name => fs.readFileSync(path.join('.next/static/css', name), 'utf8')).join('\n');
const fonts = "@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2')}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2')}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay;--font-serif:serif}";
const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin), json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (url.pathname.startsWith('/v1/')) calls.push({ path: url.pathname, search: url.search, method: req.method });
  if (url.pathname === '/v1/builds') return json(rows);
  if (url.pathname === '/v1/opp-strategies') return json(rows.map((row,i) => ({ ...row, name: ['Roach timing','Early pool','Unrecorded opponent','Long macro opening'][i] })));
  if (url.pathname === '/v1/build-vs-strategy') return json(rows.map((row,i) => ({ ...row, my_build: row.name, opp_strat: ['Roach timing','Early pool','Unrecorded opponent','Long macro opening'][i] })));
  if (url.pathname === '/v1/matchups') return json(rows.slice(0,3).map((row,i) => ({ ...row, name: ['vs Z','vs T','vs P'][i], recent: ['win','loss','win','win'] })));
  if (url.pathname === '/v1/maps/matchups') return json(rows.slice(0,3).map((row,i) => ({ ...row, map: ['Ancient Cistern LE','Ancient Cistern','Ruby Rock'][i], matchup: ['vs Z','vs T','vs P'][i] })));
  if (url.pathname === '/v1/timeseries/matchups') return json({ interval: 'day', points: [], ratingSeries: ratings });
  if (url.pathname === '/v1/timeseries/my-builds') return json({ interval: 'week', points: [] });
  if (url.pathname.startsWith('/v1/')) return json({ seasons: [] });
  if (url.pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync('.tmp/strength-adjusted-fixture.js')); }
  if (url.pathname.startsWith('/app')) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(`<!doctype html><html data-theme="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`); }
  const base = url.pathname.startsWith('/fonts/') ? path.join(root, 'app/fonts') : path.join(root, 'public');
  const file = path.resolve(base, url.pathname.startsWith('/fonts/') ? url.pathname.slice(7) : url.pathname.slice(1));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', ({ '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise(resolve => server.listen(3224, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true }); let checks = 0;
  const noOverflow = async (page, label) => { if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(label + ' page overflow'); checks++; };
  try {
    for (const width of [320,390,768,1440]) for (const theme of ['light','dark']) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, timezoneId: 'UTC', reducedMotion: 'reduce' });
      await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
      const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/app/builds'); await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      await expect(page.getByText('14 rated', { exact: true }).filter({ visible: true }).first()).toBeVisible(); checks++;
      const control = page.getByRole('button', { name: /^Vs expected/ }).filter({ visible: true }).first(); await control.click();
      const visibleRows = width < 768 ? page.locator('ul.md\\:hidden > li') : page.locator('table tbody > tr');
      await expect(visibleRows.first()).toContainText('Stargate follow-up'); checks++;
      await expect(page.getByRole('img', { name: /8 rated wins − 7.25 expected wins/ }).filter({ visible: true }).first()).toBeVisible(); checks++;
      await expect(page.getByText('thin sample', { exact: true }).filter({ visible: true }).first()).toBeVisible(); checks++;
      if (width >= 768) { await expect(page.getByRole('link', { name: 'About vs expected' })).toBeVisible(); checks++; }
      const contrast = await page.locator('[data-strength-chip]').evaluateAll(nodes => {
        const numbers = value => value.match(/[\d.]+/g).map(Number), base = getComputedStyle(document.documentElement).getPropertyValue('--bg-surface').trim().split(/\s+/).map(Number);
        const luminance = rgb => rgb.map(value => { const c = value/255; return c <= .04045 ? c/12.92 : ((c+.055)/1.055)**2.4; }).reduce((sum,value,i) => sum + value*[.2126,.7152,.0722][i],0);
        return nodes.map(node => { const style = getComputedStyle(node), fill = numbers(style.backgroundColor), alpha = fill[3] ?? 1, bg = fill.slice(0,3).map((value,i) => value*alpha + base[i]*(1-alpha)); const a = luminance(numbers(style.color)), b = luminance(bg); return (Math.max(a,b)+.05)/(Math.min(a,b)+.05); });
      });
      if (!contrast.length || Math.min(...contrast) < 4.5) throw new Error('Strength chip contrast ' + JSON.stringify({ theme, contrast })); checks++;
      await noOverflow(page, 'Builds'); await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: `../../docs/handoff/screenshots/strength-builds-${theme}-${width}.png` });
      await page.goto(origin + '/app/strategies'); await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      await expect(page.getByText('14 rated', { exact: true }).filter({ visible: true }).first()).toBeVisible(); checks++;
      await page.getByRole('button', { name: /^Vs expected/ }).filter({ visible: true }).first().click(); await noOverflow(page, 'Build vs strategy');
      if (width === 390 || width === 1440) await page.screenshot({ path: `../../docs/handoff/screenshots/strength-bvs-${theme}-${width}.png` });
      await page.getByRole('button', { name: 'By opponent strategy', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Win rate vs opponent strategies' })).toBeVisible(); checks++;
      await page.getByRole('button', { name: /^Vs expected/ }).first().click(); await noOverflow(page, 'Opponent strategies');
      if (width === 390 || width === 1440) await page.screenshot({ path: `../../docs/handoff/screenshots/strength-strategies-${theme}-${width}.png` });
      await page.goto(origin + '/app/maps'); await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      await expect(page.getByRole('heading', { name: 'Win rate by map by matchup' })).toBeVisible(); checks++;
      await page.getByLabel('Sort maps by').selectOption('winsAboveExpected'); await expect(page.getByRole('img', { name: /9 rated wins − 10.75 expected wins/ })).toBeVisible(); checks++;
      await noOverflow(page, 'Battlefield');
      if (width === 390 || width === 1440) { await page.getByRole('heading', { name: 'Win rate by map by matchup' }).evaluate(element => scrollTo(0, scrollY + element.getBoundingClientRect().top - 20)); await page.screenshot({ path: `../../docs/handoff/screenshots/strength-maps-${theme}-${width}.png` }); }
      const before = calls.filter(call => call.path === '/v1/timeseries/matchups').length;
      await page.goto(origin + '/app/trends'); await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      const panel = page.getByRole('region', { name: 'PvZ performance rating' }); await expect(panel).toBeVisible(); checks++;
      await expect(panel.locator('svg path')).toHaveCount(2); checks++;
      await panel.getByLabel('PvZ rating window').selectOption('8'); await expect(panel.getByText(/4,112 performance rating/)).toBeVisible(); checks++;
      expect(calls.filter(call => call.path === '/v1/timeseries/matchups').length - before).toBe(1); checks++;
      await noOverflow(page, 'Matchup rating'); await page.screenshot({ path: `../../docs/handoff/screenshots/strength-rating-${theme}-${width}.png` });
      if (errors.length) throw new Error(JSON.stringify(errors)); console.log(JSON.stringify({ width, theme, checks, errors })); await context.close();
    }
    console.log(`${checks} strength browser checks passed`);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
