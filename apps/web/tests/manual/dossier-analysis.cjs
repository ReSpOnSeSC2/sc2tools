/* Run from apps/web after the final production build: node tests/manual/dossier-analysis.cjs.
 * Real chrome/analyzer/profile/brief/series/history/notes/identity/ladder; local synthetic data only.
 */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process'), { chromium, expect } = require('@playwright/test');
execFileSync(process.execPath, ['tests/manual/dossier-analysis-fixture.cjs'], { stdio: 'inherit' });
const root = process.cwd(), origin = 'http://127.0.0.1:3238';
const css = fs.readdirSync('.next/static/css', { recursive: true }).filter(name => name.endsWith('.css')).map(name => fs.readFileSync(path.join('.next/static/css', name), 'utf8')).join('\n');
const extra = fs.existsSync('.tmp/dossier-analysis-fixture.css') ? fs.readFileSync('.tmp/dossier-analysis-fixture.css', 'utf8') : '';
const fonts = `@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureSerif;src:url('/fonts/fraunces-latin-normal.woff2');font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay;--font-serif:FixtureSerif}`;
const games = Array.from({ length: 14 }, (_, index) => ({ id: `fixture-game-${index}`, date: new Date(Date.UTC(2026, 9, 20 - index, 12)).toISOString(), result: index < 3 ? 'Defeat' : index % 3 ? 'Victory' : 'Defeat', map: index % 2 ? 'Alcyone LE' : 'Ghost River LE', my_build: index % 2 ? 'Blink opener' : 'Safe expand', opp_strategy: index % 2 ? 'Roach pressure' : 'Ling opener', my_race: 'P', opp_race: 'Z', game_length: 900, macro_score: 65, my_mmr: 4200, opp_mmr: 4250 }));
function profile(id, query) {
  const empty = id === 'zero' && query.has('since'), scoped = empty ? [] : games;
  return { pulseId: id, name: id === 'barcode' ? 'IIIIIIIIIIII' : 'Replay rival', displayNameSample: id === 'barcode' ? 'IIIIIIIIIIII' : 'Replay rival', pulseCharacterId: id === 'barcode' ? null : '123456', toonHandle: '1-S2-1-123456', mmr: 4250, firstSeen: '2025-03-01T00:00:00Z', lastSeen: '2026-10-19T12:00:00Z', series: { firstSeen: '2024-01-01T00:00:00Z', lastSeen: games[0].date, sourceLimit: 1000, truncated: id === 'truncated', games }, totals: { wins: empty ? 0 : 7, losses: empty ? 0 : 7, total: scoped.length, winRate: empty ? 0 : .5 }, byMap: empty ? {} : { 'Alcyone LE': { wins: 4, losses: 3 }, 'Ghost River LE': { wins: 3, losses: 4 } }, byStrategy: empty ? {} : { 'Roach pressure': { wins: 4, losses: 3 }, 'Ling opener': { wins: 3, losses: 4 } }, predictedStrategies: [{ strategy: 'Roach pressure', probability: .65 }, { strategy: 'Ling opener', probability: .35 }], myRace: 'P', oppRaceModal: 'Z', games: scoped, gamesTruncated: id === 'truncated', communityAvailable: id !== 'private', notes: 'Synthetic scouting note: check the third base.', notesReadAloud: false };
}
const phaseKeys = ['early', 'earlyMid', 'mid', 'midLate', 'late'];
const samples = [{ gameId: games[1].id, date: games[1].date }, { gameId: games[3].id, date: games[3].date }];
const timing = { source: 'opp_build_log', displayName: 'Spawning Pool', sampleCount: 2, medianSeconds: 185, medianDisplay: '3:05', p25Seconds: 175, p25Display: '2:55', p75Seconds: 205, p75Display: '3:25', lastSeenSeconds: 190, lastSeenDisplay: '3:10', trend: 'earlier', winRateWhenBuilt: .5, samples };
const analysis = {
  analysisSampleSize: 9, analysisSampleLimit: 100, analysisSampleTruncated: false, analysisCohortSize: 14, buildOrdersAvailable: 4, yourBuildOrdersAvailable: 3, buildOrdersTotal: 9,
  analyzedGameIds: games.slice(0, 9).map(row => row.id), medianTimingsOrder: ['SpawningPool', 'Forge', 'Hatchery'],
  medianTimingsLegacy: { SpawningPool: timing, Forge: { ...timing, displayName: 'Forge', source: 'build_log', medianSeconds: 650, medianDisplay: '10:50', p25Seconds: 610, p25Display: '10:10', p75Seconds: 700, p75Display: '11:40' }, Hatchery: { ...timing, displayName: 'Hatchery', sampleCount: 1 } },
  matchupTimingsLegacy: { PvZ: { timings: { SpawningPool: timing }, order: ['SpawningPool'] } },
  phases: { slug: 'fixture', name: 'Fixture phases', perspective: 'you', sampleSize: Object.fromEntries(phaseKeys.map(key => [key, 4])), perPhase: Object.fromEntries(phaseKeys.map(key => [key, { signatures: [{ key: 'stalkers', units: [{ token: 'Stalker', count: 8 }], sampleCount: 4, wins: 2, losses: 2, winRate: .5, sampleGameIds: samples.map(row => row.gameId) }], tech: [], upgrades: [] }])), finalPhaseDistribution: { early: 0, earlyMid: 1, mid: 2, midLate: 1, late: 0 }, medianCrossings: { earlyMidAt: 300, midAt: 480, midLateAt: 700, lateAt: null }, durationP95Sec: 900, flags: [] },
  transitions: { slug: 'fixture', name: 'Fixture transitions', transitions: { nodes: [{ id: 'blink', label: 'Blink opener', kind: 'build', column: 0, games: 4, wins: 2, losses: 2 }, { id: 'roach', label: 'Roach pressure', kind: 'oppStrategy', column: 1, games: 4, wins: 2, losses: 2 }, { id: 'mid', label: 'Mid', kind: 'finalPhase', column: 2, games: 4, wins: 2, losses: 2 }], edges: [{ from: 'blink', to: 'roach', games: 4, wins: 2, losses: 2, winRate: .5 }, { from: 'roach', to: 'mid', games: 4, wins: 2, losses: 2, winRate: .5 }], rare: { collapsedNodes: 0, collapsedEdges: 0 } } },
};
const attempts = new Map(), analysisAttempts = new Map(), recovered = new Set(), writes = [], reads = [];
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
    if (/^\/v1\/games\/[^/]+\/neighbors$/.test(pathname)) return json({ prev: { gameId: 'older', map: 'Alcyone LE' }, next: { gameId: 'newer', map: 'Alcyone LE' } });
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
    if (suffix === '/analysis') {
      analysisAttempts.set(id, (analysisAttempts.get(id) || 0) + 1);
      if (id === 'analysis-busy' && analysisAttempts.get(id) < 3) return json({ error: { code: 'opponent_profile_busy', message: 'Synthetic admission busy' } }, 503);
      if (id === 'analysis-network' && !recovered.has(id)) return req.destroy();
      return json(analysis);
    }
    if (suffix === '/games') { let source = profile(id, url.searchParams).games; if (url.searchParams.has('map')) source = source.filter(row => row.map === url.searchParams.get('map')); if (url.searchParams.has('analysisGameIds')) source = source.filter(row => JSON.parse(url.searchParams.get('analysisGameIds')).includes(row.id)); return json({ items: source.map(row => ({ ...row, ...(url.searchParams.has('analysisGameIds') ? { analysisSampleMember: true } : {}) })), nextCursor: null, ...(url.searchParams.has('analysisGameIds') ? { membership: { scope: 'analysis_sample', requestedGameCount: samples.length } } : {}) }); }
    if (suffix === '/pulse-races') return json({ resolved: true, races: [{ race: 'Z', mmr: 4250, games: 45, league: 'Diamond', region: 'NA' }], topRace: 'Z', topMmr: 4250 });
    if (suffix === '/pulse-intel') return json({ intel: { characterId: '123456', region: 'NA', current: { rating: 4250, wins: 30, losses: 15, leagueType: 4, tier: 1, region: 'NA', season: 67, globalRank: null, lastPlayed: games[0].date }, league: { type: 4, label: 'Diamond', tier: 1 }, percentile: 15, peakRating: 4400, leagueMax: null, totalGamesPlayed: 500, ratingHistory: [], pro: null, linkedCharacters: [], pulseProfileUrl: 'https://sc2pulse.nephest.com/sc2/?type=character&id=123456' } });
    if (suffix === '/identity-submissions') return json({ isAdmin: false, eligible: true, source: { key: `pulse:${id}`, pulseId: id, displayName: 'IIIIIIIIIIII', race: 'Z', region: 'NA' }, confirmed: null, submission: null, replayCount: 14 });
    if (suffix === '/identity-candidates') return json({ status: 'not_eligible' });
    if (suffix === '/diagnostics') return json({ pulseId: id, pulseCharacterId: id === 'barcode' ? null : '123456', toonHandle: '1-S2-1-123456', displayNameSample: 'Replay rival', region: 'NA', mmr: 4250, mmrFetchedAt: games[0].date, pulseResolveAttemptedAt: games[0].date, leagueId: 4, gameCount: 14, inReplayMmrCount: 14, pulseIdStatus: id === 'barcode' ? 'unresolved' : 'resolved', mmrStatus: 'present', findings: [{ code: 'fixture', severity: 'info', message: 'Synthetic diagnostic boundary.' }] });
    return json({});
  }
  if (pathname === '/api/site/stats') return json({ agentDownloads: 42, activeAgents: 0, activeUsers: 1, generatedAt: new Date().toISOString(), activityWindowSeconds: 60 });
  if (pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync('.tmp/dossier-analysis-fixture.js')); }
  if (pathname.startsWith('/app')) { const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light'; res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(`<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${extra}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`); }
  const base = pathname.startsWith('/fonts/') ? path.join(root, 'app/fonts') : path.join(root, 'public'), file = path.resolve(base, pathname.startsWith('/fonts/') ? pathname.slice(7) : pathname.slice(1));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', ({ '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
});

