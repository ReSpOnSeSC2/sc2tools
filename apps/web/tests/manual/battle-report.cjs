/* Run in apps/web after the final production build: node tests/manual/battle-report.cjs.
 * Real game/report/player/SWR code, production CSS/fonts, synthetic local auth/API only.
 * Every non-local request is blocked and every API write is rejected.
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');
execFileSync(process.execPath, ['tests/manual/battle-report-fixture.cjs'], { stdio: 'inherit' });
const { reportFixtures, intent, confirmedResponse, opponentState, makeSegmentFixture } = require(path.resolve('.tmp/battle-report-data.cjs'));
const root = process.cwd(), origin = 'http://127.0.0.1:3232';
const css = fs.readdirSync('.next/static/css', { recursive: true }).filter(name => name.endsWith('.css')).map(name => fs.readFileSync(path.join('.next/static/css', name), 'utf8')).join('\n');
const extra = fs.existsSync('.tmp/battle-report-fixture.css') ? fs.readFileSync('.tmp/battle-report-fixture.css', 'utf8') : '';
const fonts = `@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureSerif;src:url('/fonts/fraunces-latin-normal.woff2');font-weight:100 900}@font-face{font-family:FixtureSerif;src:url('/fonts/fraunces-latin-italic.woff2');font-style:italic;font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay;--font-serif:FixtureSerif}`;
const segmented = makeSegmentFixture(playback => { playback.mapName = 'Alcyone LE'; });
function data(id) {
  const source = reportFixtures.find(row => row.game.gameId === id) ?? reportFixtures[id === 'segmented' ? 0 : 2];
  const game = { ...source.game, gameId: id, map: 'Alcyone LE', replayAvailable: false };
  if (id === 'segmented') game.durationSec = 240;
  if (id === 'long-names') { game.opponent = { ...game.opponent, displayName: '0:00_' + 'LongRecordedName'.repeat(12) }; game.myBuild = 'ARecordedOpeningWithoutSpaces'.repeat(6); }
  const macro = source.breakdown ? { ...source.breakdown, player_stats: { me: { name: 'Fixture player' }, opponent: { name: game.opponent.displayName } } } : null;
  const build = { ok: true, game_id: id, my_build: game.myBuild, opp_strategy: game.opponent.strategy, my_race: game.myRace, opp_race: game.opponent.race, opponent: game.opponent.displayName, map: game.map, result: game.result, events: source.buildEvents ?? [], opp_events: [], early_events: [], opp_early_events: [], my_status: 'ok', opp_status: 'empty' };
  const checkin = intent({ ...confirmedResponse('custom:fixture-plan', source.plannedBuild), gameId: id, myRace: game.myRace, oppRace: game.opponent.race, map: game.map, result: game.result, date: game.date, durationSec: game.durationSec, oppName: game.opponent.displayName, options: [], detected: { name: game.detectedBuild, slug: null, key: null }, opponent: opponentState({ label: game.opponent.strategy, detected: { name: game.opponent.strategy, slug: null, key: null } }) });
  const unit = { Protoss: 'Stalker', Terran: 'Marauder', Zerg: 'Roach' };
  const playback = { v: 5, mapName: game.map, gameLength: game.durationSec, bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 }, spawns: [], resources: [], buildings: [], battles: [{ t: 120, x: 60, y: 50 }], units: [{ owner: 'me', name: unit[game.myRace], born: 0, died: null, wp: [0, 50, 50, game.durationSec, 50, 50], attacks: [100] }, { owner: 'opp', name: unit[game.opponent.race], born: 0, died: null, wp: [0, 65, 55, game.durationSec, 65, 55], attacks: [110] }], stats: { me: [], opp: [] }, fidelity: { positions: id === 'sparse-legacy' ? 'tracker' : 'engine', paths: 'observed', attacks: 'observed', creep: 'estimated', complete: true } };
  return { game, macro, build, checkin, playback };
}
const writes = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin), pathname = url.pathname;
  const json = (value, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (pathname.startsWith('/v1/')) {
    if (req.method !== 'GET') { writes.push({ path: pathname, method: req.method }); return json({ error: { code: 'write_blocked' } }, 405); }
    if (pathname === '/v1/map-image' && url.searchParams.get('map') === 'Alcyone LE') { res.setHeader('Content-Type', 'image/jpeg'); return res.end(fs.readFileSync(path.resolve(root, '../replay-engine/data/map-images/alcyone_le.jpg'))); }
    if (req.headers.authorization !== 'Bearer synthetic-local-token') return json({ error: { code: 'auth_required' } }, 401);
    if (pathname === '/v1/me') return json({ agentLastSeenAt: null });
    if (pathname === '/v1/me/profile') return json({ displayName: 'Fixture player' });
    if (pathname === '/v1/games/vod-links') return json({ linksByGameId: {} });
    const match = /^\/v1\/games\/([^/]+)(.*)$/.exec(pathname);
    if (!match) return json({});
    const id = decodeURIComponent(match[1]), suffix = match[2], fixture = data(id);
    if (!suffix) return json(fixture.game);
    if (suffix === '/build-order') return json(fixture.build);
    if (suffix === '/build-intent') return json(fixture.checkin);
    if (suffix === '/macro-breakdown') return fixture.macro ? json(fixture.macro) : json({ error: { code: 'macro_not_computed' } }, 404);
    if (suffix === '/context') return json({ matchup: `${fixture.game.myRace[0]}v${fixture.game.opponent.race[0]}`, personal: { n: 0, limit: 50, build: fixture.game.myBuild, expansionTimings: {}, expansionSample: 0, expansionLimit: 25, expansionMinSample: 5, metrics: Object.fromEntries(['macroScore', 'apm', 'spq', 'durationSec'].map(metric => [metric, { n: 0, median: null, p25: null, p75: null }])) }, league: null });
    if (suffix === '/neighbors') return json({ prev: null, next: null });
    if (suffix === '/map-playback/status') return json({ rebuild: null });
    if (suffix === '/map-playback/manifest') return id === 'segmented' ? json(segmented.raw) : json({ error: { code: 'playback_artifact_not_found' } }, 404);
    if (suffix === '/map-playback') return id === 'missing-detail' ? json({ error: { code: 'playback_not_computed' } }, 404) : json(fixture.playback);
    const segment = /\/segments\/(\d+)$/.exec(suffix);
    if (id === 'segmented' && segment) { const bytes = Buffer.from(segmented.bytes[Number(segment[1])]); res.setHeader('Content-Type', 'application/json'); res.setHeader('Content-Length', bytes.length); return res.end(bytes); }
    return json({});
  }
  if (pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync('.tmp/battle-report-fixture.js')); }
  if (pathname.startsWith('/app')) { const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light'; res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(`<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${extra}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`); }
  const base = pathname.startsWith('/fonts/') ? path.join(root, 'app/fonts') : path.join(root, 'public');
  const file = path.resolve(base, pathname.startsWith('/fonts/') ? pathname.slice(7) : pathname.slice(1));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', ({ '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
});

(async () => {
  await new Promise(resolve => server.listen(3232, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true }); let checks = 0;
  const makeContext = async width => { const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] }); await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort()); return context; };
  try {
    for (const width of [320, 390, 768, 1440]) {
      const context = await makeContext(width), page = await context.newPage(), errors = [], requests = [], mapImages = [];
      page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/v1/')) requests.push({ path: new URL(request.url()).pathname, method: request.method() }); });
      page.on('response', response => { if (new URL(response.url()).pathname === '/v1/map-image') mapImages.push(response.status()); });
      await page.goto(origin + '/app/game/macro-win'); const report = page.locator('#battle-report');
      await expect(report.getByRole('button', { name: 'Copy text', exact: true })).toBeEnabled(); await expect(report.getByRole('figure')).toHaveCount(3); checks++;
      await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(2200);
      expect(mapImages.length).toBeGreaterThan(0); expect(mapImages.every(status => status === 200)).toBe(true); checks++;
      await expect(page.getByRole('heading', { name: /Your usual and your league/ })).toBeVisible(); checks++;
      expect(requests.filter(row => row.path.endsWith('/map-playback/manifest'))).toHaveLength(1); expect(requests.filter(row => row.path.endsWith('/map-playback'))).toHaveLength(1); checks++;
      const before = await report.locator('[data-report-paragraph]').allTextContents();
      await report.getByRole('button', { name: 'Tactical', exact: true }).click(); expect(await report.locator('[data-report-paragraph]').allTextContents()).not.toEqual(before);
      await report.getByRole('button', { name: 'Caster', exact: true }).click(); await report.getByRole('button', { name: 'Battle report', exact: true }).click(); expect(await report.locator('[data-report-paragraph]').allTextContents()).toEqual(before); checks++;
      await report.getByRole('button', { name: 'Copy text', exact: true }).click(); expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('No AI.');
      await report.getByRole('button', { name: 'Copy Markdown', exact: true }).click(); expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('/app/game/macro-win?t='); checks++;
      const color = await report.locator('canvas').first().evaluate(canvas => { const actual = canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data; const expected = getComputedStyle(canvas.parentElement).getPropertyValue('--race-terran').trim().split(/\s+/).map(Number); return { actual: Array.from(actual).slice(0, 3), expected, size: [canvas.width, canvas.height], box: [canvas.parentElement.clientWidth, canvas.parentElement.clientHeight], alpha: actual[3] }; });
      if (color.expected.some((value, index) => Math.abs(color.actual[index] - value) > 3)) console.log(JSON.stringify({ width, color }));
      color.expected.forEach((value, index) => expect(Math.abs(color.actual[index] - value)).toBeLessThanOrEqual(3)); checks++;
      const player = page.locator('#replay canvas'); await player.first().evaluate(canvas => { canvas.dataset.fixtureMounted = 'same-player'; });
      const link = report.getByRole('link', { name: /^Seek replay to/ }).filter({ hasText: '2:00' }).first(); await link.click(); await expect(page.getByLabel('Scrub game time')).toHaveValue('120');
      await expect(player.first()).toHaveAttribute('data-fixture-mounted', 'same-player'); expect(await report.locator('[data-report-paragraph]').allTextContents()).toEqual(before); checks++;
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`Report overflow ${width}`);
      // Capture this tall section without the page's sticky chrome being painted over it.
      await page.evaluate(() => scrollTo(0, 0));
      await report.screenshot({ path: `../../docs/handoff/screenshots/battle-report-${width}.png`, style: 'header, nav[aria-label="Game sections"] { position: static !important; }' }); checks++;
      if (errors.length) throw new Error(JSON.stringify(errors)); console.log(JSON.stringify({ width, checks, errors })); await context.close();
    }
    for (const [id, theme] of [['zerg-mirror', 'dark'], ['missing-detail', 'light'], ['segmented', 'dark'], ['long-names', 'light'], ['short-gg', 'light']]) {
      const context = await makeContext(390), page = await context.newPage(), requests = [], errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/v1/')) requests.push(new URL(request.url()).pathname); });
      await page.goto(`${origin}/app/game/${id}?theme=${theme}`); const report = page.locator('#battle-report'); await expect(report.getByRole('button', { name: 'Copy text', exact: true })).toBeEnabled(); await page.evaluate(() => document.fonts.ready); checks++;
      if (id === 'zerg-mirror') {
        await expect(report.getByText('You · Zerg · solid').first()).toBeVisible(); await expect(report.getByText('Opponent · Zerg · outline').first()).toBeVisible(); await page.waitForTimeout(2200); checks++;
        const probe = () => report.locator('canvas').first().evaluate(canvas => {
          const context = canvas.getContext('2d'), ratio = devicePixelRatio || 1, w = canvas.width / ratio, h = canvas.height / ratio, k = Math.min((w - 8) / 100, (h - 8) / 100);
          const expected = getComputedStyle(canvas.parentElement).getPropertyValue('--race-zerg').trim().split(/\s+/).map(Number);
          const pixel = (x, y) => Array.from(context.getImageData(Math.floor(x * ratio), Math.floor(y * ratio), 1, 1).data).slice(0, 3);
          const matches = value => expected.every((v, index) => Math.abs(v - value[index]) <= 4);
          let ring = false; for (let y = -6; y <= 6; y++) for (let x = -6; x <= 6; x++) if (matches(pixel(w / 2 + 15 * k + x, h / 2 - 5 * k + y))) ring = true;
          return { own: matches(pixel(w / 2, h / 2)), opponentCenter: matches(pixel(w / 2 + 15 * k, h / 2 - 5 * k)), ring };
        });
        expect(await probe()).toEqual({ own: true, opponentCenter: false, ring: true }); checks++;
        for (const next of ['light', 'dark']) { await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), next); await expect.poll(probe).toEqual({ own: true, opponentCenter: false, ring: true }); } checks++;
      }
      if (id === 'missing-detail') { await expect(report.getByText('No army-value samples near this moment.').first()).toBeVisible(); await expect(report.getByText('Recorded army-value samples appear when available. Map snapshots need map data synced by the desktop app.').first()).toBeVisible(); await expect(report.locator('canvas')).toHaveCount(0); checks++; }
      if (id === 'segmented') {
        await expect(page.locator('#replay canvas')).toBeVisible(); const before = await report.locator('[data-report-paragraph]').allTextContents();
        expect(requests.filter(value => /\/segments\//.test(value))).toHaveLength(1); await expect(report.locator('canvas')).toHaveCount(0); checks++;
        await report.getByRole('button', { name: /^Seek replay to 2:00:/ }).first().click(); await expect(page.getByLabel('Scrub game time')).toHaveValue('120'); await page.waitForTimeout(600);
        expect(await report.locator('[data-report-paragraph]').allTextContents()).toEqual(before); expect(requests.some(value => value.endsWith('/segments/2'))).toBe(true); checks++;
      }
      if (id === 'long-names') { await expect(report.getByText(/0:00_LongRecordedName/)).toBeVisible(); if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Long-name report overflow'); checks++; }
      if (id === 'short-gg') {
        await expect(report.locator('[data-report-paragraph]')).toHaveCount(1); checks++;
        await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('Fixture clipboard denial')) } }));
        await report.getByRole('button', { name: 'Copy text', exact: true }).click(); const fallback = report.getByRole('textbox', { name: 'Copy this battle report' }); await expect(fallback).toBeFocused(); expect(await fallback.inputValue()).toContain('No AI.'); checks++;
      }
      expect(errors).toEqual([]); checks++;
      await page.evaluate(() => scrollTo(0, 0));
      await report.screenshot({ path: `../../docs/handoff/screenshots/battle-report-${id}-${theme}-390.png`, style: 'header, nav[aria-label="Game sections"] { position: static !important; }' }); checks++; await context.close();
    }
    expect(writes).toEqual([]); console.log(`${checks} real browser checks passed; no API writes or non-local traffic allowed`);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
