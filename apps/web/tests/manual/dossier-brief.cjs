/* Run from apps/web after the final production build: node tests/manual/dossier-brief.cjs.
 * Real chrome/analyzer/profile/brief/series/history/notes/identity/ladder; local synthetic data only.
 */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process'), { chromium, expect } = require('@playwright/test');
execFileSync(process.execPath, ['tests/manual/dossier-brief-fixture.cjs'], { stdio: 'inherit' });
const root = process.cwd(), origin = 'http://127.0.0.1:3234';
const css = fs.readdirSync('.next/static/css', { recursive: true }).filter(name => name.endsWith('.css')).map(name => fs.readFileSync(path.join('.next/static/css', name), 'utf8')).join('\n');
const extra = fs.existsSync('.tmp/dossier-brief-fixture.css') ? fs.readFileSync('.tmp/dossier-brief-fixture.css', 'utf8') : '';
const fonts = `@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureSerif;src:url('/fonts/fraunces-latin-normal.woff2');font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay;--font-serif:FixtureSerif}`;
const games = Array.from({ length: 14 }, (_, index) => ({ id: `fixture-game-${index}`, date: new Date(Date.UTC(2026, 9, 20 - index, 12)).toISOString(), result: index < 3 ? 'Defeat' : index % 3 ? 'Victory' : 'Defeat', map: index % 2 ? 'Alcyone LE' : 'Ghost River LE', my_build: index % 2 ? 'Blink opener' : 'Safe expand', opp_strategy: index % 2 ? 'Roach pressure' : 'Ling opener', my_race: 'P', opp_race: 'Z', game_length: 900, macro_score: 65, my_mmr: 4200, opp_mmr: 4250 }));
function profile(id, query) {
  const empty = id === 'zero' && query.has('since'), scoped = empty ? [] : games;
  return { pulseId: id, name: id === 'barcode' ? 'IIIIIIIIIIII' : 'Replay rival', displayNameSample: id === 'barcode' ? 'IIIIIIIIIIII' : 'Replay rival', pulseCharacterId: id === 'barcode' ? null : '123456', toonHandle: '1-S2-1-123456', mmr: 4250, firstSeen: '2025-03-01T00:00:00Z', lastSeen: '2026-10-19T12:00:00Z', series: { firstSeen: '2024-01-01T00:00:00Z', lastSeen: games[0].date, sourceLimit: 1000, truncated: id === 'truncated', games }, totals: { wins: empty ? 0 : 7, losses: empty ? 0 : 7, total: scoped.length, winRate: empty ? 0 : .5 }, byMap: empty ? {} : { 'Alcyone LE': { wins: 4, losses: 3 }, 'Ghost River LE': { wins: 3, losses: 4 } }, byStrategy: empty ? {} : { 'Roach pressure': { wins: 4, losses: 3 }, 'Ling opener': { wins: 3, losses: 4 } }, predictedStrategies: [{ strategy: 'Roach pressure', probability: .65 }, { strategy: 'Ling opener', probability: .35 }], myRace: 'P', oppRaceModal: 'Z', games: scoped, gamesTruncated: id === 'truncated', communityAvailable: id !== 'private', notes: 'Synthetic scouting note: check the third base.', notesReadAloud: false };
}
const attempts = new Map(), recovered = new Set(), writes = [], reads = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin), pathname = url.pathname;
  const json = (value, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (pathname === '/v1/player-channels/resolve' && req.method === 'POST') return json({ players: [] }); // existing read-only batch lookup
  if (pathname === '/v1/games/vod-links' && req.method === 'POST' && req.headers.authorization === 'Bearer synthetic-local-token') return json({ linksByGameId: {} }); // existing owner-scoped read-only batch lookup
  if (pathname === '/v1/map-image') { const key = { 'Alcyone LE': 'alcyone_le', 'Ghost River LE': 'ghost_river_le' }[url.searchParams.get('map')], file = key && path.resolve(root, `../replay-engine/data/map-images/${key}.webp`); if (file && fs.existsSync(file)) { res.setHeader('Content-Type', 'image/webp'); return res.end(fs.readFileSync(file)); } res.statusCode = 404; return res.end(); }
  if (pathname.startsWith('/v1/')) {
    if (req.method !== 'GET') { writes.push({ path: pathname, method: req.method }); return json({ error: { code: 'write_blocked' } }, 405); }
    reads.push({ path: pathname, query: url.search });
    if (pathname === '/v1/seasons') return json({ items: [], current: null, source: 'fallback', fetchedAt: null });
    if (pathname === '/v1/site/banner') return json({ banner: null });
    if (pathname === '/v1/ping') return json({ ok: true });
    if (req.headers.authorization !== 'Bearer synthetic-local-token') return json({ error: { code: 'auth_required' } }, 401);
    if (pathname === '/v1/me') return json({ userId: 'synthetic-local-fixture', isAdmin: false, agentLastSeenAt: null, games: { total: 14, latest: games[0].date } });
    if (pathname === '/v1/me/profile') return json({ displayName: 'Fixture player' });
    if (pathname === '/v1/coaching/me') return json({ role: 'none' });
    if (pathname === '/v1/coaching/alerts') return json({ pending: 0, items: [] });
    if (pathname.endsWith('/unread-count')) return json({ count: 0 });
    const match = /^\/v1\/opponents\/([^/]+)(.*)$/.exec(pathname);
    if (!match) return json({});
    const id = decodeURIComponent(match[1]), suffix = match[2];
    if (!suffix) {
      attempts.set(id, (attempts.get(id) || 0) + 1);
      if (id === 'missing') return json({ error: { code: 'not_found' } }, 404);
      if (id === 'busy' && attempts.get(id) < 4) return json({ error: { code: 'opponent_profile_busy', message: 'Synthetic busy gate' } }, 503);
      if (id === 'network' && !recovered.has(id)) return req.destroy();
      return json(profile(id, url.searchParams));
    }
    if (suffix === '/games') { const source = profile(id, url.searchParams).games; return json({ items: url.searchParams.has('map') ? source.filter(row => row.map === url.searchParams.get('map')) : source, nextCursor: null }); }
    if (suffix === '/pulse-races') return json({ resolved: true, races: [{ race: 'Z', mmr: 4250, games: 45, league: 'Diamond', region: 'NA' }], topRace: 'Z', topMmr: 4250 });
    if (suffix === '/pulse-intel') return json({ intel: { characterId: '123456', region: 'NA', current: { rating: 4250, wins: 30, losses: 15, leagueType: 4, tier: 1, region: 'NA', season: 67, globalRank: null, lastPlayed: games[0].date }, league: { type: 4, label: 'Diamond', tier: 1 }, percentile: 15, peakRating: 4400, leagueMax: null, totalGamesPlayed: 500, ratingHistory: [], pro: null, linkedCharacters: [], pulseProfileUrl: 'https://sc2pulse.nephest.com/sc2/?type=character&id=123456' } });
    if (suffix === '/identity-submissions') return json({ isAdmin: false, eligible: true, source: { key: `pulse:${id}`, pulseId: id, displayName: 'IIIIIIIIIIII', race: 'Z', region: 'NA' }, confirmed: null, submission: null, replayCount: 14 });
    if (suffix === '/identity-candidates') return json({ status: 'not_eligible' });
    if (suffix === '/diagnostics') return json({ pulseId: id, pulseCharacterId: id === 'barcode' ? null : '123456', toonHandle: '1-S2-1-123456', displayNameSample: 'Replay rival', region: 'NA', mmr: 4250, mmrFetchedAt: games[0].date, pulseResolveAttemptedAt: games[0].date, leagueId: 4, gameCount: 14, inReplayMmrCount: 14, pulseIdStatus: id === 'barcode' ? 'unresolved' : 'resolved', mmrStatus: 'present', findings: [{ code: 'fixture', severity: 'info', message: 'Synthetic diagnostic boundary.' }] });
    return json({});
  }
  if (pathname === '/api/site/stats') return json({ agentDownloads: 42, activeAgents: 0, activeUsers: 1, generatedAt: new Date().toISOString(), activityWindowSeconds: 60 });
  if (pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync('.tmp/dossier-brief-fixture.js')); }
  if (pathname.startsWith('/app')) { const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light'; res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(`<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${extra}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`); }
  const base = pathname.startsWith('/fonts/') ? path.join(root, 'app/fonts') : path.join(root, 'public'), file = path.resolve(base, pathname.startsWith('/fonts/') ? pathname.slice(7) : pathname.slice(1));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', ({ '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
});

