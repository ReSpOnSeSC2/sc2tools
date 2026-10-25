/* Run only after a SAME-BRANCH production build, from any directory:
 * node apps/web/tests/manual/opponent-columns.cjs
 * Real components, persistence, grouping, sorting, fetch and replay button.
 * No real account/provider calls. The HTTPS replay anchor alone is intercepted.
 * Captures, storage states, logs and summary stay under .cache/opponent-columns.
 * Root should inspect the final capture matrix before claiming visual approval. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
process.chdir(path.resolve(__dirname, '../..'));
const { chromium, expect } = require('@playwright/test');
const buildFixture = require('./opponent-columns-fixture.cjs');

const root = process.cwd(), origin = 'http://127.0.0.1:3269';
const output = path.resolve(root, '../../.cache/opponent-columns');
const columnStorageKey = 'analyzer.opponents.columns';
const reads = [], unexpected = [], blocked = [], errors = [], cases = [];
let javascript = '', holdList = false, heldResponses = [], checks = 0, currentCase = 'initialization';
const layoutStages = [];
let lastPickerBounds = null;
const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.mkdirSync(output, { recursive: true });
const cssFiles = fs.readdirSync('.next/static/css', { recursive: true }).filter(name => name.endsWith('.css'));
if (!cssFiles.length) throw new Error('Build this branch first; production CSS is required.');
const css = cssFiles.map(name => fs.readFileSync(path.join('.next/static/css', name), 'utf8')).join('\n');
const fonts = "@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay;--font-serif:serif}";
const when = day => `2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`;
const game = (gameId, day, extra = {}) => ({ gameId, date: when(day), map: 'Circuit Breaker LE', result: 'Win', durationSec: 300, myBuild: 'Protoss — 2 Stargate Void Ray', oppStrategy: 'Zerg — Pool pressure', macroScore: 50, top3Leaks: ['Supply blocks', 'Idle production'], replayAvailable: false, replaySizeBytes: null, ...extra });
const row = (pulseId, name, day, extra = {}) => ({ pulseId, pulseCharacterId: pulseId, toonHandle: `1-S2-1-${pulseId}`, name, race: 'P', region: 'NA', wins: 3, losses: 2, games: 5, winRate: .6, mmr: 4600, lastPlayed: when(day), ...extra });
const rows = [
  row('101', 'Atlas', 25, { games: 1, wins: 1, losses: 0, winRate: 1, notesMeta: { preview: 'Scout the third base.' }, latestGame: game('atlas-latest', 25, { macroScore: 0, replayAvailable: true, replaySizeBytes: 4096, buildPlanned: true, map: 'Circuit Breaker LE · a deliberately long map label that must wrap on phones' }), duration: { sumSec: 900, samples: 1, averageSec: 900 }, macro: { sum: 100, samples: 1, average: 100 }, latestOppBuildOrder: { gameId: 'atlas-order-old', date: when(22) }, opponentBuildOrderAvailability: 'known' }),
  row('102', 'AtlasEU', 24, { region: 'EU', toonHandle: '2-S2-1-102', games: 4, wins: 3, losses: 1, winRate: .75, latestGame: game('atlas-alias', 24, { durationSec: 150, macroScore: 10 }), duration: { sumSec: 600, samples: 4, averageSec: 150 }, macro: { sum: 40, samples: 4, average: 10 }, latestOppBuildOrder: { gameId: 'atlas-order-new', date: when(23) }, opponentBuildOrderAvailability: 'known' }),
  row('103', 'Boreal', 23, { race: 'T', latestGame: game('boreal-latest', 23, { durationSec: 720, macroScore: 80, result: 'Loss', oppStrategy: 'Terran — Bio' }), duration: { sumSec: 720, samples: 1, averageSec: 720 }, macro: { sum: 80, samples: 1, average: 80 }, latestOppBuildOrder: null, opponentBuildOrderAvailability: 'known' }),
  row('104', 'Cipher', 22, { race: 'Z', latestGame: game('cipher-latest', 22, { durationSec: null, macroScore: null, myBuild: '=HYPERLINK("synthetic")', oppStrategy: 'Classifier label does not establish a recorded order' }), duration: { sumSec: 0, samples: 0, averageSec: null }, macro: { sum: 0, samples: 0, average: null }, opponentBuildOrderAvailability: 'unknown' }),
  row('105', 'Delta', 21, { latestGame: game('delta-latest', 21, { durationSec: 0, macroScore: 0 }), duration: { sumSec: 0, samples: 1, averageSec: 0 }, macro: { sum: 0, samples: 1, average: 0 }, latestOppBuildOrder: { gameId: 'delta-recorded', date: when(20) }, opponentBuildOrderAvailability: 'unknown' }),
  row('106', 'Echo with an unusually long player name for the phone layout', 20, { latestGame: null, duration: { sumSec: 0, samples: 0, averageSec: null }, macro: { sum: 0, samples: 0, average: null }, latestOppBuildOrder: null, opponentBuildOrderAvailability: 'unknown' }),
];
const detailKeys = ['latestGame', 'duration', 'macro', 'latestOppBuildOrder', 'opponentBuildOrderAvailability'];
const json = (res, value, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(value)); };
const readBody = req => new Promise(resolve => { let value = ''; req.on('data', part => { value += part; }); req.on('end', () => resolve(value ? JSON.parse(value) : {})); });
const sendList = (res, details) => json(res, { items: rows.map(item => Object.fromEntries(Object.entries(item).filter(([key]) => details || !detailKeys.includes(key)))), nextBefore: null });
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    if (url.pathname === '/fixture/control') {
      if (url.searchParams.has('hold')) holdList = url.searchParams.get('hold') === '1';
      if (url.searchParams.has('release')) { holdList = false; const pending = heldResponses; heldResponses = []; for (const send of pending) send(); }
      return json(res, { held: heldResponses.length });
    }
    if (url.pathname.startsWith('/v1/')) {
      reads.push({ path: url.pathname, query: url.search, method: req.method, owner: req.headers.authorization || null, held: holdList && url.pathname === '/v1/opponents' });
      const readPost = req.method === 'POST' && ['/v1/player-channels/resolve', '/v1/rivals/summary'].includes(url.pathname);
      if (req.method !== 'GET' && !readPost) { unexpected.push({ method: req.method, path: url.pathname }); return json(res, { error: { code: 'fixture_mutation_forbidden' } }, 405); }
      if (url.pathname !== '/v1/player-channels/resolve' && req.headers.authorization !== 'Bearer columns-owner') return json(res, { error: { code: 'fixture_owner_required' } }, 401);
      if (url.pathname === '/v1/opponents') {
        const send = () => { if (!res.destroyed) sendList(res, url.searchParams.get('listDetails') === '1'); };
        if (holdList) heldResponses.push(send); else send();
        return;
      }
      if (url.pathname === '/v1/opponents/pulse-links') return json(res, { links: { 101: { accountId: '900', proId: null, proNickname: null }, 102: { accountId: '900', proId: null, proNickname: null } }, partial: false });
      if (url.pathname === '/v1/me/preferences/rivals') return json(res, { keys: [] });
      if (url.pathname === '/v1/mmr-by-matchup/opponents') return json(res, { items: [], totalOpponents: 0, offset: 0, limit: 200, summary: { netMmr: 0, mmrWon: 0, mmrLost: 0, pairs: 0, opponents: 0, mostMmrGainedFrom: null, mostMmrLostTo: null } });
      if (url.pathname === '/v1/player-channels/resolve') { const input = await readBody(req); return json(res, { players: input.players.map(player => ({ ...player, channels: {} })) }); }
      if (url.pathname === '/v1/rivals/summary') { await readBody(req); return json(res, { generatedAt: when(25), hasAnyGames: true, recentComplete: true, weekGames: {}, rivals: [] }); }
      if (url.pathname === '/v1/games/atlas-latest/replay-download') return json(res, { url: 'https://replays.fixture.invalid/atlas-latest.SC2Replay?synthetic=1', filename: 'Atlas latest.SC2Replay', expiresIn: 60 });
      unexpected.push({ method: req.method, path: url.pathname });
      return json(res, { error: { code: 'unexpected_fixture_request' } }, 404);
    }
    if (url.pathname === '/fixture.js') { res.setHeader('content-type', 'text/javascript;charset=utf-8'); return res.end(javascript); }
    if (/^\/(fonts|icons)\//.test(url.pathname)) {
      const file = path.resolve(root, 'public', '.' + decodeURIComponent(url.pathname));
      if (file.startsWith(path.resolve(root, 'public') + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.setHeader('content-type', file.endsWith('.woff2') ? 'font/woff2' : file.endsWith('.svg') ? 'image/svg+xml' : 'image/webp'); return res.end(fs.readFileSync(file));
      }
      res.statusCode = 404; return res.end();
    }
    if (url.pathname === '/favicon.ico') { res.statusCode = 204; return res.end(); }
    res.setHeader('content-type', 'text/html;charset=utf-8');
    res.end(`<!doctype html><html lang="en" data-theme="${url.searchParams.get('theme') === 'dark' ? 'dark' : 'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opponent columns local proof</title><style>${css}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  } catch (error) { unexpected.push({ error: error.message }); if (!res.headersSent) json(res, { error: { code: 'fixture_error' } }, 500); else res.end(); }
});

const labels = ['Pulse ID', 'Last MMR', 'Net MMR', 'MMR won', 'MMR lost', 'Region', 'Download latest replay', 'Last result', 'Last game length', 'Last map', 'My build', 'Opponent build', 'Opponent build order', 'Last recorded build order date', 'My latest macro breakdown', 'My latest macro leaks', 'Average game length', 'My average macro score', 'Scouting notes'];
const selected = labels.filter(label => !['Last MMR', 'Net MMR', 'MMR won', 'MMR lost'].includes(label));
const exact = value => new RegExp('^' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
const rowFor = (page, width, name) => {
  const identity = rows.find(item => item.name === name);
  if (!identity) throw new Error(`Unknown synthetic opponent ${name}`);
  const history = page.getByRole(width < 768 ? 'list' : 'table', { name: 'Opponent history' });
  return history.getByRole(width < 768 ? 'listitem' : 'row').filter({ has: page.locator(`a[href="/app/opponents/${identity.pulseId}"],a[href^="/app/opponents/${identity.pulseId}?"]`) });
};
const picker = page => page.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^Columns$/ }) });
async function openPicker(page) { const node = picker(page); if (!await node.evaluate(element => element.open)) await node.locator('summary').click(); return node; }
async function closePicker(page) { const node = picker(page); if (await node.evaluate(element => element.open)) await node.locator('summary').press('Escape'); }
async function assertPickerBounds(menu, reservedBottom = 0) {
  const measure = () => menu.locator('fieldset').evaluate(node => {
    const rect = node.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight, internalOverflow: node.scrollWidth > node.clientWidth };
  });
  await expect.poll(async () => {
    lastPickerBounds = await measure();
    return { topInside: lastPickerBounds.top >= 4, bottomInside: lastPickerBounds.bottom <= lastPickerBounds.viewportHeight - reservedBottom - 4 };
  }, { message: 'Whole column picker fits vertically after measuring/flipping/repositioning' }).toEqual({ topInside: true, bottomInside: true });
  const bounds = await measure();
  expect(bounds.left, 'Picker remains inside the left viewport edge').toBeGreaterThanOrEqual(0);
  expect(bounds.right, 'Picker remains inside the right viewport edge').toBeLessThanOrEqual(bounds.viewportWidth);
  expect(bounds.width).toBeLessThanOrEqual(bounds.viewportWidth - 32 + 1);
  expect(bounds.height).toBeLessThanOrEqual(bounds.viewportHeight * .7 + 1);
  expect(bounds.internalOverflow, 'Picker labels do not create horizontal overflow').toBe(false);
  checks++;
  return { ...bounds, reservedBottom };
}
async function assertResetReachable(menu) {
  const fieldset = menu.locator('fieldset');
  await fieldset.evaluate(node => { node.scrollTop = node.scrollHeight; });
  const reset = menu.getByRole('button', { name: 'Reset columns', exact: true });
  await expect(reset).toBeVisible(); await expect(reset).toBeInViewport({ ratio: 1 });
  const inside = await reset.evaluate(node => {
    const button = node.getBoundingClientRect(), popup = node.closest('fieldset').getBoundingClientRect();
    return button.top >= popup.top && button.bottom <= popup.bottom && button.left >= popup.left && button.right <= popup.right;
  });
  expect(inside, 'Reset remains reachable within the visible popup after internal scrolling').toBe(true); checks++;
}
async function assertPickerAnchored(menu) {
  await expect.poll(() => menu.evaluate(node => {
    const anchor = node.querySelector('summary').getBoundingClientRect(), popup = node.querySelector('fieldset').getBoundingClientRect();
    return Math.min(Math.abs(popup.top - anchor.bottom), Math.abs(anchor.top - popup.bottom));
  }), { message: 'Popup follows its summary when the outer document scrolls' }).toBeLessThanOrEqual(12);
  checks++;
}
async function cell(page, width, name, label) {
  const row = rowFor(page, width, name);
  if (width < 768) return row.locator('dt').filter({ hasText: exact(label) }).locator('+ dd');
  const index = await page.getByRole('table', { name: 'Opponent history' }).locator('thead th').evaluateAll((nodes, wanted) => nodes.findIndex(node => node.textContent.replace(/[↑↓]/g, '').replace(/\s+/g, ' ').trim() === wanted), label);
  expect(index, `Column ${label} exists`).toBeGreaterThanOrEqual(0);
  return row.locator('td').nth(index);
}
async function order(page, width) {
  const holder = page.getByRole(width < 768 ? 'list' : 'table', { name: 'Opponent history' });
  const pulseIds = await holder.locator(width < 768 ? ':scope > li' : 'tbody > tr').evaluateAll(nodes => nodes.map(node => node.querySelector('a[href^="/app/opponents/"]')?.getAttribute('href').split('?')[0].split('/').pop()).filter(Boolean));
  return pulseIds.map(id => rows.find(item => item.pulseId === id)?.name || id);
}
async function selectSort(page, width, key, label) {
  if (width < 768) await page.getByRole('combobox', { name: 'Sort opponents' }).selectOption(key);
  else await page.getByRole('columnheader', { name: new RegExp('^' + label) }).getByRole('button').click();
  await expect.poll(() => new URL(page.url()).searchParams.get('sort')).toBe(key);
}
async function settled(page) {
  await expect(page.getByRole('button', { name: 'Export CSV', exact: true })).toBeEnabled();
  await page.waitForFunction(() => typeof window.fixtureRefresh === 'function');
  await page.waitForTimeout(400);
}
async function recordLayout(page, stage) {
  layoutStages.push({ case: currentCase, stage, ...await page.evaluate(() => ({ width: innerWidth, htmlWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, scrollX, scrollY })) });
}

(async () => {
  javascript = await buildFixture(root, origin);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(3269, '127.0.0.1', resolve); });
  const browser = await chromium.launch({ headless: true });
  const fresh = async (width, theme, storageState) => {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce', acceptDownloads: true, ...(storageState ? { storageState } : {}) });
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      blocked.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push({ width, theme, message: error.message }));
    return { context, page };
  };
  try {
    for (const width of [320, 390, 768, 1440]) for (const theme of ['light', 'dark']) {
      currentCase = `${width}-${theme}`;
      if (process.env.OPPONENT_COLUMNS_CASE && process.env.OPPONENT_COLUMNS_CASE !== currentCase) continue;
      let { context, page } = await fresh(width, theme);
      const start = reads.length;
      await page.goto(`${origin}/app/opponents?theme=${theme}`); await settled(page);
      await expect(rowFor(page, width, 'Atlas')).toHaveCount(1); checks++;
      expect(reads.slice(start).filter(read => read.path === '/v1/opponents').every(read => !new URLSearchParams(read.query).has('listDetails'))).toBe(true); checks++;
      let menu = await openPicker(page);
      await expect(menu.getByRole('checkbox')).toHaveCount(19); await expect(menu.getByText('Saved automatically in this browser.')).toBeVisible(); checks++;
      const initialPickerBounds = await assertPickerBounds(menu);
      await page.setViewportSize({ width, height: 700 });
      const shorterPickerBounds = await assertPickerBounds(menu); await assertResetReachable(menu);
      const previousChromeBottom = await page.evaluate(() => {
        const root = document.documentElement, previous = root.style.getPropertyValue('--chrome-bottom');
        root.style.setProperty('--chrome-bottom', '64px'); dispatchEvent(new Event('resize')); return previous;
      });
      const chromeReservedPickerBounds = await assertPickerBounds(menu, 64); await assertResetReachable(menu);
      await page.evaluate(previous => {
        if (previous) document.documentElement.style.setProperty('--chrome-bottom', previous);
        else document.documentElement.style.removeProperty('--chrome-bottom');
        dispatchEvent(new Event('resize'));
      }, previousChromeBottom);
      await page.setViewportSize({ width, height: 1000 });
      await assertPickerBounds(menu); await menu.locator('fieldset').evaluate(node => { node.scrollTop = 0; });
      await menu.getByRole('checkbox', { name: 'Region', exact: true }).check();
      await menu.getByRole('checkbox', { name: 'Scouting notes', exact: true }).check();
      expect(reads.slice(start).filter(read => read.path === '/v1/opponents').every(read => !new URLSearchParams(read.query).has('listDetails'))).toBe(true); checks++;
      const fieldset = menu.locator('fieldset');
      expect(await fieldset.evaluate(node => node.scrollHeight > node.clientHeight && node.clientHeight <= innerHeight * .7 + 1)).toBe(true); checks++;
      await fieldset.hover();
      const windowBeforeWheel = await page.evaluate(() => scrollY);
      await page.mouse.wheel(0, 160);
      await expect.poll(() => fieldset.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
      expect(Math.abs(await page.evaluate(() => scrollY) - windowBeforeWheel)).toBeLessThanOrEqual(1); checks++;
      for (const label of selected.filter(label => label !== 'Download latest replay')) await menu.getByRole('checkbox', { name: label, exact: true }).check();
      await closePicker(page); await settled(page);
      expect(reads.slice(start).some(read => read.path === '/v1/opponents' && new URLSearchParams(read.query).get('listDetails') === '1')).toBe(true); checks++;
      await expect(await cell(page, width, 'Atlas', 'Average game length')).toHaveText(/5:00\s*5 measured/);
      await expect(await cell(page, width, 'Atlas', 'My average macro score')).toHaveText(/28\/100\s*5 measured/);
      await expect(await cell(page, width, 'Atlas', 'My latest macro breakdown')).toHaveText('0/100 · Details'); checks += 3;
      await page.getByRole('button', { name: 'Show the 2 names this player uses', exact: true }).click();
      await expect(await cell(page, width, 'AtlasEU', 'Average game length')).toHaveText(/2:30\s*4 measured/);
      await page.getByRole('button', { name: 'Hide the 2 names this player uses', exact: true }).click(); checks++;
      await page.getByRole('switch', { name: 'Group same player', exact: true }).click();
      await expect(await cell(page, width, 'Atlas', 'Average game length')).toHaveText(/15:00\s*1 measured/);
      await page.getByRole('switch', { name: 'Group same player', exact: true }).click();
      await expect(await cell(page, width, 'Atlas', 'Average game length')).toHaveText(/5:00\s*5 measured/); checks++;
      await expect((await cell(page, width, 'Atlas', 'Last recorded build order date')).locator('time')).toHaveAttribute('datetime', when(23));
      await expect((await cell(page, width, 'Atlas', 'Opponent build order')).getByRole('link')).toHaveAttribute('href', /\/app\/game\/atlas-order-new\?.*#builds$/);
      await expect((await cell(page, width, 'Atlas', 'My latest macro breakdown')).getByRole('link')).toHaveAttribute('href', /\/app\/game\/atlas-latest\?.*#macro$/); checks += 3;
      const atlasOrderHref = await (await cell(page, width, 'Atlas', 'Opponent build order')).getByRole('link').getAttribute('href');
      expect(new URL(atlasOrderHref, origin).searchParams.get('opponent'), 'Order belongs to the alias carrying that recorded game').toBe('102');
      expect(new URL(atlasOrderHref, origin).searchParams.get('opponentName')).toBe('AtlasEU'); checks++;
      await expect(await cell(page, width, 'Boreal', 'Opponent build order')).toHaveText('No recorded order');
      await expect(await cell(page, width, 'Cipher', 'Last recorded build order date')).toHaveText('Not indexed');
      await expect((await cell(page, width, 'Cipher', 'Opponent build order')).getByRole('link')).toHaveText('Inspect latest game');
      await expect(await cell(page, width, 'Delta', 'Last recorded build order date')).toContainText('Latest known');
      await expect((await cell(page, width, 'Delta', 'Opponent build order')).getByRole('link', { name: 'Inspect the last known opponent build order for Delta', exact: true })).toHaveText('Inspect recorded game');
      await expect(await cell(page, width, 'Delta', 'Last game length')).toHaveText('0:00'); checks += 5;

      // Mount the actual replay buttons after the summary request has settled:
      // this isolated visual choice must not sign a URL or obtain another JWT.
      await settled(page);
      const tokenBefore = await page.evaluate(() => window.fixtureTokenCalls), replayBefore = reads.filter(read => read.path.endsWith('/replay-download')).length;
      expect(reads.slice(start).filter(read => read.path.endsWith('/replay-download'))).toHaveLength(0);
      menu = await openPicker(page); await menu.getByRole('checkbox', { name: 'Download latest replay', exact: true }).check();
      await closePicker(page); await page.waitForTimeout(450);
      expect(await page.evaluate(() => window.fixtureTokenCalls)).toBe(tokenBefore);
      expect(reads.filter(read => read.path.endsWith('/replay-download')).length).toBe(replayBefore); checks += 2;
      const replay = (await cell(page, width, 'Atlas', 'Download latest replay')).getByRole('button');
      // Grouping deliberately displays the most-played name, AtlasEU, while
      // its newest game's carrier and dossier target remain identity101.
      await expect(replay).toHaveAccessibleName('Download replay — latest game vs AtlasEU');
      const routeBefore = page.url(); await replay.click();
      await expect.poll(() => page.evaluate(() => window.fixtureDeliveries.length)).toBe(1);
      expect(page.url()).toBe(routeBefore);
      expect(reads.filter(read => read.path.endsWith('/replay-download')).length).toBe(replayBefore + 1);
      expect(await page.evaluate(() => window.fixtureTokenCalls)).toBe(tokenBefore + 1);
      expect(await page.evaluate(() => window.fixtureDeliveries[0])).toMatchObject({ filename: 'Atlas latest.SC2Replay', referrerPolicy: 'no-referrer', rel: 'noopener noreferrer' }); checks += 5;

      // Actual client CSV includes scalar detail columns without signed URLs.
      const exportEvent = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
      const download = await exportEvent, csv = fs.readFileSync(await download.path(), 'utf8');
      expect(csv).toContain('Games with measured length'); expect(csv).toContain('My average macro score');
      expect(csv).toContain("'=HYPERLINK"); expect(csv).not.toContain('replays.fixture.invalid'); checks += 4;

      // Persist immediately, leave/unmount, return, then restore in a genuinely
      // new browser context from disk. No sessionStorage is copied.
      const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), columnStorageKey);
      expect(saved.latestReplay).toBe(true); expect(saved.avgGameLength).toBe(true); checks++;
      await page.getByRole('link', { name: 'Leave list', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Synthetic destination' })).toBeVisible();
      await page.getByRole('link', { name: 'Return to opponents', exact: true }).click(); await settled(page);
      menu = await openPicker(page); for (const label of selected) await expect(menu.getByRole('checkbox', { name: label, exact: true })).toBeChecked(); await closePicker(page); checks++;
      const statePath = path.join(output, `storage-${width}-${theme}.json`); await context.storageState({ path: statePath }); await context.close();
      ({ context, page } = await fresh(width, theme, statePath));
      await page.goto(`${origin}/app/opponents?theme=${theme}`); await settled(page);
      menu = await openPicker(page); for (const label of selected) await expect(menu.getByRole('checkbox', { name: label, exact: true })).toBeChecked(); await closePicker(page); checks++;
      await expect(await cell(page, width, 'Atlas', 'Average game length')).toHaveText(/5:00\s*5 measured/); checks++;

      // Numeric sort: known zero remains measured and all unknowns stay last.
      await selectSort(page, width, 'avgGameLength', 'Average game length');
      expect((await order(page, width)).slice(0, 3)).toEqual(['Boreal', 'Atlas', 'Delta']); checks++;
      if (width < 768) await page.getByRole('button', { name: 'Reverse sort direction' }).click();
      else await page.getByRole('columnheader', { name: /^Average game length/ }).getByRole('button').click();
      await expect.poll(async () => (await order(page, width)).slice(0, 3)).toEqual(['Delta', 'Atlas', 'Boreal']); checks++;
      // Push one explicit URL state, then Back must restore the previous order.
      await page.evaluate(() => { history.pushState({}, '', '/app/opponents?sort=myBuild&dir=asc&q=Cipher'); dispatchEvent(new Event('fixture-navigation')); });
      await expect(page.getByRole('textbox', { name: 'Search opponents' })).toHaveValue('Cipher');
      await expect(rowFor(page, width, 'Cipher')).toBeVisible(); await page.goBack();
      await expect(page.getByRole('textbox', { name: 'Search opponents' })).toHaveValue('');
      await expect.poll(async () => (await order(page, width)).slice(0, 3)).toEqual(['Delta', 'Atlas', 'Boreal']); checks += 2;

      // Delayed same-scope hydration must not scroll/focus the outer document.
      await page.request.get(origin + '/fixture/control?hold=1');
      const heldBefore = reads.filter(read => read.held).length;
      await page.evaluate(() => { document.getElementById('reader').focus({ preventScroll: true }); scrollTo(0, 0); window.fixtureRefresh(); });
      await expect.poll(() => reads.filter(read => read.held).length).toBeGreaterThan(heldBefore);
      await page.request.get(origin + '/fixture/control?release=1'); await settled(page);
      expect(await page.evaluate(() => scrollY)).toBe(0); expect(await page.evaluate(() => document.activeElement.id)).toBe('reader'); checks += 2;

      await page.evaluate(() => document.fonts.ready);
      await recordLayout(page, 'before-capture');
      await page.screenshot({ path: path.join(output, `opponent-columns-${theme}-${width}.png`), fullPage: true });
      await recordLayout(page, 'after-capture');
      if (width >= 768) {
        const scroller = page.getByRole('table', { name: 'Opponent history' }).locator('..');
        expect(await scroller.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
        await scroller.evaluate(node => { node.scrollLeft = node.scrollWidth; });
        await recordLayout(page, 'after-table-scroll');
        expect(await page.evaluate(() => scrollY)).toBe(0);
        await page.screenshot({ path: path.join(output, `opponent-columns-right-${theme}-${width}.png`), fullPage: true }); checks += 2;
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); checks++;
      menu = await openPicker(page); await menu.locator('fieldset').evaluate(node => { node.scrollTop = node.scrollHeight; });
      const restoredPickerBounds = await assertPickerBounds(menu);
      await assertResetReachable(menu);
      const beforeOuterScroll = await page.evaluate(() => scrollY);
      await page.evaluate(() => scrollBy(0, 80));
      await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(beforeOuterScroll);
      const scrolledPickerBounds = await assertPickerBounds(menu); await assertPickerAnchored(menu); await assertResetReachable(menu);
      await page.screenshot({ path: path.join(output, `opponent-columns-picker-${theme}-${width}.png`) });
      await menu.getByRole('button', { name: 'Reset columns', exact: true }).click();
      for (const label of labels) await expect(menu.getByRole('checkbox', { name: label, exact: true })).not.toBeChecked();
      expect(await page.evaluate(key => localStorage.getItem(key), columnStorageKey)).toBe('{}'); await closePicker(page); checks++;
      await page.reload(); await settled(page); menu = await openPicker(page);
      for (const label of labels) await expect(menu.getByRole('checkbox', { name: label, exact: true })).not.toBeChecked();
      await closePicker(page); checks++;
      cases.push({ width, theme, checks, persistedInNewContext: true, replayNetworkRequests: reads.filter(read => read.path.endsWith('/replay-download')).length - replayBefore, initialPickerBounds, shorterPickerBounds, chromeReservedPickerBounds, restoredPickerBounds, scrolledPickerBounds });
      await context.close(); console.log(JSON.stringify(cases.at(-1)));
    }
    expect(errors).toEqual([]); expect(unexpected).toEqual([]); expect(blocked).toEqual([]); checks += 3;
    const summary = { checks, cases, apiReads: reads.length, explicitReplayRequests: reads.filter(read => read.path.endsWith('/replay-download')).length, unexpected, blocked, errors, layoutStages, productionCssFiles: cssFiles, visualApproval: 'pending root inspection', mutationRequests: 0 };
    fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(output, 'requests.json'), JSON.stringify(reads, null, 2));
    console.log(JSON.stringify(summary));
  } catch (error) {
    const activePage = browser.contexts().flatMap(context => context.pages()).find(page => !page.isClosed());
    if (activePage) {
      const overflow = await activePage.evaluate(() => [...document.querySelectorAll('body *')].map(node => {
        const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
        return { tag: node.tagName, id: node.id, className: String(node.className?.baseVal ?? node.className), text: node.textContent.trim().slice(0, 60), left: rect.left, right: rect.right, width: rect.width, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, overflowX: style.overflowX, position: style.position };
      }).filter(node => node.right > innerWidth + 1 || node.left < -1).slice(0, 150)).catch(() => []);
      const ancestors = await activePage.evaluate(() => {
        const describe = node => { const rect = node.getBoundingClientRect(), style = getComputedStyle(node); return { tag: node.tagName, id: node.id, className: String(node.className), rect: { left: rect.left, right: rect.right, width: rect.width }, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, width: style.width, minWidth: style.minWidth, maxWidth: style.maxWidth, display: style.display, overflowX: style.overflowX, overflowY: style.overflowY, position: style.position }; };
        const chain = []; for (let node = document.querySelector('table'); node; node = node.parentElement) chain.push(describe(node));
        return { chain, outsideRight: [...document.querySelectorAll('body *')].filter(node => node.getBoundingClientRect().right > innerWidth + 1).map(describe).slice(0, 35), scrollingElement: document.scrollingElement?.tagName };
      }).catch(() => ({}));
      fs.writeFileSync(path.join(output, `failure-layout-${currentCase}-${runStamp}.json`), JSON.stringify({ layoutStages, ancestors, overflow }, null, 2));
      await activePage.screenshot({ path: path.join(output, `failure-${currentCase}-${runStamp}.png`), fullPage: true }).catch(() => {});
      await activePage.content().then(html => fs.writeFileSync(path.join(output, `failure-${currentCase}-${runStamp}.html`), html)).catch(() => {});
    }
    throw error;
  } finally {
    holdList = false; for (const send of heldResponses) send(); heldResponses = [];
    await browser.close(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, checks, cases, lastPickerBounds, unexpected, blocked, errors }, null, 2)); server.close(); process.exitCode = 1; });
