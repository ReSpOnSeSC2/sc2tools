const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process'), { chromium, expect } = require('@playwright/test');
const root = process.cwd(), out = path.resolve(process.env.TRY_CONVERSION_HOST_DIR || '../../.cache/try-conversion-current-host');
const evidence = path.resolve(process.env.TRY_CONVERSION_EVIDENCE_DIR || '../../.cache/try-conversion-current-evidence');
fs.mkdirSync(evidence, { recursive: true });
const css = fs.readdirSync('.next/static/css', { recursive: true }).filter(n => n.endsWith('.css')).map(n => fs.readFileSync(path.join('.next/static/css', n), 'utf8')).join('\n');
const fonts = `@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay}`;
let origin, checks = 0, captures = 0, lastPage; const requests = [], external = [], errors = [], writes = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin || 'http://127.0.0.1'), p = url.pathname;
  requests.push(p);
  if (req.method !== 'GET') { writes.push(p); res.statusCode = 405; return res.end(); }
  if (p === '/fixture') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(`<!doctype html><html lang="en" data-theme="${url.searchParams.get('theme') === 'dark' ? 'dark' : 'light'}" data-theme-mode="${url.searchParams.get('theme') === 'dark' ? 'dark' : 'light'}"><head><title>Local Try conversion verification</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${fonts}</style></head><body><div id="root"></div><script type="module" src="/js/fixture.js"></script></body></html>`); }
  if (p === '/engine/current.json' && /case=stale/.test(req.headers.referer || '')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ engineVersion: '1.6.12', manifest: '/engine/1.6.12/0000000000000000/manifest.json' })); }
  const base = p.startsWith('/js/') ? out : p.startsWith('/fonts/') ? path.join(root, 'app/fonts') : path.join(root, 'public');
  const relative = p.startsWith('/js/') ? p.slice(4) : p.startsWith('/fonts/') ? p.slice(7) : p.slice(1), file = path.resolve(base, relative);
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
});
async function check(value) { expect(await value).toBe(true); checks++; }
async function capture(page, name, target) { await target.scrollIntoViewIfNeeded(); await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: path.join(evidence, `${name}.png`) }); captures++; }
async function overflow(page) { await check(page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); }
async function main() {
  execFileSync(process.execPath, ['tests/manual/try-conversion-fixture.cjs'], { stdio: 'pipe', env: { ...process.env, TRY_CONVERSION_HOST_DIR: out } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  async function context(width, theme, consent = 'granted') {
    const ctx = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce', hasTouch: width < 768 });
    await ctx.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
    await ctx.addInitScript(({ consent }) => {
      window.__warm = 0; window.__shares = []; window.__copied = []; window.__downloads = []; window.__ga = []; window.__clicks = []; window.__pngTimes = [];
      document.addEventListener('click', event => window.__clicks.push({ text: event.target.textContent?.slice(0, 70), aria: event.target.getAttribute?.('aria-label') }), true);
      localStorage.setItem('sc2tools.analyticsConsent.v1', consent); window.gtag = (...args) => window.__ga.push(args);
      Object.defineProperty(navigator, 'share', { configurable: true, value: async data => { window.__shares.push({ text: data.text, files: data.files.map(f => ({ name: f.name, type: f.type, size: f.size })) }); } });
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { if (window.__holdCopy) return new Promise(resolve => { window.__finishCopy = resolve; }); window.__copied.push(text); } } });
      HTMLAnchorElement.prototype.click = function () { if (this.download) window.__downloads.push(this.download); };
      const draw = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (text, ...args) { (window.__drawn ||= []).push(text); return draw.call(this, text, ...args); };
      const encode = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (callback, ...args) { const started = performance.now(); return encode.call(this, blob => { window.__pngTimes.push(performance.now() - started); callback(blob); }, ...args); };
    }, { consent });
    const page = await ctx.newPage(); lastPage = page; page.on('pageerror', error => errors.push(error.message)); return { ctx, page };
  }
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PW_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PW_CHROMIUM_EXECUTABLE } : {}), args: ['--proxy-server=direct://', '--proxy-bypass-list=*'] });
    for (const width of [320, 390, 768, 1440]) for (const theme of ['light', 'dark']) {
      console.log(JSON.stringify({ width, theme }));
      const { ctx, page } = await context(width, theme); const start = requests.length;
      await page.goto(`${origin}/fixture?theme=${theme}`); await expect(page.getByRole('heading', { name: 'Your instant report' })).toBeVisible(); checks++;
      expect(await page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.themeMode, getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()])).toEqual([theme, theme, theme === 'dark' ? '6 9 14' : '244 246 250']); checks++;
      await page.waitForTimeout(100); await check(page.evaluate(() => scrollY === 0 && window.__warm === 0));
      expect(requests.slice(start).filter(p => /sample-payloads|\/engine\//.test(p))).toEqual([]); checks++;
      await expect(page.getByRole('link', { name: 'PvZ - Adept Glaives (Robo)', exact: true })).toHaveAttribute('href', /utm_source=instant/); checks++;
      await overflow(page); await capture(page, `report-${theme}-${width}`, page.getByRole('heading', { name: 'Your instant report' }));
      await page.getByRole('button', { name: 'Share report', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'Share your report' });
      await expect(dialog).toBeVisible(); checks++;
      const close = dialog.getByRole('button', { name: 'Close', exact: true }); await close.focus(); await page.keyboard.press('Shift+Tab'); await expect(dialog.getByText('Report text', { exact: true })).toBeFocused(); await page.keyboard.press('Tab'); await expect(close).toBeFocused(); checks += 2;
      if (width === 320 || width === 1440) { await page.addScriptTag({ path: require.resolve('axe-core') }); const violations = await dialog.evaluate(async node => (await window.axe.run(node)).violations.map(row => row.id)); expect(violations).toEqual([]); checks++; }
      expect(await dialog.locator('canvas').evaluate(node => [node.width, node.height])).toEqual([1200, 630]); checks++;
      expect(await dialog.getByRole('checkbox', { name: 'Best opener' }).count()).toBe(0); checks++;
      await capture(page, `share-${theme}-${width}`, dialog);
      if (width === 1440 && theme === 'dark') fs.writeFileSync(path.join(evidence, 'report-card.png'), Buffer.from((await dialog.locator('canvas').evaluate(node => node.toDataURL('image/png'))).split(',')[1], 'base64'));
      await dialog.getByRole('checkbox', { name: 'Totals' }).uncheck(); await dialog.getByRole('checkbox', { name: 'Macro score' }).uncheck();
      await dialog.getByRole('button', { name: 'Copy text', exact: true }).click(); await expect(dialog.getByText('Report text copied.')).toBeVisible(); checks++;
      const copied = await page.evaluate(() => window.__copied.at(-1)); expect(copied).not.toMatch(/PRIVATE_FIXTURE|local-fixture|Macro score|4 games/); expect(copied).toContain('utm_medium=share'); checks += 2;
      await dialog.getByRole('button', { name: 'Share PNG', exact: true }).click(); await expect(dialog.getByText('Report shared.')).toBeVisible({ timeout: 20_000 }); checks++;
      await check(page.evaluate(() => window.__shares.length === 1 && window.__shares[0].files[0].type === 'image/png'));
      await dialog.getByRole('button', { name: 'Download PNG', exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.__downloads.length), { timeout: 20_000 }).toBe(1);
      await expect(page.getByText('PNG downloaded.', { exact: true })).toBeVisible();
      await expect(page.getByRole('dialog', { name: 'Share your report' })).toBeVisible(); checks += 2;
      await check(page.evaluate(() => window.__downloads[0] === 'sc2tools-report.png' && !window.__drawn.join(' ').includes('PRIVATE_FIXTURE')));
      await overflow(page); await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await expect(page.getByRole('button', { name: 'Share report', exact: true })).toBeFocused(); checks += 2;
      await check(page.evaluate(() => window.__ga.filter(row => row[1] === 'instant_report_shared').length === 3));
      await page.goto(`${origin}/fixture?theme=${theme}&case=empty`); await expect(page.getByRole('button', { name: 'See a sample report', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'See a sample report', exact: true }).click(); const frame = page.getByRole('region', { name: 'Sample replay report' });
      await expect(frame.getByRole('heading', { name: 'Example results' })).toBeVisible(); checks++;
      await check(frame.evaluate(node => !node.textContent.includes('PRIVATE_FIXTURE') && !node.textContent.includes('Save these games')));
      await expect(page.getByRole('heading', { name: 'Save these games to your free account' })).toHaveCount(0); checks++;
      await overflow(page); await frame.evaluate(node => node.scrollIntoView({ block: 'start' })); await capture(page, `sample-${theme}-${width}`, frame.getByRole('heading', { name: 'Sample replay report', exact: true }));
      await check(page.evaluate(() => window.__ga.filter(row => row[1] === 'instant_sample_view').length === 1));
      await ctx.close();
    }
    const recovery = await context(320, 'light'); await recovery.page.goto(`${origin}/fixture?theme=light`);
    await recovery.page.getByRole('button', { name: 'Share report', exact: true }).click();
    const recoveryDialog = recovery.page.getByRole('dialog', { name: 'Share your report' });
    await recovery.page.evaluate(() => { window.__holdCopy = true; });
    await recoveryDialog.getByRole('button', { name: 'Copy text', exact: true }).click();
    const fallback = recoveryDialog.getByRole('textbox', { name: 'Copy report text manually' });
    await expect(fallback).toBeFocused({ timeout: 10_000 }); checks++;
    await check(fallback.evaluate(node => node.readOnly && node.selectionStart === 0 && node.selectionEnd === node.value.length));
    await expect(recoveryDialog.getByRole('checkbox', { name: 'Totals' })).toBeEnabled(); checks++;
    await recovery.page.evaluate(() => { window.__finishCopy(); window.__holdCopy = false; });
    await check(recovery.page.evaluate(() => window.__ga.filter(row => row[1] === 'instant_report_shared').length === 0));
    await overflow(recovery.page); await capture(recovery.page, 'copy-recovery-light-320', fallback);
    await recovery.page.keyboard.press('Escape'); await expect(recoveryDialog).toBeVisible(); await expect(fallback).toHaveCount(0); await expect(recoveryDialog.getByRole('button', { name: 'Copy text', exact: true })).toBeFocused(); checks += 3;
    await recoveryDialog.getByRole('button', { name: 'Copy text', exact: true }).click(); await expect(recoveryDialog.getByText('Report text copied.')).toBeVisible(); checks++;
    await check(recovery.page.evaluate(() => window.__ga.filter(row => row[1] === 'instant_report_shared').length === 1));
    await recovery.ctx.close();
    for (const focus of ['pvz/adept-glaives-robo', 'pvz/not-published', 'pvz/adept-glaives-robo&focus=pvz/adept-glaives-robo']) {
      const { ctx, page } = await context(390, 'dark'); await page.goto(`${origin}/fixture?theme=dark&focus=${focus}`); await expect(page.getByRole('heading', { name: 'Your instant report' })).toBeAttached();
      await page.waitForTimeout(100);
      await check(page.evaluate(valid => valid ? document.activeElement?.getAttribute('data-guide-focus') === 'true' && scrollY > 0 : document.querySelector('[data-guide-focus="true"]') === null && scrollY === 0, focus === 'pvz/adept-glaives-robo'));
      if (focus === 'pvz/adept-glaives-robo') {
        await page.getByRole('button', { name: 'Share report', exact: true }).evaluate(node => node.focus({ preventScroll: true }));
        const y = await page.evaluate(() => scrollY); await page.evaluate(() => window.fixtureNavigate('?theme=dark'));
        await expect.poll(() => page.locator('[data-guide-focus="true"]').count()).toBe(0); checks++;
        await check(page.evaluate(before => scrollY === before && document.activeElement?.textContent === 'Share report', y));
        await page.evaluate(() => window.fixtureNavigate('?theme=dark&focus=pvz/adept-glaives-robo'));
        await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-guide-focus'))).toBe('true'); checks++;
      }
      await ctx.close();
    }
    for (const mode of ['all', 'admins', 'off']) {
      const { ctx, page } = await context(390, 'light'); await page.goto(`${origin}/fixture?surface=guide&mode=${mode}`);
      expect(await page.getByRole('link', { name: 'analyze your replays in your browser — no download' }).count()).toBe(mode === 'all' ? 1 : 0); checks++;
      await page.goto(`${origin}/fixture?surface=cta&mode=${mode}`); await expect(page.getByRole('link', { name: mode === 'all' ? 'Analyze your replays free' : 'Get yours at sc2tools.com' })).toHaveAttribute('href', mode === 'all' ? /\/try\?utm_source=player/ : '/'); checks++;
      await page.goto(`${origin}/fixture?surface=landing&mode=${mode}`); expect(await page.getByRole('button', { name: 'See a sample report' }).count()).toBe(mode === 'all' ? 1 : 0); checks++;
      if (mode === 'all') { await page.getByRole('button', { name: 'See a sample report' }).click(); await expect(page.getByRole('heading', { name: 'Example results' })).toBeVisible(); await capture(page, 'landing-sample-light-390', page.getByRole('heading', { name: 'Sample replay report', exact: true })); }
      await ctx.close();
    }
    const denied = await context(390, 'light', 'denied'); await denied.page.goto(`${origin}/fixture?mode=admins`); await expect(denied.page.getByText('Coming soon')).toBeVisible();
    expect(await denied.page.getByRole('button', { name: 'See a sample report' }).count()).toBe(0); checks++;
    await denied.page.goto(`${origin}/fixture`); await denied.page.getByRole('button', { name: 'Share report', exact: true }).click(); await denied.page.getByRole('button', { name: 'Copy text', exact: true }).click(); await expect(denied.page.getByText('Report text copied.')).toBeVisible(); await check(denied.page.evaluate(() => window.__ga.length === 0));
    await denied.page.goto(`${origin}/fixture?case=stale`); await denied.page.getByRole('button', { name: 'See a sample report' }).click(); await expect(denied.page.getByRole('button', { name: 'Retry sample' })).toBeVisible(); checks++;
    await check(denied.page.evaluate(() => window.__ga.length === 0)); await denied.ctx.close();
    expect(external).toEqual([]); expect(writes).toEqual([]); expect(errors).toEqual([]); checks += 3;
    const result = { checks, captures, writes: writes.length, externalRequests: external.length, engineBoots: 0, mockedNativeSharing: true, evidence };
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } catch (error) {
    if (lastPage && !lastPage.isClosed()) { await lastPage.screenshot({ path: path.join(evidence, 'failure.png') }); fs.writeFileSync(path.join(evidence, 'failure.json'), JSON.stringify(await lastPage.evaluate(() => ({ clicks: window.__clicks, shares: window.__shares, downloads: window.__downloads, pngTimes: window.__pngTimes, active: document.activeElement?.tagName, dialog: document.querySelector('[role="dialog"]')?.textContent })), null, 2)); }
    throw error;
  } finally { await browser?.close(); server.close(); }
}
main().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