(async () => {
  await new Promise(resolve => server.listen(3234, '127.0.0.1', resolve)); const browser = await chromium.launch({ headless: true }); let checks = 0;
  const contextFor = async width => { const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] }); await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort()); return context; };
  try {
    for (const [width, theme] of (process.env.DOSSIER_SCENARIOS_ONLY ? [] : [320, 390, 768, 1440].flatMap(width => [[width, 'light'], [width, 'dark']]))) {
      const context = await contextFor(width), page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/app/opponents/normal?theme=${theme}&since=2026-10-01T00%3A00%3A00.000Z&until=2026-10-25T00%3A00%3A00.000Z`); await expect(page.getByRole('heading', { level: 1, name: 'Replay rival' })).toBeVisible(); await expect(page.locator('h1')).toHaveCount(1); checks++;
      const brief = page.locator('#dossier-brief'); await expect(brief.getByRole('button', { name: 'Copy brief' })).toBeVisible(); await page.evaluate(() => document.fonts.ready);
      const scope = await page.locator('[data-fixture-global-scope]').textContent(); expect(JSON.parse(scope).since).toBeTruthy();
      await brief.getByRole('button', { name: 'Copy brief' }).click(); expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('This view: 7W–7L'); checks++;
      await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: `../../docs/handoff/screenshots/dossier-brief-${theme}-${width}.png` });
      if (width === 768 && theme === 'light' || width === 320 && theme === 'dark') { await page.getByRole('navigation', { name: 'Dossier sections' }).getByRole('link', { name: 'Brief', exact: true }).click(); await page.screenshot({ path: `../../docs/handoff/screenshots/dossier-brief-card-${theme}-${width}.png` }); }
      const nav = page.getByRole('navigation', { name: 'Dossier sections' }); expect(await nav.evaluate(node => getComputedStyle(node).position)).toBe('sticky'); await nav.getByRole('link', { name: 'History', exact: true }).click(); await expect(nav.getByRole('link', { name: 'History', exact: true })).toHaveAttribute('aria-current', 'true'); checks++;
      await expect(page.getByRole('heading', { name: /All replays/ })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Opponent notes', level: 3 })).toHaveCount(1); const order = await page.locator('#dossier-history').evaluate(node => Array.from(node.children).filter(child => child.tagName === 'SECTION').map(child => child.querySelector('h2,h3')?.textContent)); expect(order[0]).toContain('All replays'); expect(order[1]).toContain('Opponent notes'); checks++;
      await page.getByRole('button', { name: 'Show all time', exact: true }).click(); await expect(page.getByRole('button', { name: 'Use analyzer dates' })).toBeVisible(); expect(await page.locator('[data-fixture-global-scope]').textContent()).toBe(scope); checks++;
      await page.getByLabel('Filter dossier map').selectOption('Alcyone LE'); const href = await page.locator('#dossier-history').getByRole('link', { name: 'Open game analysis: timeline, mechanics, build orders, and Ghost Build', exact: true }).first().getAttribute('href'), captured = new URLSearchParams(new URL(href, origin).searchParams.get('fromFilters')); expect(captured.has('since')).toBe(false); expect(captured.has('until')).toBe(false); expect(captured.get('map')).toBe('Alcyone LE'); expect(captured.get('race')).toBe('P'); await page.getByRole('button', { name: 'Remove map filter Alcyone LE' }).click(); checks++;
      await page.evaluate(() => { history.pushState({}, '', '/app/opponents/other' + location.search); dispatchEvent(new Event('fixture-navigation')); }); await expect(page.getByRole('button', { name: 'Show all time', exact: true })).toBeVisible(); expect(await page.locator('[data-fixture-global-scope]').textContent()).toBe(scope); expect(reads.some(row => row.path === '/v1/opponents/other' && row.query.includes('since='))).toBe(true); checks++;
      await expect(page.getByText('First met Jan 2024')).toBeVisible(); await expect(page.getByRole('link', { name: 'Community profile', exact: true })).toBeVisible(); const identity = page.locator('#dossier-identity details').first(); expect(await identity.getAttribute('open')).toBeNull(); checks++;
      await page.getByRole('link', { name: 'Data looks wrong?' }).click(); await expect(identity).toHaveAttribute('open', ''); await expect(page.getByText('Synthetic diagnostic boundary.')).toBeVisible(); checks++;
      await nav.getByRole('link', { name: 'Ladder', exact: true }).click(); await expect(page.getByRole('heading', { name: /^Ladder context/ })).toBeVisible(); await expect(page.getByRole('heading', { name: 'MMR by race', exact: true })).toBeVisible(); checks++;
      if (width >= 768) { const table = page.locator('#dossier-history table'), scroll = table.locator('..'); await scroll.scrollIntoViewIfNeeded(); await scroll.evaluate(node => { node.scrollLeft = node.scrollWidth; }); expect(await scroll.evaluate(node => node.scrollLeft)).toBeGreaterThan(0); await table.getByRole('link', { name: 'Open game analysis: timeline, mechanics, build orders, and Ghost Build', exact: true }).first().click({ trial: true }); checks++; }
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) { console.log(JSON.stringify(await page.evaluate(() => Array.from(document.querySelectorAll('body *')).filter(node => node.getBoundingClientRect().right > innerWidth + 1).slice(0, 20).map(node => ({tag:node.tagName,class:String(node.className).slice(0,160),position:getComputedStyle(node).position,right:node.getBoundingClientRect().right,text:node.textContent.slice(0,50)}))))); throw new Error(`Dossier overflow ${width}`); }
      expect(errors).toEqual([]); checks++; console.log(JSON.stringify({ width, theme, checks, errors })); await context.close();
    }
    for (const id of ['zero', 'truncated', 'barcode', 'private', 'busy', 'missing', 'network']) {
      const context = await contextFor(390), page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message)); await page.goto(`${origin}/app/opponents/${id}?theme=light`);
      if (id === 'missing') { await expect(page.getByText('Not in your history', { exact: true })).toBeVisible(); checks++; }
      else if (id === 'busy') { await expect(page.getByText('Analyzing… retrying', { exact: true })).toBeVisible(); await page.screenshot({ path: '../../docs/handoff/screenshots/dossier-brief-busy-state-light-390.png' }); await expect(page.getByRole('heading', { level: 1, name: 'Replay rival' })).toBeVisible({ timeout: 10000 }); expect(attempts.get(id)).toBeGreaterThanOrEqual(2); checks++; }
      else if (id === 'network') { await expect(page.getByRole('button', { name: 'Retry', exact: true }).first()).toBeVisible(); await page.screenshot({ path: '../../docs/handoff/screenshots/dossier-brief-network-error-light-390.png' }); recovered.add(id); await page.getByRole('button', { name: 'Retry', exact: true }).first().click(); await expect(page.getByRole('heading', { level: 1, name: 'Replay rival' })).toBeVisible(); checks++; }
      else {
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible(); const brief = page.locator('#dossier-brief'); await expect(brief.getByRole('button', { name: 'Copy brief' })).toBeVisible();
        if (id === 'zero') { await expect(page.getByText(/No games in this range/)).toBeVisible(); await page.getByText(/No games in this range/).scrollIntoViewIfNeeded(); await page.screenshot({ path: '../../docs/handoff/screenshots/dossier-brief-zero-state-light-390.png' }); await page.getByRole('button', { name: 'Show all time', exact: true }).last().click(); await expect(page.getByText(/No games in this range/)).toHaveCount(0); await expect(brief.getByText(/This view: 7W–7L/)).toBeVisible(); checks++; }
        if (id === 'truncated') { await expect(page.getByText(/Streaks use latest 14 meetings/)).toBeVisible(); await expect(page.getByText(/Best in sample:/)).toBeVisible(); checks++; }
        if (id === 'private') { await expect(page.getByRole('link', { name: 'Community profile', exact: true })).toHaveCount(0); await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('Synthetic denial')) } })); await brief.getByRole('button', { name: 'Copy brief' }).click(); const field = brief.getByRole('textbox', { name: 'Copy this scouting brief' }); await expect(field).toBeFocused(); expect(await field.inputValue()).toContain('This view:'); checks++; }
        if (id === 'barcode') { await expect(page.locator('#dossier-identity details').first()).toHaveAttribute('open', ''); const suggest = page.getByRole('button', { name: 'Know who this is? Suggest an identity' }); await expect(suggest).toBeVisible(); await expect(page.getByRole('textbox', { name: 'Why is this the same player?' })).toHaveCount(0); await suggest.scrollIntoViewIfNeeded(); await page.screenshot({ path: '../../docs/handoff/screenshots/dossier-brief-barcode-prompt-light-390.png' }); await suggest.click(); await expect(page.getByRole('textbox', { name: 'Why is this the same player?' })).toBeVisible(); checks++; }
      }
      expect(errors).toEqual([]); checks++; await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: `../../docs/handoff/screenshots/dossier-brief-${id}-light-390.png` }); await context.close();
    }
    expect(writes).toEqual([]); console.log(`${checks} real dossier browser checks passed; no API writes or nonlocal traffic allowed`);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
