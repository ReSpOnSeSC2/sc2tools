/* Actual game host and scorecard with production CSS/fonts. Every response is
 * synthetic, all nonlocal traffic is blocked and every write is rejected. */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');
execFileSync(process.execPath, ['tests/manual/build-execution-fixture.cjs'], { stdio: 'inherit' });
const { executionFixture, intent, confirmedResponse, opponentState } = require(path.resolve('.tmp/build-execution-data.cjs'));
const root = process.cwd(), origin = 'http://127.0.0.1:3292', evidence = path.resolve('../../.cache/build-execution-evidence');
fs.mkdirSync(evidence, { recursive: true });
const css = fs.readdirSync('.next/static/css', { recursive: true }).filter(name => name.endsWith('.css')).map(name => fs.readFileSync(path.join('.next/static/css', name), 'utf8')).join('\n');
const fonts = `@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay;--font-serif:serif}`;
const calls = [], writes = [], attempts = new Map(); let held, heldOnce = false;
function fixture(id, owner) {
  const execution = executionFixture(); if (owner === 'owner-b') { execution.build.name = 'Other owner opening'; execution.passedCount = 2; execution.matchPct = 100; execution.rules[1].pass = true; }
  if (id === 'unknown') { execution.rules[1] = { ...execution.rules[1], unavailable: true, pass: false, got: null, evidenceSec: null, evidenceKind: null, sentence: 'Nexus: evidence unavailable' }; execution.knownCount = 1; execution.matchPct = null; }
  if (id === 'small') execution.timings = execution.timings.map(row => ({ ...row, n: 2, medianSec: null, p25Sec: null, p75Sec: null, deltaSec: null }));
  if (id === 'catalog' || id === 'empty') { execution.rules = []; execution.ruleCount = execution.knownCount = execution.passedCount = 0; execution.matchPct = null; if (id === 'catalog') { execution.build.source = 'catalog'; execution.build.name = 'Catalog opening'; delete execution.build.slug; } }
  if (id === 'none') { execution.build = null; execution.source = 'none'; execution.rules = []; execution.ruleCount = execution.knownCount = execution.passedCount = 0; execution.matchPct = null; execution.timings = []; }
  if (id === 'mismatch') { execution.unavailable = 'matchup_mismatch'; execution.rules = []; execution.ruleCount = execution.knownCount = execution.passedCount = 0; execution.matchPct = null; execution.timings = []; }
  const name = execution.build?.name || null;
  const game = { gameId: id, date: '2026-10-20T12:00:00Z', result: 'Victory', myRace: 'Protoss', myBuild: name, durationSec: 600, map: 'Synthetic map', myMmr: 4100, opponent: { displayName: 'Recorded opponent', race: 'Zerg', strategy: 'Roach pressure', mmr: 4050 } };
  const events = [[0, 'Nexus'], [50, 'Assimilator'], [100, 'CyberneticsCore'], [140, 'Nexus'], [230, 'Stargate'], [290, 'Stargate']].map(([time, name]) => ({ time, name, category: 'building', is_building: true, race: 'Protoss', supply: 24 }));
  const build = { ok: true, game_id: id, my_build: name, my_race: 'Protoss', opp_race: 'Zerg', opp_strategy: 'Roach pressure', events: id === 'missing' ? [] : events, opp_events: [], my_status: id === 'missing' ? 'not_extracted' : 'ok', opp_status: 'empty' };
  const checkin = intent({ ...confirmedResponse('custom:stargate', name || 'No build'), gameId: id, myRace: 'Protoss', oppRace: 'Zerg', options: [], opponent: opponentState({ label: 'Roach pressure', detected: { name: 'Roach pressure', slug: null, key: null } }) });
  const playback = { v: 5, mapName: game.map, gameLength: 600, bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 }, spawns: [], resources: [], buildings: [], battles: [], units: [{ owner: 'me', name: 'Stalker', born: 0, died: null, wp: [0, 50, 50, 600, 50, 50], attacks: [] }, { owner: 'opp', name: 'Roach', born: 0, died: null, wp: [0, 65, 55, 600, 65, 55], attacks: [] }], stats: { me: [], opp: [] }, fidelity: { positions: 'engine', paths: 'observed', attacks: 'observed', creep: 'estimated', complete: true } };
  return { execution, game, build, checkin, playback };
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin), pathname = url.pathname, owner = (req.headers.authorization || '').replace(/^Bearer /, '');
  const json = (value, status = 200) => { if (res.destroyed) return; res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (pathname.startsWith('/v1/')) {
    calls.push({ path: pathname, owner, method: req.method });
    if (req.method !== 'GET') { writes.push(pathname); return json({ error: { code: 'write_blocked' } }, 405); }
    if (pathname === '/v1/me/profile') return json({ displayName: 'Synthetic player' });
    if (pathname === '/v1/me') return json({ agentLastSeenAt: null });
    if (pathname === '/v1/games/vod-links') return json({ linksByGameId: {} });
    const match = /^\/v1\/games\/([^/]+)(.*)$/.exec(pathname); if (!match) return json({});
    const id = decodeURIComponent(match[1]), suffix = match[2], value = fixture(id, owner);
    if (!suffix) return json(value.game);
    if (suffix === '/build-order') return json(value.build);
    if (suffix === '/build-intent') return json(value.checkin);
    if (suffix === '/build-execution') {
      const key = `${owner}:${id}`; attempts.set(key, (attempts.get(key) || 0) + 1);
      if (id === 'retry' && attempts.get(key) === 1) return json({ error: { code: 'build_execution_busy', message: 'Recorded evidence changed; retry.' } }, 503);
      if (id === 'held' && owner === 'owner-a' && !heldOnce) { heldOnce = true; held = () => json(value.execution); return; }
      return json(value.execution);
    }
    if (suffix === '/macro-breakdown') return json({ error: { code: 'macro_not_computed' } }, 404);
    if (suffix === '/context') return json({ matchup: 'PvZ', personal: { n: 0, metrics: Object.fromEntries(['macroScore', 'apm', 'spq', 'durationSec'].map(metric => [metric, { n: 0, median: null, p25: null, p75: null }])), expansionTimings: {} }, league: null });
    if (suffix === '/neighbors') return json({ prev: null, next: null });
    if (suffix === '/map-playback/manifest') return json({ error: { code: 'playback_artifact_not_found' } }, 404);
    if (suffix === '/map-playback') return json(value.playback);
    return json({});
  }
  if (pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync('.tmp/build-execution-fixture.js')); }
  if (pathname.startsWith('/app')) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(`<!doctype html><html data-theme="${url.searchParams.get('theme') === 'dark' ? 'dark' : 'light'}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`); }
  const base = pathname.startsWith('/fonts/') ? path.join(root, 'app/fonts') : path.join(root, 'public');
  const file = path.resolve(base, pathname.startsWith('/fonts/') ? pathname.slice(7) : pathname.slice(1));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', ({ '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise(resolve => server.listen(3292, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true }); let checks = 0, captures = 0;
  const context = async width => { const value = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' }); await value.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort()); return value; };
  try {
    for (const width of [320, 390, 768, 1440]) for (const theme of ['light', 'dark']) {
      const ctx = await context(width), page = await ctx.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
      const before = calls.length; await page.goto(`${origin}/app/game/current?theme=${theme}`);
      const card = page.getByRole('region', { name: 'Private build execution evidence' });
      await expect(card.getByRole('heading', { name: 'Private Stargate — 1/2 rules' })).toBeVisible(); checks++;
      expect(await card.getByRole('img', { name: /observed passes/ }).evaluate(node => getComputedStyle(node).backgroundImage)).toContain('conic-gradient'); checks++;
      await expect(card.getByText('20s later')).toBeVisible(); await expect(card.getByText('5s earlier')).toBeVisible(); checks++;
      await expect(page.getByTestId('build-column-me').getByText('+20s vs your median')).toBeVisible(); checks++;
      await expect(card.getByRole('button', { name: /First tech · Cybernetics Core/ })).toContainText('n=2'); checks++;
      const canvas = page.locator('#replay canvas').first(); await expect(canvas).toBeAttached(); await canvas.evaluate(node => node.dataset.fixtureMounted = 'same-player');
      await card.getByRole('button', { name: 'At 4:50' }).focus(); await page.keyboard.press('Enter'); await expect(page.getByLabel('Scrub game time')).toHaveValue('290'); checks++;
      await card.getByRole('button', { name: 'Deadline 6:00' }).click(); await expect(page.getByLabel('Scrub game time')).toHaveValue('360'); checks++;
      await card.getByRole('button', { name: /Natural · Nexus/ }).click(); await expect(page.getByLabel('Scrub game time')).toHaveValue('140'); await expect(canvas).toHaveAttribute('data-fixture-mounted', 'same-player'); checks++;
      if (width < 1280) { if (width < 768) { const toggle = page.getByRole('button', { name: 'Show production & build order' }); if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click(); } await page.getByRole('tab', { name: 'Build order', exact: true }).click(); }
      await expect(page.getByTestId('replay-build-order-rail').getByText('50% match')).toBeVisible(); checks++;
      const local = calls.slice(before); expect(local.filter(row => row.path.endsWith('/build-execution'))).toHaveLength(1); expect(local.some(row => /^\/v1\/(builds|custom-builds)\//.test(row.path))).toBe(false); checks++;
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); checks++;
      expect(await card.locator('button').evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().height >= 43))).toBe(true); checks++;
      await card.getByRole('button', { name: 'Practice options for Private Stargate' }).click(); await expect(page.getByRole('dialog', { name: 'Practice Private Stargate' })).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0); checks++;
      await page.evaluate(() => document.fonts.ready); await card.screenshot({ path: path.join(evidence, `scorecard-${theme}-${width}.png`), style: 'nav[aria-label="Game sections"]{visibility:hidden!important}' }); captures++;
      expect(errors).toEqual([]); checks++; await ctx.close();
    }
    for (const [id, copy] of [['unknown', 'Overall percentage withheld.'], ['small', 'Timings appear after 3 games'], ['catalog', 'Catalog builds show timings only.'], ['empty', 'This build has no rules yet.'], ['missing', 'Rules are unknown until an own build log'], ['none', 'Check in a build to grade this game.'], ['mismatch', 'no longer fits this saved definition']]) {
      const ctx = await context(390), page = await ctx.newPage(), before = calls.length;
      await page.goto(`${origin}/app/game/${id}?theme=dark`); await expect(page.getByText(copy, { exact: false }).first()).toBeVisible(); checks++;
      if (['unknown', 'catalog', 'empty', 'missing', 'none', 'mismatch'].includes(id)) { await expect(page.getByText('50% match')).toHaveCount(0); checks++; }
      if (id === 'missing') { await page.waitForLoadState('networkidle'); expect(calls.slice(before).some(row => row.path.endsWith('/build-execution'))).toBe(false); checks++; }
      await page.locator('#builds').screenshot({ path: path.join(evidence, `${id}-dark-390.png`), style: 'nav[aria-label="Game sections"]{visibility:hidden!important}' }); captures++; await ctx.close();
    }
    const ctx = await context(390), page = await ctx.newPage(); await page.goto(`${origin}/app/game/retry`);
    await page.getByRole('button', { name: 'Retry', exact: true }).first().click(); await expect(page.getByRole('heading', { name: 'Private Stargate — 1/2 rules' })).toBeVisible(); expect(attempts.get('owner-a:retry')).toBe(2); checks++;
    await page.goto(`${origin}/app/game/held`); await expect.poll(() => !!held).toBe(true);
    await page.evaluate(() => window.fixtureAuth('owner-a', false)); await expect(page.getByRole('heading', { name: 'Private Stargate — 1/2 rules' })).toHaveCount(0); checks++;
    await page.evaluate(() => window.fixtureAuth('owner-b')); await expect(page.getByRole('heading', { name: 'Other owner opening — 2/2 rules' })).toBeVisible(); held(); checks++;
    await page.evaluate(() => window.fixtureAuth('owner-a')); await expect(page.getByRole('heading', { name: 'Private Stargate — 1/2 rules' })).toBeVisible(); await expect(page.getByRole('heading', { name: /Other owner opening/ })).toHaveCount(0); checks++;
    await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') }); const axe = await page.evaluate(async () => window.axe.run(document.querySelector('[aria-label="Private build execution evidence"]'), { rules: { 'color-contrast': { enabled: false } } })); expect(axe.violations).toEqual([]); checks++;
    expect(writes).toEqual([]); checks++; await ctx.close();
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, captures, calls, writes, externalTraffic: false }, null, 2));
    console.log(JSON.stringify({ checks, captures, evidence, writes: 0 }));
  } finally { held?.(); await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
