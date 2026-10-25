/* Run after the final production build. Only disposable loopback data is used. */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');
const { dossier } = require('./build-dossier-insights-fixture.cjs');
execFileSync(process.execPath, ['tests/manual/build-dossier-insights-fixture.cjs'], { stdio: 'inherit' });
const root = process.cwd(), origin = 'http://127.0.0.1:3262', calls = [];
const evidence = path.resolve('../../.cache/build-dossier-insights-evidence'); fs.mkdirSync(evidence, { recursive: true });
const css = fs.readdirSync('.next/static/css').filter(name => name.endsWith('.css')).map(name => fs.readFileSync(path.join('.next/static/css', name), 'utf8')).join('\n');
const fonts = "@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2')}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2')}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay;--font-serif:serif}";
const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin), owner = (req.headers.authorization || '').replace(/^Bearer /, ''), json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (url.pathname.startsWith('/v1/')) calls.push({ path: url.pathname, search: url.search, method: req.method, owner });
  if (url.pathname.startsWith('/v1/builds/') && !url.pathname.endsWith('/phases')) {
    const value = dossier(owner, url.searchParams.has('small') || owner === 'fixture-owner-b');
    if (owner === 'fixture-owner-b') Object.assign(value.matchupTimingsLegacy.PvZ.timings.Stargate, { medianSeconds: 360, p25Seconds: 340, p75Seconds: 385 });
    return json(value);
  }
  if (url.pathname.endsWith('/phases')) { res.statusCode = 404; return json({ error: { code: 'not_available', message: 'Synthetic timing-only sample' } }); }
  if (url.pathname.startsWith('/v1/games/')) return json({ gameId: url.pathname.slice('/v1/games/'.length), date: '2026-10-20T12:00:00Z', result: 'Victory', map: 'Synthetic map', durationSec: 720, opponent: { displayName: 'Recorded opponent' } });
  if (url.pathname === '/v1/me') return json({ displayName: 'Synthetic player' });
  if (url.pathname.startsWith('/v1/')) return json({});
  if (url.pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync('.tmp/build-dossier-insights-fixture.js')); }
  if (url.pathname.startsWith('/builds') || url.pathname.startsWith('/app')) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(`<!doctype html><html data-theme="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`); }
  const base = url.pathname.startsWith('/fonts/') ? path.join(root, 'app/fonts') : path.join(root, 'public');
  const file = path.resolve(base, url.pathname.startsWith('/fonts/') ? url.pathname.slice(7) : url.pathname.slice(1));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', ({ '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise(resolve => server.listen(3262, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true }); let checks = 0;
  try {
    for (const width of [320, 390, 768, 1440]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, timezoneId: 'UTC', reducedMotion: 'reduce' });
      await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
      const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/builds/fixture'); await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      const timing = page.getByRole('region', { name: 'Build key timings', exact: true }), plan = page.getByRole('region', { name: 'Declared build plan survival', exact: true });
      await expect(timing.getByText('12 s slower than community')).toBeVisible(); checks++;
      await expect(timing.getByText(/Based on your last 25 games/)).toBeVisible(); checks++;
      await expect(plan.getByRole('img')).toHaveAttribute('aria-label', '12 held and 8 knocked off among 20 declared games'); checks++;
      expect(await page.getByRole('navigation', { name: 'Build sections' }).getByRole('link').evaluateAll(nodes => nodes.map(node => node.getAttribute('href')))).toEqual(['#overview', '#timings', '#plan', '#army', '#matchups', '#games']); checks++;
      await timing.getByRole('button', { name: /Stargate.*inspect games/ }).focus(); await page.keyboard.press('Enter');
      await expect(page.getByRole('region', { name: 'Selected sample games' })).toContainText('Stargate timings · PvZ'); checks++;
      await expect(page.locator('[data-testid="build-games-filter-chip"]')).toBeFocused(); checks++;
      await expect(page.getByRole('link', { name: 'Open game', exact: true })).toHaveCount(2); checks++;
      await page.getByRole('button', { name: 'Show all recent games' }).click();
      await plan.getByRole('button', { name: /Ground follow-up/ }).click(); await expect(page.getByRole('region', { name: 'Selected sample games' })).toContainText('Knocked into: Ground follow-up'); checks++;
      await timing.getByRole('button', { name: 'Opponent timings', exact: true }).click(); await expect(timing.getByText(/slower than community/)).toHaveCount(0); checks++;
      await timing.getByRole('button', { name: 'Your timings', exact: true }).click();
      await timing.getByRole('button', { name: 'PvT', exact: true }).click(); await expect(timing.getByRole('button', { name: /Gateway.*inspect games/ })).toBeVisible(); await expect(timing.getByRole('button', { name: /Stargate.*inspect games/ })).toHaveCount(0); checks++;
      await timing.getByRole('button', { name: 'PvZ', exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); checks++;
      expect(await timing.locator('button').evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().height >= 43))).toBe(true); checks++;
      await page.addStyleTag({ content: 'nav.fixed{visibility:hidden!important}' });
      await page.evaluate(() => document.fonts.ready); await timing.screenshot({ path: path.join(evidence, `timings-${theme}-${width}.png`) }); await plan.screenshot({ path: path.join(evidence, `plan-${theme}-${width}.png`) });
      await page.goto(origin + '/builds/fixture?small=1'); await expect(page.getByRole('heading', { name: 'Key timings', exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Plan survival', exact: true })).toHaveCount(0); checks++;
      await page.goto(origin + '/app/game/fixture'); await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      await expect(page.getByText('+12s vs your median', { exact: true })).toHaveCount(1); checks++;
      await expect(page.getByTestId('build-column-opp').getByText(/vs your median/)).toHaveCount(0); checks++;
      await page.getByTestId('build-column-me').getByRole('button', { name: 'Jump to 5:12 Stargate' }).click(); expect(await page.evaluate(() => window.fixtureLastSeek)).toBe(312); checks++;
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); checks++;
      await page.addStyleTag({ content: 'nav.fixed{visibility:hidden!important}' }); await page.getByTestId('build-order-columns').screenshot({ path: path.join(evidence, `game-${theme}-${width}.png`) });
      expect(errors).toEqual([]); checks++; await context.close();
    }
    const context = await browser.newContext({ viewport: { width: 390, height: 1000 }, reducedMotion: 'reduce' });
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    const page = await context.newPage(); await page.goto(origin + '/builds/fixture'); await expect(page.getByText('12 s slower than community')).toBeVisible();
    await page.getByRole('button', { name: /Ground follow-up/ }).click(); await page.evaluate(() => window.fixtureAuth('fixture-owner-a', false));
    await expect(page.getByRole('region', { name: 'Selected sample games' })).toHaveCount(0); checks++;
    await page.evaluate(() => window.fixtureAuth('fixture-owner-b')); await expect(page.getByText('72 s slower than community')).toBeVisible(); checks++;
    await page.evaluate(() => window.fixtureAuth('fixture-owner-a')); await expect(page.getByText('12 s slower than community')).toBeVisible(); await expect(page.getByRole('region', { name: 'Selected sample games' })).toHaveCount(0); checks++;
    await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') }); const axe = await page.evaluate(async () => window.axe.run(document.querySelector('main'), { rules: { 'color-contrast': { enabled: false } } })); expect(axe.violations).toEqual([]); checks++;
    expect(calls.every(call => call.method === 'GET')).toBe(true); checks++;
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, captures: 24, calls, externalTraffic: false, writes: 0 }, null, 2));
    console.log(JSON.stringify({ checks, captures: 24, evidence, writes: 0 })); await context.close();
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
