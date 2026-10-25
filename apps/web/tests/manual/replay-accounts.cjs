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
const mutations = [], hiddenGames = new Map();
const resetHidden = () => { hiddenGames.clear(); hiddenGames.set('hidden-one', { gameId: 'hidden-one', map: 'Hidden synthetic map', opponent: 'Synthetic rival', reason: 'friend_played', excluded: true }); hiddenGames.set('pending-one', { gameId: 'pending-one', map: '', opponent: '', reason: null, pendingDeletion: true, excluded: true }); };
resetHidden();
const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin), send = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (url.pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); return res.end(fs.readFileSync(path.join(repo, '.cache/replay-accounts-fixture.js'))); }
  if (url.pathname.startsWith('/app')) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(`<!doctype html><html data-theme="${url.searchParams.get('theme') === 'light' ? 'light' : 'dark'}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${fonts}</style></head><body class="bg-bg text-text"><div id="root"></div><script src="/fixture.js"></script></body></html>`); }
  if (url.pathname === '/v1/game-accounts') return send({ items: accounts });
  if (url.pathname === '/fixture-reset') { resetHidden(); mutations.length = 0; return send({ ok: true }); }
  if (url.pathname === '/v1/games/hidden') return send({ items: [...hiddenGames.values()], nextCursor: null });
  if (/^\/v1\/games\/[^/]+$/.test(url.pathname) && ['PATCH', 'DELETE'].includes(req.method)) {
    let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
      const body = JSON.parse(raw || '{}'), gameId = decodeURIComponent(url.pathname.split('/').pop()); mutations.push({ method: req.method, gameId, body });
      if (req.method === 'DELETE') { if (body.confirmation !== 'DELETE GAME') { res.statusCode = 400; return send({ error: { code: 'delete_confirmation_required' } }); } hiddenGames.delete(gameId); return send({ gameId, deleted: true }); }
      if (body.excluded) hiddenGames.set(gameId, { gameId, map: 'Synthetic first map', opponent: 'Synthetic rival', reason: body.reason, excluded: true }); else hiddenGames.delete(gameId);
      return send({ gameId, excluded: body.excluded });
    }); return;
  }
  if (url.pathname === '/v1/replays') return send({ profile: { handle: 'synthetic-owner', displayName: 'Synthetic owner' }, items: [game, { ...game, gameId: 'synthetic-second', map: 'Synthetic second map' }], page: { hasMore: true, nextCursor: 'synthetic-cursor' }, total: 2, summary: { total: 2, wins: 1, losses: 1, ties: 0, avgDurationSec: 630 } });
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
    for (const [width, theme] of [320, 390, 768, 1440].flatMap(width => [[width, 'light'], [width, 'dark']])) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
      await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
      await context.request.get(`${origin}/fixture-reset`);
      await page.goto(`${origin}/app/replays?fixtureControls=1&theme=${theme}`);
      await expect(page.getByRole('heading', { name: 'Replay data controls' })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const single = page.locator('[data-fixture-single]'), bulk = page.locator('[data-fixture-bulk]');
      await single.getByRole('button', { name: 'Hide from stats', exact: true }).click();
      let dialog = page.getByRole('dialog'); await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused(); checks++;
      await expect(dialog.getByRole('button', { name: 'Other', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await dialog.getByRole('button', { name: 'Friend played', exact: true }).click();
      const target = await dialog.getByRole('button', { name: 'Friend played', exact: true }).boundingBox(); expect(target.height).toBeGreaterThanOrEqual(44); checks++;
      if (width === 320 && theme === 'dark' || width === 1440 && theme === 'light') await page.screenshot({ path: `../../docs/handoff/screenshots/replay-controls-hide-${theme}-${width}.png` });
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(mutations).toHaveLength(0); checks++;
      await single.getByRole('button', { name: 'Hide from stats', exact: true }).click(); dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Disconnect or bug', exact: true }).click(); await dialog.getByRole('button', { name: 'Hide from stats', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0); expect(mutations.at(-1)).toEqual({ method: 'PATCH', gameId: 'synthetic-one', body: { excluded: true, reason: 'disconnect_bug' } }); checks++;
      await bulk.getByRole('button', { name: 'Hide from stats', exact: true }).click(); dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Off-race practice', exact: true }).click(); await dialog.getByRole('button', { name: 'Hide from stats', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0); expect(mutations.slice(-2).map(row => row.gameId)).toEqual(['synthetic-one', 'synthetic-two']); expect(mutations.slice(-2).every(row => row.body.reason === 'off_race_practice')).toBe(true); checks++;
      await single.getByRole('button', { name: 'Delete game…', exact: true }).click(); dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused(); await expect(dialog.getByRole('button', { name: 'Delete permanently' })).toBeDisabled(); checks++;
      const confirm = dialog.getByRole('textbox', { name: 'Type DELETE GAME to confirm' }); await confirm.fill('delete game'); await expect(dialog.getByRole('button', { name: 'Delete permanently' })).toBeDisabled();
      await confirm.fill('DELETE GAME'); await expect(dialog.getByRole('button', { name: 'Delete permanently' })).toBeEnabled(); checks++;
      expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      if (width === 320 && theme === 'light' || width === 1440 && theme === 'dark') await page.screenshot({ path: `../../docs/handoff/screenshots/replay-controls-delete-${theme}-${width}.png` });
      await dialog.getByRole('button', { name: 'Delete permanently' }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); expect(mutations.at(-1)).toEqual({ method: 'DELETE', gameId: 'synthetic-one', body: { confirmation: 'DELETE GAME' } }); checks++;
      await bulk.getByRole('button', { name: 'Delete selected games…', exact: true }).click(); dialog = page.getByRole('dialog');
      await dialog.getByRole('textbox', { name: 'Type DELETE 2 GAMES to confirm' }).fill('DELETE GAME'); await expect(dialog.getByRole('button', { name: 'Delete permanently' })).toBeDisabled();
      await dialog.getByRole('textbox', { name: 'Type DELETE 2 GAMES to confirm' }).fill('DELETE 2 GAMES'); await dialog.getByRole('button', { name: 'Delete permanently' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0); expect(mutations.slice(-2).map(row => row.gameId)).toEqual(['synthetic-one', 'synthetic-two']); checks++;
      await page.getByRole('button', { name: 'Refresh hidden games', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Refresh hidden games', exact: true })).toBeEnabled();
      const hidden = page.getByText('hidden-one', { exact: true }).locator('..').locator('..');
      await expect(hidden.getByRole('button', { name: 'Unhide', exact: true })).toBeVisible();
      if ([390, 768].includes(width)) await page.screenshot({ path: `../../docs/handoff/screenshots/replay-controls-hidden-${theme}-${width}.png` });
      await hidden.getByRole('button', { name: 'Unhide', exact: true }).click(); await expect(page.getByText('hidden-one', { exact: true })).toHaveCount(0); expect(mutations.at(-1)).toMatchObject({ method: 'PATCH', gameId: 'hidden-one', body: { excluded: false } }); checks++;
      await expect(page.getByRole('button', { name: 'Refresh hidden games', exact: true })).toBeFocused(); checks++;
      await page.getByRole('button', { name: 'Retry deletion…', exact: true }).click(); dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('button', { name: 'Delete permanently' })).toBeDisabled(); await dialog.getByRole('textbox', { name: 'Type DELETE GAME to confirm' }).fill('DELETE GAME'); await dialog.getByRole('button', { name: 'Delete permanently' }).click();
      await expect(page.getByText('pending-one', { exact: true })).toHaveCount(0); expect(mutations.at(-1)).toMatchObject({ method: 'DELETE', gameId: 'pending-one' }); checks++;
      const count = mutations.length, completed = await page.evaluate(() => window.fixtureCompleted);
      await single.getByRole('button', { name: 'Hide from stats', exact: true }).click(); await page.evaluate(() => window.fixtureScope()); await expect(page.getByRole('dialog')).toHaveCount(0); expect(mutations).toHaveLength(count); checks++;
      await page.evaluate(() => { window.fixtureHeldToken = new Promise(resolve => { window.fixtureReleaseToken = resolve; }); });
      await single.getByRole('button', { name: 'Hide from stats', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Hide from stats', exact: true }).click();
      await page.evaluate(() => window.fixtureScope()); await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.evaluate(() => { window.fixtureReleaseToken('synthetic-late-token'); window.fixtureHeldToken = null; });
      expect(mutations).toHaveLength(count); expect(await page.evaluate(() => window.fixtureCompleted)).toBe(completed); checks++;
      await page.evaluate(() => { window.fixtureHeldToken = new Promise(resolve => { window.fixtureReleaseToken = resolve; }); });
      await single.getByRole('button', { name: 'Delete game…', exact: true }).click(); dialog = page.getByRole('dialog'); await dialog.getByRole('textbox', { name: 'Type DELETE GAME to confirm' }).fill('DELETE GAME'); await dialog.getByRole('button', { name: 'Delete permanently' }).click();
      await page.evaluate(() => window.fixtureAuth('other-owner')); await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.evaluate(() => { window.fixtureReleaseToken('synthetic-late-token'); window.fixtureHeldToken = null; });
      expect(mutations).toHaveLength(count); expect(await page.evaluate(() => window.fixtureCompleted)).toBe(completed); checks++;
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect(errors).toEqual([]); checks++; await context.close();
    }
    for (const [width, theme] of [320, 390, 768, 1440].flatMap(width => [[width, 'light'], [width, 'dark']])) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' }), page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message)); await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
      await context.request.get(`${origin}/fixture-reset`); await page.goto(`${origin}/app/replays?filters=1&preset=all&theme=${theme}`);
      await page.getByRole('button', { name: 'Select replays', exact: true }).click();
      for (const id of ['synthetic-game', 'synthetic-second']) await page.getByRole('checkbox', { name: `Select replay ${id}`, exact: true }).check();
      await expect(page.getByText('2 selected · this page only (up to 25)', { exact: true })).toBeVisible(); checks++;
      await page.getByRole('button', { name: 'Hide from stats', exact: true }).click(); let dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused(); await dialog.getByRole('button', { name: 'Friend played', exact: true }).click(); await dialog.getByRole('button', { name: 'Hide from stats', exact: true }).click();
      await expect(dialog).toHaveCount(0); expect(mutations.slice(-2).map(row => row.gameId)).toEqual(['synthetic-game', 'synthetic-second']); await expect(page.getByText('0 selected · this page only (up to 25)', { exact: true })).toBeVisible(); checks++;
      for (const id of ['synthetic-game', 'synthetic-second']) await page.getByRole('checkbox', { name: `Select replay ${id}`, exact: true }).check();
      await page.getByRole('button', { name: 'Delete selected games…', exact: true }).click(); dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('button', { name: 'Delete permanently' })).toBeDisabled(); await dialog.getByRole('textbox', { name: 'Type DELETE 2 GAMES to confirm' }).fill('DELETE 2 GAMES');
      if (width === 320 && theme === 'dark' || width === 1440 && theme === 'light') await page.screenshot({ path: `../../docs/handoff/screenshots/replay-controls-library-delete-${theme}-${width}.png` });
      await dialog.getByRole('button', { name: 'Delete permanently' }).click(); await expect(dialog).toHaveCount(0); expect(mutations.slice(-2).map(row => row.method)).toEqual(['DELETE', 'DELETE']); checks++;
      await page.goto(`${origin}/app/replays?fixtureHeader=1&theme=${theme}`); const trigger = page.getByLabel('More game actions', { exact: true });
      await trigger.click(); await expect(page.getByRole('button', { name: 'Hide from stats', exact: true })).toBeVisible();
      if (width === 320 && theme === 'light' || width === 1440 && theme === 'dark') await page.screenshot({ path: `../../docs/handoff/screenshots/replay-controls-header-menu-${theme}-${width}.png` });
      for (const name of ['Hide from stats', 'Delete game…']) {
        const hit = await page.getByRole('button', { name, exact: true }).evaluate(node => { const r = node.getBoundingClientRect(), target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { hit: !!target && (target === node || node.contains(target)), rect: { x: r.x, y: r.y, width: r.width, height: r.height } }; });
        expect(hit.hit, `${name} is not hit-testable before Playwright auto-scroll: ${JSON.stringify(hit.rect)}`).toBe(true);
      } checks++;
      await page.keyboard.press('Escape'); await expect(trigger.locator('..')).not.toHaveAttribute('open', ''); await expect(trigger).toBeFocused(); checks++;
      await trigger.click(); await page.mouse.click(1, 1); await expect(trigger.locator('..')).not.toHaveAttribute('open', ''); checks++;
      await trigger.click(); await page.getByRole('button', { name: 'Hide from stats', exact: true }).click(); dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused(); await expect(trigger.locator('..')).not.toHaveAttribute('open', ''); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(trigger).toBeFocused(); checks++;
      await page.evaluate(() => { window.fixtureHeldToken = new Promise(resolve => { window.fixtureReleaseToken = resolve; }); });
      await trigger.click(); await page.getByRole('button', { name: 'Delete game…', exact: true }).click(); dialog = page.getByRole('dialog');
      await dialog.getByRole('textbox', { name: 'Type DELETE GAME to confirm' }).fill('DELETE GAME'); await dialog.getByRole('button', { name: 'Delete permanently' }).click();
      const focusBeforeEscape = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 300));
      await page.keyboard.press('Escape'); await page.mouse.click(1, 1); await expect(dialog).toHaveCount(1); expect(await dialog.evaluate(node => node.contains(document.activeElement)), JSON.stringify({ focusBeforeEscape, focusAfterBackdrop: await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 300)) })).toBe(true); checks++;
      await page.evaluate(() => { window.fixtureReleaseToken('synthetic-token'); window.fixtureHeldToken = null; }); await expect(dialog).toHaveCount(0); expect(mutations.at(-1)).toMatchObject({ method: 'DELETE', gameId: 'synthetic-header' }); checks++;
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect(errors).toEqual([]); checks++; await context.close();
    }
    console.log(JSON.stringify({ checks, screenshots: 28, cssFiles: fs.readdirSync('.next/static/css').filter(name => name.endsWith('.css')), externalNetwork: 'blocked' }));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
