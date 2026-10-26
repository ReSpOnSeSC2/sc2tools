/* Run from apps/web AFTER the final production build. All data is synthetic;
 * actual Library/dialog/editor/Practice consumers use the current CSS/fonts. */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');
const { buildDoc } = require('./build-dialogs-fixture.cjs');
const { dossier } = require('./build-dossier-insights-fixture.cjs');
const root = process.cwd(), workspace = path.resolve(root, '../..'), origin = 'http://127.0.0.1:3272';
const host = path.resolve(process.env.BUILD_DIALOGS_HOST_DIR || '../../.cache/build-dialogs-current-host');
const evidence = path.resolve(process.env.BUILD_DIALOGS_EVIDENCE_DIR || '../../.cache/build-dialogs-current-evidence');
for (const directory of [host, evidence]) {
  if (!directory.startsWith(path.join(workspace, '.cache') + path.sep)) throw new Error('Evidence must stay inside this workspace cache');
  if (fs.existsSync(directory)) throw new Error(`Preserve existing evidence: ${directory}`);
}
if (process.env.A11Y_COLLECT_ONLY === '1') throw new Error('Authoritative dialog checks require full accessibility assertions');
fs.mkdirSync(evidence);
execFileSync(process.execPath, ['tests/manual/build-dialogs-fixture.cjs'], { stdio: 'inherit', env: { ...process.env, BUILD_DIALOGS_HOST_DIR: host } });
const css = fs.readdirSync('.next/static/css', { recursive: true }).filter(name => name.endsWith('.css')).map(name => fs.readFileSync(path.join('.next/static/css', name), 'utf8')).join('\n');
const fonts = "@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:600 800}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay;--font-serif:serif}";
const calls = [], writes = [], previewReads = [], invalidPreviews = [], closeBounds = [], external = [], errors = [], defaultFocus = [], unexpectedGETs = [];
const held = new Set(), errorHeld = new Set();
let mode = 'ready', publicationSeen = false, checks = 0, captures = 0, aaCalls = 0;
const docPath = `/v1/custom-builds/${buildDoc.slug}`, pubPath = `/v1/community/my-build-publication/${buildDoc.slug}`;
const previewPath = '/v1/custom-builds/preview-matches';
const privateDoc = () => ({ ...buildDoc, notes: 'Synthetic private scouting note.' });
const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin), pathname = url.pathname;
  const json = (value, status = 200) => { if (res.destroyed) return; res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (pathname.startsWith('/v1/')) {
    calls.push({ path: pathname, search: url.search, method: req.method, owner: (req.headers.authorization || '').replace(/^Bearer /, '') });
    if (req.method === 'POST' && pathname === previewPath) {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        try {
          expect(req.headers.authorization).toBe('Bearer dialog-owner');
          expect(raw.length).toBeLessThan(64 * 1024);
          const body = JSON.parse(raw);
          expect(body).toEqual({ rules: buildDoc.rules, race: buildDoc.race, vsRace: buildDoc.vsRace, perspective: 'you' });
          previewReads.push({ owner: 'dialog-owner', body });
          json({ matches: [], almost_matches: [], scanned_games: 0, truncated: false });
        } catch (error) {
          invalidPreviews.push(error.message);
          json({ error: { code: 'fixture_invalid_preview', message: error.message } }, 400);
        }
      });
      return;
    }
    if (req.method !== 'GET') { writes.push(pathname); return json({ error: { code: 'fixture_write_blocked' } }, 405); }
    if (pathname === '/v1/site/banner') return json({ banner: null });
    if (pathname === '/v1/build-intents/pending') return json({ items: [], total: 0, disabled: false });
    if (pathname === '/v1/coaching/alerts') return json({ eligible: false, unreadCount: 0, alert: null });
    if (pathname === '/v1/coaching/me') return json({ role: 'none' });
    if (pathname === '/v1/me/notifications/unread-count') return json({ count: 0 });
    if (pathname === '/v1/me/preferences/ghost') return json({ v: 2, slots: {}, revision: 0 });
    if (pathname === '/v1/custom-builds') return json({ items: [buildDoc], total: 1, libraryTotal: 1, limit: 50, nextCursor: null });
    if (pathname === '/v1/custom-builds/stats') return json([{ slug: buildDoc.slug, name: buildDoc.name, total: 12, wins: 7, losses: 5, winRate: 7 / 12, planHeldRate: .6 }]);
    if (pathname === '/v1/custom-builds/reclassify-status') return json({ status: 'idle' });
    if (pathname === pubPath) {
      publicationSeen = true;
      for (const release of [...errorHeld]) release();
      return json({ published: false, authorName: '', publishAnonymously: false, mirrorPending: false, publicSlug: null });
    }
    if (pathname === docPath) {
      if (mode === 'error') {
        const release = () => { errorHeld.delete(release); json({ error: { code: 'fixture_unavailable', message: 'Synthetic saved build unavailable' } }, 503); };
        if (publicationSeen) release();
        else { errorHeld.add(release); res.once('close', () => errorHeld.delete(release)); }
        return;
      }
      if (mode === 'hold') {
        const release = () => { held.delete(release); json(privateDoc()); };
        held.add(release); res.once('close', () => held.delete(release)); return;
      }
      return json(privateDoc());
    }
    if (pathname === `${docPath}/matches`) { const value = dossier(); value.name = buildDoc.name; delete value.communityTimings; return json(value); }
    if (pathname === `${docPath}/compositions`) {
      const phases = ['early', 'earlyMid', 'mid', 'midLate', 'late'];
      const zero = Object.fromEntries(phases.map(phase => [phase, 0]));
      return json({ slug: buildDoc.slug, name: buildDoc.name, perspective: 'you', sampleSize: zero, finalPhaseDistribution: zero,
        perPhase: Object.fromEntries(phases.map(phase => [phase, { signatures: [], tech: [], upgrades: [] }])),
        medianCrossings: { earlyMidAt: null, midAt: null, midLateAt: null, lateAt: null }, durationP95Sec: 0, flags: [] });
    }
    if (pathname === `${docPath}/transitions`) return json({ slug: buildDoc.slug, name: buildDoc.name,
      transitions: { nodes: [], edges: [], rare: { collapsedNodes: 0, collapsedEdges: 0 }, byMatchup: {} } });
    if (pathname === '/v1/me' || pathname === '/v1/me/profile') return json({ displayName: 'Synthetic player', agentLastSeenAt: null });
    unexpectedGETs.push(pathname + url.search);
    return json({ error: { code: 'fixture_unexpected_get', message: `Unspecified synthetic GET: ${pathname}` } }, 404);
  }
  if (pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync(path.join(host, 'fixture.js'))); }
  if (pathname === '/builds') {
    const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(`<!doctype html><html lang="en" data-theme="${theme}" data-theme-mode="${theme}"><head><title>Local build dialog verification</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  }
  const base = pathname.startsWith('/fonts/') ? path.join(root, 'app/fonts') : path.join(root, 'public');
  const file = path.resolve(base, pathname.startsWith('/fonts/') ? pathname.slice(7) : pathname.slice(1));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', ({ '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' })[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});

(async () => {
  let browser, activePage;
  const releaseHeld = () => { for (const release of [...held, ...errorHeld]) release(); };
  const reads = pathname => calls.filter(call => call.path === pathname).length;
  const assertFit = async (dialog, width) => {
    const rect = await dialog.boundingBox(); expect(rect).not.toBeNull();
    expect(rect.width).toBeLessThanOrEqual(Math.min(width, 896) + 1);
    expect(rect.x).toBeGreaterThanOrEqual(-1); expect(rect.x + rect.width).toBeLessThanOrEqual(width + 1);
    if (width === 1440) expect(Math.round(rect.width)).toBe(896);
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true); checks++;
  };
  try {
    const aaAdapter = path.join(host, 'aa.cjs');
    const aaDependencies = ['@axe-core/playwright', '@playwright/test'].map(name => [name, require.resolve(name)]);
    require('esbuild').buildSync({ entryPoints: ['tests/e2e/accessibility-check.ts'], bundle: true, platform: 'node', format: 'cjs',
      packages: 'external', alias: Object.fromEntries(aaDependencies), external: aaDependencies.map(([, file]) => file), outfile: aaAdapter, logLevel: 'warning' });
    const { checkAccessibility } = require(aaAdapter);
    const checkAA = async (page, state, width, theme) => {
      await checkAccessibility(page, { project: { name: `manual-${width}` }, attach: async (_name, { body }) => {
        fs.writeFileSync(path.join(evidence, `aa-${state}-${theme}-${width}.json`), body);
      } }, '/builds', theme); checks++; aaCalls++;
      expect(unexpectedGETs).toEqual([]);
      expect(invalidPreviews).toEqual([]);
    };
    const capture = async (dialog, state, width, theme) => {
      await dialog.screenshot({ path: path.join(evidence, `${state}-${theme}-${width}.png`) }); captures++;
      const panel = await dialog.boundingBox();
      const close = await dialog.getByRole('button', { name: 'Close', exact: true }).boundingBox();
      closeBounds.push({ state, width, theme, panel, close, viewport: { width, height: 1000 } });
      expect(panel).not.toBeNull(); expect(close).not.toBeNull();
      expect(close.width).toBeGreaterThanOrEqual(44); expect(close.height).toBeGreaterThanOrEqual(44);
      expect(close.x).toBeGreaterThanOrEqual(Math.max(0, panel.x));
      expect(close.y).toBeGreaterThanOrEqual(Math.max(0, panel.y));
      expect(close.x + close.width).toBeLessThanOrEqual(Math.min(width, panel.x + panel.width));
      expect(close.y + close.height).toBeLessThanOrEqual(Math.min(1000, panel.y + panel.height)); checks++;
    };
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(3272, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    browser = await chromium.launch({ headless: true, ...(process.env.PW_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PW_CHROMIUM_EXECUTABLE } : {}) });
    for (const width of [320, 390, 768, 1440]) for (const theme of ['light', 'dark']) {
      mode = 'ready'; releaseHeld();
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', colorScheme: theme, timezoneId: 'UTC' });
      await context.addInitScript(value => localStorage.setItem('sc2tools.theme', value), theme);
      await context.route('**/*', route => {
        const url = route.request().url();
        if (url.startsWith(origin + '/')) return route.continue();
        external.push(url); return route.abort();
      });
      const page = await context.newPage(); activePage = page; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/builds?theme=${theme}`);
      await expect.poll(() => page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.themeMode,
        getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(), getComputedStyle(document.documentElement).colorScheme]))
        .toEqual([theme, theme, theme === 'dark' ? '6 9 14' : '244 246 250', theme]); checks++;
      const launch = page.getByRole('button', { name: `Open ${buildDoc.name} dossier`, exact: true });
      await expect(launch).toBeVisible();
      const openDossier = async () => {
        await launch.focus(); await launch.click();
        const dialog = page.getByRole('dialog', { name: `${buildDoc.name} dossier`, exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('heading', { name: 'Key timings', exact: true })).toBeVisible();
        await assertFit(dialog, width);
        expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden'); checks++;
        return dialog;
      };
      const closeToLibrary = async dialog => {
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0); await expect(launch).toBeFocused();
        expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden'); checks++;
      };
      let dialog = await openDossier();
      const closeRect = await dialog.getByRole('button', { name: 'Close', exact: true }).boundingBox(); expect(closeRect.height).toBeGreaterThanOrEqual(44); expect(closeRect.width).toBeGreaterThanOrEqual(44); checks++;
      await checkAA(page, 'dossier', width, theme); await capture(dialog, 'dossier', width, theme);
      const practiceTrigger = dialog.getByRole('button', { name: `Practice options for ${buildDoc.name}`, exact: true });
      await practiceTrigger.click();
      const practice = page.getByRole('dialog', { name: `Practice ${buildDoc.name}`, exact: true }); await expect(practice).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(2); expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden'); checks++;
      await checkAA(page, 'practice', width, theme); await capture(practice, 'practice', width, theme);
      await page.keyboard.press('Escape'); await expect(practice).toHaveCount(0); await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: `Practice options for ${buildDoc.name}`, exact: true })).toBeFocused();
      expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden'); checks++;
      const options = dialog.getByRole('button', { name: `Build options for ${buildDoc.name}`, exact: true });
      await options.click(); await expect(page.getByRole('menu')).toBeVisible();
      await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0); await expect(options).toBeFocused(); await expect(dialog).toBeVisible(); checks++;
      await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(launch).toBeFocused();
      expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden'); checks++;

      const editFromMenu = async () => {
        dialog = await openDossier();
        await dialog.getByRole('button', { name: `Build options for ${buildDoc.name}`, exact: true }).click();
        await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
      };
      mode = 'hold'; let docBefore = reads(docPath), pubBefore = reads(pubPath);
      await editFromMenu(); await expect.poll(() => held.size).toBe(1);
      let edit = page.getByRole('dialog', { name: 'Edit build', exact: true });
      await expect(edit.getByRole('status')).toHaveText('Loading build…'); await assertFit(edit, width);
      await expect(edit.locator('[aria-busy="true"]')).toHaveCount(1); await expect(page.getByRole('dialog')).toHaveCount(1); checks++;
      await expect.poll(() => reads(docPath) - docBefore).toBe(1); await expect.poll(() => reads(pubPath) - pubBefore).toBe(1); checks++;
      await checkAA(page, 'loading', width, theme); await capture(edit, 'loading', width, theme);
      await closeToLibrary(edit); releaseHeld(); await page.waitForLoadState('networkidle');
      await expect(page.getByRole('textbox', { name: 'Personal notes (private)', exact: true })).toHaveCount(0); checks++;

      mode = 'error'; publicationSeen = false; docBefore = reads(docPath); pubBefore = reads(pubPath); await editFromMenu();
      edit = page.getByRole('dialog', { name: 'Edit build', exact: true });
      await expect(edit.getByRole('alert')).toBeVisible(); await expect(edit.locator('[aria-busy="false"]')).toHaveCount(1); checks++;
      await expect.poll(() => reads(docPath) - docBefore).toBe(1); await expect.poll(() => reads(pubPath) - pubBefore).toBe(1); checks++;
      await checkAA(page, 'error', width, theme); await capture(edit, 'error', width, theme);
      mode = 'hold'; docBefore = reads(docPath); pubBefore = reads(pubPath); await edit.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect.poll(() => held.size).toBe(1); await expect.poll(() => reads(docPath) - docBefore).toBe(1); await expect.poll(() => reads(pubPath) - pubBefore).toBe(1); checks++;
      releaseHeld(); const name = page.getByRole('textbox', { name: /^Name/ }); await expect(name).toHaveValue(buildDoc.name);
      await expect(page.getByRole('dialog')).toHaveCount(1); edit = page.getByRole('dialog');
      expect(await edit.evaluate(node => node.contains(document.activeElement))).toBe(true); checks++;
      defaultFocus.push({ width, theme, active: await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.getAttribute('name') || document.activeElement?.textContent?.trim()) });
      await expect(edit.getByRole('textbox', { name: 'Personal notes (private)', exact: true })).toHaveValue(privateDoc().notes); checks++;
      await checkAA(page, 'editor', width, theme); await capture(edit, 'editor', width, theme); await closeToLibrary(edit);

      mode = 'ready'; dialog = await openDossier(); docBefore = reads(docPath); pubBefore = reads(pubPath);
      await dialog.getByRole('button', { name: 'Edit the build', exact: true }).click();
      const notes = page.getByRole('textbox', { name: 'Personal notes (private)', exact: true });
      await expect(notes).toHaveValue(privateDoc().notes); await expect(notes).toBeFocused(); checks++;
      await expect.poll(() => reads(docPath) - docBefore).toBe(1); await expect.poll(() => reads(pubPath) - pubBefore).toBe(1); checks++;
      edit = page.getByRole('dialog'); await checkAA(page, 'notes', width, theme); await capture(edit, 'notes', width, theme); await closeToLibrary(edit);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]); checks++;
      await context.close(); activePage = null; console.log(JSON.stringify({ width, theme, checks, captures, completed: true }));
    }
    expect(writes).toEqual([]); expect(calls.every(call => call.method === 'GET' || call.method === 'POST' && call.path === previewPath)).toBe(true); expect(unexpectedGETs).toEqual([]); expect(invalidPreviews).toEqual([]); expect(previewReads.length).toBeGreaterThan(0); checks++;
    const result = { checks, captures, aaCalls, calls, writes, previewReads, invalidPreviews, closeBounds, unexpectedGETs, externalAttempts: external, defaultFocus, errors };
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ checks, captures, aaCalls, previewReads: previewReads.length, writes: writes.length, externalAttempts: external.length, evidence }));
  } catch (error) {
    fs.writeFileSync(path.join(evidence, 'failure.json'), JSON.stringify({ message: error.message, checks, captures, calls, writes, previewReads, invalidPreviews, closeBounds, unexpectedGETs, externalAttempts: external, errors }, null, 2));
    if (activePage && !activePage.isClosed()) {
      fs.writeFileSync(path.join(evidence, 'failure.html'), await activePage.content());
      await activePage.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
    }
    throw error;
  } finally {
    try { releaseHeld(); }
    finally { try { await browser?.close(); } finally { if (server.listening) await new Promise(resolve => server.close(resolve)); } }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