(async () => {
  await new Promise(resolve => server.listen(3238, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true }); let checks = 0;
  const contextFor = async width => { const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' }); await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort()); return context; };
  const openAnalysis = async page => { await page.getByRole('navigation', { name: 'Dossier sections' }).getByRole('link', { name: 'Timings', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Key timings', exact: true })).toBeVisible(); };
  try {
    for (const width of [320, 390, 768, 1440]) for (const theme of ['light', 'dark']) {
      const context = await contextFor(width), page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
      const before = analysisAttempts.get('normal') || 0;
      await page.goto(`${origin}/app/opponents/normal?theme=${theme}`); await expect(page.getByRole('heading', { level: 1, name: 'Replay rival' })).toBeVisible();
      expect(analysisAttempts.get('normal') || 0).toBe(before); checks++;
      await openAnalysis(page); await expect(page.getByText('Needs build orders: 4 of 9 games have one.')).toBeVisible(); expect(analysisAttempts.get('normal')).toBe(before + 1); checks++;
      const timings = page.getByRole('list', { name: 'Recorded key timings' }); await expect(timings.getByRole('button')).toHaveCount(1); await expect(timings.getByText('3:05 · n=2')).toBeVisible(); await expect(timings.getByText('↘ getting earlier')).toBeVisible(); checks++;
      await page.getByRole('group', { name: 'Timing perspective' }).getByRole('button', { name: 'Yours', exact: true }).click(); await expect(timings.getByText('10:50 · n=2')).toBeVisible(); await expect(timings.getByRole('img')).toHaveAttribute('aria-label', /beyond the axis shown at 10:00\+/); await expect(page.getByText('Needs build orders: 3 of 9 games have one.')).toBeVisible(); checks++;
      await page.getByRole('group', { name: 'Timing perspective' }).getByRole('button', { name: 'Theirs', exact: true }).click(); await page.getByRole('group', { name: 'Timing matchup' }).getByRole('button', { name: 'PvZ', exact: true }).click(); expect(analysisAttempts.get('normal')).toBe(before + 1); checks++;
      await page.evaluate(() => document.fonts.ready); await page.locator('#dossier-timings').evaluate(node => node.scrollIntoView({ block: 'start' })); await page.screenshot({ path: `../../docs/handoff/screenshots/dossier-analysis-${theme}-${width}.png` });
      await timings.getByRole('button').first().click(); await expect(page.getByRole('button', { name: /Remove timing filter/ })).toBeVisible();
      await page.getByRole('navigation', { name: 'Dossier sections' }).getByRole('link', { name: 'History', exact: true }).click(); await expect(page.getByRole('heading', { name: /Analyzed sample replays/ })).toBeVisible();
      const lastHistory = reads.filter(row => row.path === '/v1/opponents/normal/games').at(-1); expect(JSON.parse(new URLSearchParams(lastHistory.query).get('analysisGameIds'))).toEqual(samples.map(row => row.gameId)); checks++;
      const link = page.locator('#dossier-history').getByRole('link', { name: 'Open game analysis: timeline, mechanics, build orders, and Ghost Build', exact: true }).first(), href = await link.getAttribute('href'), query = new URL(href, origin).searchParams;
      expect(query.get('fromSample')).toBe('1'); expect(href).not.toContain('analysisGameIds'); expect(href.length).toBeLessThan(2048); checks++;
      await page.getByRole('button', { name: /Remove timing filter/ }).click(); await expect(page.getByRole('heading', { name: /All replays/ })).toBeVisible(); expect(analysisAttempts.get('normal')).toBe(before + 1); checks++;
      await openAnalysis(page); await expect(page.getByRole('heading', { name: 'Your game phases', exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Recorded compositions', exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Recorded transitions', exact: true })).toBeVisible(); checks++;
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]); checks++;
      const neighborReads = reads.filter(row => row.path.endsWith('/neighbors')).length; await page.goto(new URL(href, origin).href); await expect(page.getByRole('button', { name: 'Use selected scope', exact: true })).toBeVisible(); expect(reads.filter(row => row.path.endsWith('/neighbors')).length).toBe(neighborReads); await page.keyboard.press('Alt+ArrowRight'); expect(new URL(page.url()).pathname).not.toBe('/app/game/newer'); checks++;
      await page.getByRole('button', { name: 'Use selected scope', exact: true }).click(); await expect(page.getByRole('link', { name: 'Newer ›', exact: true })).toBeVisible(); expect(new URL(await page.getByRole('link', { name: 'Newer ›', exact: true }).getAttribute('href'), origin).searchParams.has('fromSample')).toBe(false); checks++;
      console.log(JSON.stringify({ width, theme, checks })); await context.close();
    }
    for (const id of ['analysis-busy', 'analysis-network']) {
      const context = await contextFor(390), page = await context.newPage(); await page.goto(`${origin}/app/opponents/${id}?theme=light`); await expect(page.getByRole('heading', { level: 1, name: 'Replay rival' })).toBeVisible();
      await page.getByRole('navigation', { name: 'Dossier sections' }).getByRole('link', { name: 'Timings', exact: true }).click();
      if (id === 'analysis-busy') { await expect(page.getByText('Analyzing… retrying', { exact: true })).toBeVisible(); await expect(page.getByText('Needs build orders: 4 of 9 games have one.')).toBeVisible({ timeout: 12000 }); expect(analysisAttempts.get(id)).toBe(3); }
      else { await expect(page.locator('#dossier-timings').getByRole('button', { name: 'Retry', exact: true })).toBeVisible(); recovered.add(id); await page.locator('#dossier-timings').getByRole('button', { name: 'Retry', exact: true }).click(); await expect(page.getByText('Needs build orders: 4 of 9 games have one.')).toBeVisible(); }
      checks++; await context.close();
    }
    expect(writes).toEqual([]); console.log(`${checks} real analysis browser checks passed; all writes and nonlocal traffic blocked`);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });

