/* Run from apps/web after its own build. Existing fixture compiles actual
 * AppChrome/AnalyzerProvider/ProfileView/SWR; only Next/Clerk/socket/API are local.
 * Required OPPONENT_MOBILE_OUTPUT_DIR must be an agent-owned absolute cache path. */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process'), { chromium, expect } = require('@playwright/test');
const root = process.cwd(), origin = 'http://127.0.0.1:3234', output = process.env.OPPONENT_MOBILE_OUTPUT_DIR;
if (!output || !path.isAbsolute(output)) throw new Error('Set OPPONENT_MOBILE_OUTPUT_DIR to an owned absolute cache directory');
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
if (!executablePath || !path.isAbsolute(executablePath) || !fs.statSync(executablePath).isFile()) throw new Error('Set PLAYWRIGHT_CHROMIUM_EXECUTABLE to the pinned full Chrome executable');
fs.mkdirSync(output, { recursive: true });
execFileSync(process.execPath, ['tests/manual/dossier-brief-fixture.cjs'], { stdio: 'inherit' });
const css = fs.readdirSync('.next/static/css', { recursive: true }).filter(name => name.endsWith('.css')).map(name => fs.readFileSync(path.join('.next/static/css', name), 'utf8')).join('\n');
const extra = fs.existsSync('.tmp/dossier-brief-fixture.css') ? fs.readFileSync('.tmp/dossier-brief-fixture.css', 'utf8') : '';
const fonts = `@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureSerif;src:url('/fonts/fraunces-latin-normal.woff2');font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay;--font-serif:FixtureSerif}`;
const SHORT_NAME = 'IIIIIIIIIIII', LONG_NAME = 'IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII';
const KOREAN_NAME = '무작위플레이어', LONG_ALIAS = 'UnbrokenSyntheticAliasWithoutSeparators'.repeat(3);
const games = Array.from({ length: 14 }, (_, i) => ({ id: `fixture-game-${i}`, date: new Date(Date.UTC(2026, 9, 20 - i, 12)).toISOString(), result: i % 2 ? 'Victory' : 'Defeat', map: 'Alcyone LE', my_build: 'Blink opener', opp_strategy: 'Roach pressure', my_race: 'P', opp_race: 'Z', game_length: 900, macro_score: 65, my_mmr: 4200, opp_mmr: 6280 }));
function nameFor(id) { return id === 'mobile-long' ? LONG_NAME : SHORT_NAME; }
function aliasesFor(id) { return [nameFor(id), KOREAN_NAME, id === 'mobile-long' ? LONG_ALIAS : 'lIlIIlIlIlII', 'LLLLLLLLLLLL']; }
function profile(id) {
  return { pulseId: id, name: nameFor(id), displayNameSample: nameFor(id), pulseCharacterId: '123456', toonHandle: '1-S2-1-123456', mmr: 6280, firstSeen: '2025-03-01T00:00:00Z', lastSeen: games[0].date,
    series: { firstSeen: '2024-01-01T00:00:00Z', lastSeen: games[0].date, sourceLimit: 1000, truncated: false, games }, totals: { wins: 7, losses: 7, total: 14, winRate: .5 },
    byMap: { 'Alcyone LE': { wins: 7, losses: 7 } }, byStrategy: { 'Roach pressure': { wins: 7, losses: 7 } }, predictedStrategies: [{ strategy: 'Roach pressure', probability: 1 }], myRace: 'P', oppRaceModal: 'Z', games, gamesTruncated: false, communityAvailable: true, notes: 'Synthetic mobile layout fixture.', notesReadAloud: false,
    mergedIdentities: aliasesFor(id).map((name, i) => ({ pulseId: `alias-${i}`, pulseCharacterId: String(123456 + i), toonHandle: `1-S2-1-${123456 + i}`, name, revealedName: null, wins: 2, losses: 1, games: 3, lastSeen: games[0].date })) };
}
function intel(id) {
  return { characterId: '123456', region: 'KR', current: { rating: 6280, wins: 1234, losses: 987, leagueType: 6, tier: 1, region: 'KR', season: 68, globalRank: 45, lastPlayed: games[0].date }, league: { type: 6, label: 'Grandmaster', tier: 1 }, percentile: .7, peakRating: 6500, leagueMax: { type: 6, label: 'Grandmaster' }, totalGamesPlayed: 123456,
    ratingHistory: Array.from({ length: 30 }, (_, i) => ({ t: new Date(Date.UTC(2026, 8, i + 1)).toISOString(), rating: 6100 + i * 6 + (i % 3) * 12 })),
    pro: { nickname: id === 'mobile-long' ? LONG_ALIAS : 'ReplayRival', name: KOREAN_NAME, country: 'KR', earnings: null, team: 'Synthetic Team', links: {} },
    linkedCharacters: aliasesFor(id).map((name, i) => ({ characterId: String(123456 + i), name, region: i % 2 ? 'KR' : 'NA', ratingMax: 6500 - i * 100, leagueMax: 6 })), pulseProfileUrl: 'https://sc2pulse.nephest.com/sc2/?type=character&id=123456' };
}
function identity(id) {
  return { status: 'ready', calibrated: false, methodologyVersion: 'synthetic_layout_v1', generatedAt: '2026-10-27T12:00:00.000Z', eligibility: { eligible: true, isBarcode: true, pulseResolved: true, mmrPresent: true, reasons: [] },
    target: { pulseId: id, name: nameFor(id), race: 'Zerg', raceCode: 'Z', games: 1234, buildGames: 234, controlGroupGames: 345, evidenceMode: 'build_and_control_groups', matchup: 'ZvP' },
    candidates: [{ rank: 1, pulseId: 'candidate-layout', pulseCharacterId: '777777', name: KOREAN_NAME, race: 'Zerg', region: 'KR', mmr: 6200, gamesInProfile: 4321, likelihood: .42, patternMatch: .91, confidence: 'high', evidenceQuality: .84,
      sample: { targetGames: 1234, candidateGames: 4321, targetEvidenceGames: 234, candidateEvidenceGames: 321 }, evidence: { coverage: 1, buildOrders: { score: .86, targetSamples: 234, candidateSamples: 321, sharedBuilds: ['Roach pressure'], sharedMilestones: [{ name: 'SpawningPool', deltaSec: 8 }], highlights: ['Synthetic opening comparison'] }, controlGroups: { score: .96, targetSamples: 345, candidateSamples: 456, matchedSlots: [1, 4], highlights: ['Synthetic group comparison'] } }, caveats: [] }],
    unknownLikelihood: .32, otherLikelihood: .26, scope: { source: 'your_replay_history', searchedOpponents: 23456, searchedGames: 123456, truncated: false } };
}
const phaseKeys = ['early', 'earlyMid', 'mid', 'midLate', 'late'];
const analysis = { analysisSampleSize: 9, analysisSampleLimit: 100, analysisSampleTruncated: false, analysisCohortSize: 14, buildOrdersAvailable: 4, yourBuildOrdersAvailable: 3, buildOrdersTotal: 9, analyzedGameIds: games.slice(0, 9).map(row => row.id), medianTimingsOrder: [], medianTimingsLegacy: {}, matchupTimingsLegacy: {},
  phases: { slug: 'layout', name: 'Synthetic phases', perspective: 'you', sampleSize: Object.fromEntries(phaseKeys.map(key => [key, 4])), perPhase: Object.fromEntries(phaseKeys.map(key => [key, { signatures: [{ key: 'stalkers', units: [{ token: 'Stalker', count: 8 }], sampleCount: 4, wins: 2, losses: 2, winRate: .5, sampleGameIds: [games[0].id] }], tech: [], upgrades: [] }])), finalPhaseDistribution: { early: 0, earlyMid: 1, mid: 2, midLate: 1, late: 0 }, medianCrossings: { earlyMidAt: 300, midAt: 480, midLateAt: 700, lateAt: null }, durationP95Sec: 900, flags: [] },
  transitions: { slug: 'layout', name: 'Synthetic transitions', transitions: { nodes: [], edges: [], rare: { collapsedNodes: 0, collapsedEdges: 0 } } } };
const writes = [], external = [], results = [];
function json(res, value, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }
const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin), pathname = url.pathname;
  if (pathname === '/v1/player-channels/resolve' && req.method === 'POST') return json(res, { players: [] });
  if (pathname === '/v1/games/vod-links' && req.method === 'POST' && req.headers.authorization === 'Bearer synthetic-local-token') return json(res, { linksByGameId: {} });
  if (pathname === '/v1/map-image') { const file = path.resolve(root, '../replay-engine/data/map-images/alcyone_le.webp'); if (fs.existsSync(file)) { res.writeHead(200, { 'Content-Type': 'image/webp' }); return res.end(fs.readFileSync(file)); } res.statusCode = 404; return res.end(); }
  if (pathname.startsWith('/v1/')) {
    if (req.method !== 'GET') { writes.push({ path: pathname, method: req.method }); return json(res, { error: { code: 'write_blocked' } }, 405); }
    if (pathname === '/v1/seasons') return json(res, { items: [], current: null, source: 'fallback', fetchedAt: null });
    if (pathname === '/v1/site/banner') return json(res, { banner: null });
    if (pathname === '/v1/ping') return json(res, { ok: true });
    if (req.headers.authorization !== 'Bearer synthetic-local-token') return json(res, { error: { code: 'auth_required' } }, 401);
    if (pathname === '/v1/me') return json(res, { userId: 'synthetic-local-fixture', isAdmin: false, agentLastSeenAt: null, games: { total: 14, latest: games[0].date } });
    if (pathname === '/v1/me/profile') return json(res, { displayName: 'Fixture player' });
    if (pathname === '/v1/coaching/me') return json(res, { role: 'none' });
    if (pathname === '/v1/coaching/alerts' || pathname.endsWith('/unread-count')) return json(res, { pending: 0, count: 0, items: [] });
    const match = /^\/v1\/opponents\/([^/]+)(.*)$/.exec(pathname); if (!match) return json(res, {});
    const id = decodeURIComponent(match[1]), suffix = match[2];
    if (!suffix) return json(res, profile(id));
    if (suffix === '/games') return json(res, { items: games, nextCursor: null });
    if (suffix === '/pulse-races') return json(res, { resolved: true, races: ['Z', 'P', 'T', 'R'].map((race, i) => ({ race, mmr: 6280 - i * 100, games: 1234 - i * 100, league: i < 2 ? 'Grandmaster' : 'Master', region: 'KR' })), topRace: 'Z', topMmr: 6280 });
    if (suffix === '/pulse-intel') return json(res, { intel: intel(id) });
    if (suffix === '/analysis') return json(res, analysis);
    if (suffix === '/identity-candidates') return json(res, identity(id));
    if (suffix === '/identity-submissions') return json(res, { isAdmin: false, eligible: true, source: { key: `pulse:${id}`, pulseId: id, displayName: nameFor(id), race: 'Z', region: 'KR' }, confirmed: null, submission: null, replayCount: 14 });
    if (suffix === '/diagnostics') return json(res, { pulseId: id, pulseCharacterId: '123456', toonHandle: '1-S2-1-123456', displayNameSample: nameFor(id), region: 'KR', mmr: 6280, mmrFetchedAt: games[0].date, pulseResolveAttemptedAt: games[0].date, leagueId: 6, gameCount: 14, inReplayMmrCount: 14, pulseIdStatus: 'resolved', mmrStatus: 'present', findings: [] });
    return json(res, {});
  }
  if (pathname === '/api/site/stats') return json(res, { agentDownloads: 42, activeAgents: 0, activeUsers: 1, generatedAt: '2026-10-27T12:00:00.000Z', activityWindowSeconds: 60 });
  if (pathname === '/fixture.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(fs.readFileSync('.tmp/dossier-brief-fixture.js')); }
  if (pathname.startsWith('/app')) { const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light'; res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(`<!doctype html><html lang="en" data-theme="${theme}" data-theme-mode="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${extra}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`); }
  const base = pathname.startsWith('/fonts/') ? path.join(root, 'app/fonts') : path.join(root, 'public'), file = path.resolve(base, pathname.startsWith('/fonts/') ? pathname.slice(7) : pathname.slice(1));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.writeHead(200, { 'Content-Type': ({ '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp' })[path.extname(file)] || 'application/octet-stream' }); res.end(fs.readFileSync(file));
});
async function geometry(page) {
  return page.evaluate(() => {
    const rect = node => node ? { left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, width: node.getBoundingClientRect().width, client: node.clientWidth, scroll: node.scrollWidth, text: node.textContent.slice(0, 100) } : null;
    const clip = node => { for (let parent = node.parentElement; parent; parent = parent.parentElement) if (['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(parent).overflowX)) return { tag: parent.tagName, class: parent.getAttribute('class'), width: parent.clientWidth, overflowX: getComputedStyle(parent).overflowX }; return null; };
    const ladder = document.querySelector('#dossier-ladder'), scope = document.querySelector('[aria-label="Identity comparison scope"]');
    return { viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth, heading: rect(document.querySelector('h1')), sections: Array.from(document.querySelectorAll('section[id^="dossier-"]')).map(node => ({ id: node.id, ...rect(node) })),
      aliases: rect(Array.from(ladder?.querySelectorAll('p') || []).find(node => node.textContent.includes('Also plays as'))), raceScroll: rect(ladder?.querySelector('table')?.parentElement), scopeStats: rect(scope?.querySelector('dl')),
      culprits: Array.from(document.querySelectorAll('body *')).filter(node => { const box = node.getBoundingClientRect(); return box.width > 0 && (box.right > innerWidth + 1 || box.left < -1); }).slice(0, 50).map(node => ({ tag: node.tagName, class: node.getAttribute('class'), ...rect(node), clip: clip(node) })) };
  });
}
(async () => {
  let browser;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(3234, '127.0.0.1', resolve); }); browser = await chromium.launch({ headless: true, executablePath });
    for (const width of [320, 390, 640, 768, 1280]) for (const theme of ['light', 'dark']) for (const mode of ['normal', 'long']) {
      const id = `mobile-${mode}`, key = `${mode}-${theme}-${width}`, context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' }), errors = [];
      await context.addInitScript(value => { localStorage.setItem('sc2tools.theme', value); }, theme);
      const page = await context.newPage();
      const record = { width, theme, mode, sourceBoundary: 'actual AppChrome/AnalyzerProvider/ProfileView/SWR; synthetic Next/auth/API, own-built CSS/fonts', errors, appearance: null, geometry: null, status: 'pending' };
      page.on('pageerror', error => errors.push(error.message)); await context.route('**/*', route => { if (new URL(route.request().url()).origin === origin) return route.continue(); external.push(route.request().url()); return route.abort(); });
      try {
        await page.goto(`${origin}/app/opponents/${id}?theme=${theme}`); await expect(page.getByRole('heading', { level: 1, name: nameFor(id), exact: true })).toBeVisible(); await page.evaluate(() => document.fonts.ready);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme); await expect(page.locator('html')).toHaveAttribute('data-theme-mode', theme);
        record.appearance = await page.evaluate(() => { const html = document.documentElement, rootStyle = getComputedStyle(html), bodyStyle = getComputedStyle(document.body); return { theme: html.dataset.theme, mode: html.getAttribute('data-theme-mode'), stored: localStorage.getItem('sc2tools.theme'), rootBg: rootStyle.getPropertyValue('--bg').trim(), rootText: rootStyle.getPropertyValue('--text').trim(), rootColorScheme: rootStyle.colorScheme, bodyBackground: bodyStyle.backgroundColor, bodyColor: bodyStyle.color, bodyFont: bodyStyle.fontFamily, headingFont: getComputedStyle(document.querySelector('h1')).fontFamily, fontFaces: Array.from(document.fonts).map(font => ({ family: font.family, status: font.status })) }; });
        expect(record.appearance.stored).toBe(theme);
        expect(record.appearance.rootBg.replace(/\s+/g, ' ')).toBe(theme === 'light' ? '244 246 250' : '6 9 14');
        expect(record.appearance.bodyBackground).toBe(theme === 'light' ? 'rgb(244, 246, 250)' : 'rgb(6, 9, 14)');
        expect(record.appearance.bodyFont).toContain('FixtureSans');
        expect(record.appearance.fontFaces.some(font => font.family.includes('FixtureSans') && font.status === 'loaded'), 'actual body font face must load').toBe(true);
        await page.screenshot({ path: path.join(output, `${key}-header.png`) }); const nav = page.getByRole('navigation', { name: 'Dossier sections' });
        await nav.getByRole('link', { name: 'Timings', exact: true }).click(); await expect(page.getByRole('tablist', { name: 'Phase compositions' })).toBeVisible();
        await nav.getByRole('link', { name: 'Ladder', exact: true }).click(); await expect(page.getByRole('heading', { name: 'MMR by race', exact: true })).toBeVisible();
        const sparkline = page.locator('#dossier-ladder figure svg.recharts-surface');
        await expect(sparkline).toHaveCount(1); await expect(sparkline).toBeVisible();
        const chartBox = await sparkline.boundingBox();
        expect(chartBox, 'actual ladder sparkline must have a rendered box').not.toBeNull();
        expect(chartBox.width, 'ladder sparkline must retain positive width').toBeGreaterThan(0);
        expect(chartBox.height, 'ladder sparkline must retain positive height').toBeGreaterThan(0);
        await page.screenshot({ path: path.join(output, `${key}-ladder.png`) });
        await nav.getByRole('link', { name: 'Identity', exact: true }).click(); const details = page.locator('#dossier-identity details').first(); if (await details.getAttribute('open') === null) await details.locator('summary').first().click();
        await expect(page.getByLabel('Identity comparison scope', { exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Compare evidence', exact: true }).click(); await page.screenshot({ path: path.join(output, `${key}-identity.png`) });
        record.geometry = await geometry(page); fs.writeFileSync(path.join(output, `${key}-geometry.json`), JSON.stringify(record, null, 2)); console.log(JSON.stringify({ key, appearance: record.appearance, document: record.geometry.document, viewport: width, scopeStats: record.geometry.scopeStats, culprits: record.geometry.culprits.slice(0, 8), raw: `${key}-geometry.json` }));
        expect(record.geometry.sections.map(section => section.id)).toEqual(['dossier-brief', 'dossier-tendencies', 'dossier-timings', 'dossier-history', 'dossier-ladder', 'dossier-identity']);
        expect(record.geometry.scopeStats, 'the actual identity comparison stats grid must be mounted').not.toBeNull();
        expect(record.geometry.aliases, 'rich ladder aliases must be mounted').not.toBeNull();
        expect(record.geometry.raceScroll, 'the actual race table scroll viewport must be mounted').not.toBeNull();
        expect(record.geometry.document, 'document must fit viewport; local table scrolling remains allowed').toBeLessThanOrEqual(width + 1);
        for (const section of record.geometry.sections) { expect(section.left).toBeGreaterThanOrEqual(-1); expect(section.right, section.id).toBeLessThanOrEqual(width + 1); }
        expect(record.geometry.scopeStats.scroll, 'identity stats must fit their own grid, not clip inside Card').toBeLessThanOrEqual(record.geometry.scopeStats.client + 1);
        expect(record.geometry.aliases.scroll, 'aliases must wrap instead of clipping inside Card').toBeLessThanOrEqual(record.geometry.aliases.client + 1);
        expect(record.geometry.raceScroll.right, 'race table scroll viewport must remain bounded').toBeLessThanOrEqual(width + 1);
        expect(errors).toEqual([]); record.status = 'passed';
      } catch (error) { record.status = 'failed'; record.failure = String(error.stack || error); if (!record.geometry) record.geometry = await geometry(page).catch(() => null); await page.screenshot({ path: path.join(output, `${key}-failure.png`) }).catch(() => {}); }
      finally { results.push(record); fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ results, writes, external }, null, 2)); await context.close(); }
    }
    expect(writes).toEqual([]); expect(external).toEqual([]); expect(results.filter(result => result.status !== 'passed').map(result => ({ width: result.width, theme: result.theme, mode: result.mode, failure: result.failure.split('\n')[0] })), 'all failed geometry records/screenshots are retained').toEqual([]);
  } finally { if (browser) await browser.close(); if (server.listening) { server.closeIdleConnections?.(); await new Promise(resolve => server.close(resolve)); } }
})().catch(error => { console.error(error); process.exitCode = 1; });
