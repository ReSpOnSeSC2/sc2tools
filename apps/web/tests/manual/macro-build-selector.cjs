/* Run from apps/web after a production build; one sequential browser context.
 * Disposable in-memory API only. No account, replay or provider writes. */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process'), { chromium, expect } = require('@playwright/test');
const root = process.cwd(), shots = path.resolve('../../.cache/macro-build-selector-screenshots');
const calls = [], unexpected = [], external = [], states = new Map();
let origin, browser, activePage, checks = 0, captures = 0, failRead = false;
const runtimeErrors = [];
const options = [{ key: 'pvz-stargate', name: 'PvZ - Stargate', source: 'catalog', group: 'yours', games: 3, wins: 2, losses: 1 }, { key: 'custom:dt', name: 'DT into 3 Gate', source: 'custom', slug: 'dt', group: 'yours', games: 2, wins: 1, losses: 1 }];
function initial(gameId) { return { gameId, matchup: 'PvZ', myRace: 'Protoss', oppRace: 'Zerg', eligible: true, status: 'pending', applied: false, build: null, suggestion: { ...options[0], reason: 'randomizer' }, detected: { name: 'Recorded macro build' }, notes: '', options, opponent: { label: 'Zerg - 12 Pool', status: 'none', applied: false, build: null, detected: { name: 'Zerg - 12 Pool' }, options: [{ ...options[0], key: 'zerg-12-pool', name: 'Zerg - 12 Pool' }] } }; }
const css = fs.readdirSync('.next/static/css', { recursive: true }).filter(name => name.endsWith('.css')).map(name => fs.readFileSync(path.join('.next/static/css', name), 'utf8')).join('\n');
const fonts = `@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay}`;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, origin || 'http://127.0.0.1'), p = url.pathname;
  const json = (body, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
  if (p.startsWith('/v1/')) {
    const gameId = decodeURIComponent(p.split('/')[3] || ''), owner = req.headers.authorization || 'none', key = `${owner}:${gameId}`;
    calls.push({ method: req.method, path: p, owner });
    if (p === '/v1/custom-builds/preview-matches') return json({ matches: [], scanned_games: 0 });
    if (p.endsWith('/macro-breakdown')) return json({ error: { code: 'macro_not_computed', message: 'No macro data' } }, 404);
    if (p.endsWith('/build-order')) return json({ game_id: gameId, my_race: 'Protoss', opp_race: 'Zerg', events: [{ time: 45, name: 'Gateway', is_building: true }], opp_events: [] });
    if (p.endsWith('/build-intent')) {
      if (!states.has(key)) states.set(key, initial(gameId));
      const state = states.get(key);
      if (req.method === 'GET') return failRead ? json({ error: { message: 'Synthetic failure' } }, 503) : json(state);
      if (req.method === 'PUT') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); calls.at(-1).body = body;
        if (body.action === 'confirm') Object.assign(state, { status: 'confirmed', applied: true, build: options.find(option => option.key === body.buildKey) });
        if (body.action === 'skip') Object.assign(state, { status: 'skipped', applied: false, build: null });
        if (body.notes !== undefined) state.notes = body.notes;
        if (body.action === 'opponent') Object.assign(state.opponent, { status: 'confirmed', applied: true, build: state.opponent.options.find(option => option.key === body.opponentBuildKey) || null });
        return json(state);
      }
    }
    unexpected.push({ method: req.method, path: p }); return json({}, 404);
  }
  if (p === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync('.cache/macro-build-selector-fixture.js')); }
  if (p === '/fixture') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(`<!doctype html><html lang="en" data-theme="${url.searchParams.get('theme') === 'dark' ? 'dark' : 'light'}"><head><title>Local Macro build selection</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`); }
  const base = p.startsWith('/fonts/') ? path.join(root, 'app/fonts') : path.join(root, 'public'), file = path.resolve(base, p.startsWith('/fonts/') ? p.slice(7) : p.slice(1));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', ({ '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
});
async function shot(page, name) { await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false }); captures++; }
(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
    execFileSync(process.execPath, ['tests/manual/macro-build-selector-fixture.cjs'], { env: { ...process.env, MACRO_BUILD_FIXTURE_ORIGIN: origin }, stdio: 'inherit' });
    fs.mkdirSync(shots, { recursive: true }); browser = await chromium.launch({ headless: true });
    for (const width of [320, 390, 768, 1440]) for (const theme of ['light', 'dark']) for (const surface of ['inline', 'modal']) {
      calls.length = 0; states.clear(); failRead = false;
      const context = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion: 'reduce' });
      await context.route('**/*', route => { if (route.request().url().startsWith(origin + '/')) return route.continue(); external.push(route.request().url()); return route.abort(); });
      const page = await context.newPage(), errors = []; activePage = page;
      page.on('pageerror', error => { errors.push(error.message); runtimeErrors.push(error.message); });
      page.on('console', message => { if (message.type() === 'error') runtimeErrors.push(message.text()); });
      await page.goto(`${origin}/fixture?theme=${theme}&surface=${surface}`);
      await expect(page.getByRole('heading', { name: 'Build selection', exact: true })).toBeVisible(); expect(calls.filter(call => call.path.endsWith('/build-intent'))).toEqual([]); checks += 2;
      const change = page.getByRole('button', { name: 'Change build', exact: true }); await change.focus(); await page.keyboard.press('Enter');
      const card = page.getByTestId('build-checkin-card'); await expect(card).toBeVisible();
      await card.getByRole('button', { name: 'Change…', exact: true }).click();
      const picker = card.getByRole('combobox'); await expect(picker).toBeFocused(); await picker.fill('DT');
      await card.getByRole('option', { name: /DT into 3 Gate/ }).click(); await card.getByRole('button', { name: 'Confirm DT into 3 Gate', exact: true }).click();
      await expect(card.getByText('Planned build', { exact: true })).toBeVisible(); expect(calls.filter(call => call.body?.action === 'confirm')).toHaveLength(1); checks += 4;
      await shot(page, `macro-build-${surface}-${theme}-${width}`);
      await card.getByRole('button', { name: 'Change…', exact: true }).click(); await card.getByRole('button', { name: 'Add new build…', exact: true }).click();
      const editor = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /Add|Create|Build editor|Save as new build/i }) }).last();
      await expect(editor).toBeVisible(); await page.keyboard.press('Escape'); await expect(editor).toHaveCount(0);
      if (surface === 'modal') await expect(page.getByRole('button', { name: 'Close macro breakdown', exact: true })).toBeVisible(); checks += 2;
      await page.getByRole('button', { name: 'Close build selection', exact: true }).click(); await expect(change).toBeFocused(); checks++;
      await change.click(); await expect(card).toBeVisible(); await page.evaluate(() => window.fixtureGame('g2')); await expect(page.getByRole('button', { name: 'Change build', exact: true })).toBeVisible(); await expect(card).toHaveCount(0); checks += 2;
      await page.getByRole('button', { name: 'Change build', exact: true }).click(); await expect(card).toBeVisible(); await page.evaluate(() => window.fixtureAuth('synthetic-b')); await expect(card).toHaveCount(0); await page.evaluate(() => window.fixtureAuth('synthetic-a')); await expect(card).toHaveCount(0); checks += 2;
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]); checks += 2;
      await context.close(); console.log(JSON.stringify({ width, theme, surface, checks, captures }));
    }
    expect(unexpected).toEqual([]); expect(external).toEqual([]); checks += 2;
    console.log(JSON.stringify({ checks, captures, screenshots: shots, externalTraffic: 'blocked', persistence: 'synthetic in-memory API only' }));
  } catch (error) {
    console.error(JSON.stringify({ calls, unexpected, external, runtimeErrors: runtimeErrors.slice(-20), body: activePage && !activePage.isClosed() ? await activePage.locator('body').innerText() : null }));
    if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: path.join(shots, 'macro-build-failure.png'), fullPage: false });
    throw error;
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
