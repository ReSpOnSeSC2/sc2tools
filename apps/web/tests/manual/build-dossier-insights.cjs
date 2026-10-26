/* Run after the final production build. Only disposable loopback data is used. */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');
const { dossier } = require('./build-dossier-insights-fixture.cjs');
execFileSync(process.execPath, ['tests/manual/build-dossier-insights-fixture.cjs'], { stdio: 'inherit' });
const root = process.cwd(), origin = 'http://127.0.0.1:3262', calls = [];
const evidence = path.resolve(process.env.DOSSIER_EVIDENCE_DIR || '../../.cache/build-dossier-insights-current-evidence'); fs.mkdirSync(evidence, { recursive: true });
const captureCSS = 'nav.fixed,header.sticky,nav[aria-label="Build sections"]{visibility:hidden!important}';
const css = fs.readdirSync('.next/static/css').filter(name => name.endsWith('.css')).map(name => fs.readFileSync(path.join('.next/static/css', name), 'utf8')).join('\n');
const fonts = "@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2')}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2')}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay;--font-serif:serif}";
const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin), owner = (req.headers.authorization || '').replace(/^Bearer /, ''), json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (url.pathname.startsWith('/v1/')) calls.push({ path: url.pathname, search: url.search, method: req.method, owner });
  if (url.pathname === '/v1/builds') return json([{ name: 'Held most', total: 20, wins: 12, losses: 8, winRate: .6, planHeldRate: .8 }, { name: 'Measured zero', total: 5, wins: 2, losses: 3, winRate: .4, planHeldRate: 0 }, { name: 'Small sample', total: 4, wins: 2, losses: 2, winRate: .5, planHeldRate: null }]);
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
  if (url.pathname.startsWith('/builds') || url.pathname.startsWith('/app')) {
    const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(`<!doctype html><html lang="en" data-theme="${theme}" data-theme-mode="${theme}"><head><title>Local build dossier verification</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  }
  const base = url.pathname.startsWith('/fonts/') ? path.join(root, 'app/fonts') : path.join(root, 'public');
  const file = path.resolve(base, url.pathname.startsWith('/fonts/') ? url.pathname.slice(7) : url.pathname.slice(1));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', ({ '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
});
(async () => {
  let browser, checks = 0;
  const visit = async (page, route, theme) => {
    const url = new URL(route, origin); url.searchParams.set('theme', theme);
    await page.goto(url.href);
    await expect.poll(() => page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.themeMode,
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(), getComputedStyle(document.documentElement).colorScheme]))
      .toEqual([theme, theme, theme === 'dark' ? '6 9 14' : '244 246 250', theme]); checks++;
  };
  try {
    // Compile the current shared AA gate only when this runner is invoked,
    // after normal main integration. Keep generated adapters out of source.
    const aaAdapter = path.resolve('.tmp/build-dossier-current-aa.cjs');
    require('esbuild').buildSync({ entryPoints: ['tests/e2e/accessibility-check.ts'], bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: aaAdapter, logLevel: 'warning' });
    const { checkAccessibility } = require(aaAdapter);
    const checkAA = async (page, width, theme) => {
      const route = new URL(page.url()).pathname;
      await checkAccessibility(page, { project: { name: `manual-${width}` }, attach: async (_name, { body }) => {
        fs.writeFileSync(path.join(evidence, `aa-${theme}-${width}-${route.replace(/[^a-z0-9]/gi, '_')}.json`), body);
      } }, route, theme); checks++;
    };
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(3262, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    browser = await chromium.launch({ headless: true, ...(process.env.PW_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PW_CHROMIUM_EXECUTABLE } : {}) });
    for (const width of [320, 390, 768, 1440]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, timezoneId: 'UTC', reducedMotion: 'reduce', colorScheme: theme });
      await context.addInitScript(mode => localStorage.setItem('sc2tools.theme', mode), theme);
      await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
      const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
      await visit(page, '/builds/fixture', theme);
      const timing = page.getByRole('region', { name: 'Build key timings', exact: true }), plan = page.getByRole('region', { name: 'Declared build plan survival', exact: true });
      await expect(timing.getByText('12 s slower than community')).toBeVisible(); checks++;
      await expect(timing.getByText(/Based on your last 25 eligible games/)).toBeVisible(); checks++;
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
      await checkAA(page, width, theme);
      await page.addStyleTag({ content: captureCSS });
      await page.evaluate(() => document.fonts.ready); await timing.screenshot({ path: path.join(evidence, `timings-${theme}-${width}.png`) }); await plan.screenshot({ path: path.join(evidence, `plan-${theme}-${width}.png`) });
      await visit(page, '/builds/fixture?small=1', theme); await expect(page.getByRole('heading', { name: 'Key timings', exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Plan survival', exact: true })).toHaveCount(0); checks++;
      await visit(page, '/app/game/fixture', theme);
      await expect(page.getByText('+12s vs your median', { exact: true })).toHaveCount(1); checks++;
      await expect(page.getByTestId('build-column-opp').getByText(/vs your median/)).toHaveCount(0); checks++;
      await page.getByTestId('build-column-me').getByRole('button', { name: 'Jump to 5:12 Stargate' }).click(); expect(await page.evaluate(() => window.fixtureLastSeek)).toBe(312); checks++;
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); checks++;
      await checkAA(page, width, theme);
      await page.addStyleTag({ content: captureCSS }); await page.getByTestId('build-order-columns').screenshot({ path: path.join(evidence, `game-${theme}-${width}.png`) });
      const baselineReads = () => calls.filter(call => call.path.startsWith('/v1/builds/')).length, readsBeforeEmpty = baselineReads();
      await visit(page, '/app/game/fixture?missing=1', theme); await expect(page.getByText('No build events were parsed from this replay.', { exact: true })).toBeVisible();
      await page.waitForLoadState('networkidle'); expect(baselineReads()).toBe(readsBeforeEmpty); checks++;
      await visit(page, '/app/builds/summary', theme);
      await expect(page.getByText('Held 62%', { exact: true })).toBeVisible(); checks++;
      await expect(page.locator('table thead').getByText('Plan held', { exact: true })).toHaveCount(1); checks++;
      if (width >= 768) { await page.locator('table').getByRole('button', { name: 'Plan held', exact: true }).click(); await expect(page.locator('table tbody tr').first()).toContainText('Held most'); checks++; }
      else { await expect(page.getByText('Held 0%', { exact: true })).toBeVisible(); checks++; }
      await page.getByRole('searchbox', { name: 'Search builds' }).fill('Small sample'); await expect(page.locator('table thead').getByText('Plan held', { exact: true })).toHaveCount(0); checks++;
      await page.getByRole('searchbox', { name: 'Search builds' }).fill('');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); checks++;
      await checkAA(page, width, theme);
      await page.addStyleTag({ content: captureCSS }); await page.getByTestId('build-summary-preview').screenshot({ path: path.join(evidence, `summary-${theme}-${width}.png`) });
      expect(errors).toEqual([]); checks++; await context.close();
    }
    const context = await browser.newContext({ viewport: { width: 390, height: 1000 }, reducedMotion: 'reduce', colorScheme: 'light' });
    await context.addInitScript(mode => localStorage.setItem('sc2tools.theme', mode), 'light');
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    const page = await context.newPage(); await visit(page, '/builds/fixture', 'light'); await expect(page.getByText('12 s slower than community')).toBeVisible();
    await page.getByRole('button', { name: /Ground follow-up/ }).click(); await page.evaluate(() => window.fixtureAuth('fixture-owner-a', false));
    await expect(page.getByRole('region', { name: 'Selected sample games' })).toHaveCount(0); checks++;
    await page.evaluate(() => window.fixtureAuth('fixture-owner-b')); await expect(page.getByText('72 s slower than community')).toBeVisible(); checks++;
    await page.evaluate(() => window.fixtureAuth('fixture-owner-a')); await expect(page.getByText('12 s slower than community')).toBeVisible(); await expect(page.getByRole('region', { name: 'Selected sample games' })).toHaveCount(0); checks++;
    await checkAA(page, 390, 'light');
    expect(calls.every(call => call.method === 'GET')).toBe(true); checks++;
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, captures: 32, calls, externalTraffic: false, writes: 0 }, null, 2));
    console.log(JSON.stringify({ checks, captures: 32, evidence, writes: 0 })); await context.close();
  } finally {
    try { await browser?.close(); }
    finally { if (server.listening) await new Promise(resolve => server.close(resolve)); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
