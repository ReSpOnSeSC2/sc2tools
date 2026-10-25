const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process'), { chromium, expect } = require('@playwright/test');
const root = process.cwd(), out = path.resolve('../../.cache/try-conversion-host'), evidence = path.resolve('../../.cache/try-conversion-evidence');
fs.mkdirSync(evidence, { recursive: true });
const css = fs.readdirSync('.next/static/css', { recursive: true }).filter(n => n.endsWith('.css')).map(n => fs.readFileSync(path.join('.next/static/css', n), 'utf8')).join('\n');
const fonts = `@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay}`;
let origin, checks = 0, captures = 0; const requests = [], external = [], errors = [], writes = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin || 'http://127.0.0.1'), p = url.pathname;
  requests.push(p);
  if (req.method !== 'GET') { writes.push(p); res.statusCode = 405; return res.end(); }
  if (p === '/fixture') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(`<!doctype html><html lang="en" data-theme="${url.searchParams.get('theme') === 'dark' ? 'dark' : 'light'}"><head><title>Local Try conversion verification</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${fonts}</style></head><body><div id="root"></div><script type="module" src="/js/fixture.js"></script></body></html>`); }
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
  execFileSync(process.execPath, ['tests/manual/try-conversion-fixture.cjs'], { stdio: 'pipe' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, args: ['--proxy-server=direct://', '--proxy-bypass-list=*'] });
  async function context(width, theme, consent = 'granted') {
    const ctx = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce', hasTouch: width < 768 });
    await ctx.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
    await ctx.addInitScript(({ consent }) => {
      window.__warm = 0; window.__shares = []; window.__copied = []; window.__downloads = []; window.__ga = [];
      localStorage.setItem('sc2tools.analyticsConsent.v1', consent); window.gtag = (...args) => window.__ga.push(args);
      Object.defineProperty(navigator, 'share', { configurable: true, value: async data => { window.__shares.push({ text: data.text, files: data.files.map(f => ({ name: f.name, type: f.type, size: f.size })) }); } });
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copied.push(text); } } });
      HTMLAnchorElement.prototype.click = function () { if (this.download) window.__downloads.push(this.download); };
      const draw = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (text, ...args) { (window.__drawn ||= []).push(text); return draw.call(this, text, ...args); };
    }, { consent });
    const page = await ctx.newPage(); page.on('pageerror', error => errors.push(error.message)); return { ctx, page };
  }
  try {
    for (const width of [320, 390, 768, 1440]) for (const theme of ['light', 'dark']) {
      const { ctx, page } = await context(width, theme); const start = requests.length;
      await page.goto(`${origin}/fixture?theme=${theme}`); await expect(page.getByRole('heading', { name: 'Your instant report' })).toBeVisible(); checks++;
      await page.waitForTimeout(100); await check(page.evaluate(() => scrollY === 0 && window.__warm === 0));
      expect(requests.slice(start).filter(p => /sample-payloads|\/engine\//.test(p))).toEqual([]); checks++;
      await expect(page.getByRole('link', { name: 'PvZ - Adept Glaives (Robo)', exact: true })).toHaveAttribute('href', /utm_source=instant/); checks++;
      await overflow(page); await capture(page, `report-${theme}-${width}`, page.getByRole('heading', { name: 'Your instant report' }));
      await page.getByRole('button', { name: 'Share report', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'Share your report' });
      await expect(dialog).toBeVisible(); checks++;
      expect(await dialog.locator('canvas').evaluate(node => [node.width, node.height])).toEqual([1200, 630]); checks++;
      expect(await dialog.getByRole('checkbox', { name: 'Best opener' }).count()).toBe(0); checks++;
      await capture(page, `share-${theme}-${width}`, dialog);
      if (width === 1440 && theme === 'dark') fs.writeFileSync(path.join(evidence, 'report-card.png'), Buffer.from((await dialog.locator('canvas').evaluate(node => node.toDataURL('image/png'))).split(',')[1], 'base64'));
      await dialog.getByRole('checkbox', { name: 'Totals' }).uncheck(); await dialog.getByRole('checkbox', { name: 'Macro score' }).uncheck();
      await dialog.getByRole('button', { name: 'Copy text', exact: true }).click(); await expect(dialog.getByText('Report text copied.')).toBeVisible(); checks++;
      const copied = await page.evaluate(() => window.__copied.at(-1)); expect(copied).not.toMatch(/PRIVATE_FIXTURE|local-fixture|Macro score|4 games/); expect(copied).toContain('utm_medium=share'); checks += 2;
      await dialog.getByRole('button', { name: 'Share PNG', exact: true }).click(); await expect(dialog.getByText('Report shared.')).toBeVisible(); checks++;
      await check(page.evaluate(() => window.__shares.length === 1 && window.__shares[0].files[0].type === 'image/png'));
      await dialog.getByRole('button', { name: 'Download PNG', exact: true }).click(); await expect(dialog.getByText('PNG downloaded.')).toBeVisible(); checks++;
      await check(page.evaluate(() => window.__downloads[0] === 'sc2tools-report.png' && !window.__drawn.join(' ').includes('PRIVATE_FIXTURE')));
      await overflow(page); await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await expect(page.getByRole('button', { name: 'Share report', exact: true })).toBeFocused(); checks += 2;
      await page.getByRole('button', { name: 'See a sample report', exact: true }).click(); const frame = page.getByRole('region', { name: 'Sample replay report' });
      await expect(frame.getByRole('heading', { name: 'Example results' })).toBeVisible(); checks++;
      await check(frame.evaluate(node => !node.textContent.includes('PRIVATE_FIXTURE') && !node.textContent.includes('Save these games')));
      await overflow(page); await capture(page, `sample-${theme}-${width}`, frame);
      await check(page.evaluate(() => window.__ga.filter(row => row[1] === 'instant_report_shared').length === 3 && window.__ga.filter(row => row[1] === 'instant_sample_view').length === 1));
      await ctx.close();
    }
    for (const focus of ['pvz/adept-glaives-robo', 'pvz/not-published', 'pvz/adept-glaives-robo&focus=pvz/adept-glaives-robo']) {
      const { ctx, page } = await context(390, 'dark'); await page.goto(`${origin}/fixture?theme=dark&focus=${focus}`); await expect(page.getByRole('heading', { name: 'Your instant report' })).toBeAttached();
      await page.waitForTimeout(100);
      await check(page.evaluate(valid => valid ? document.activeElement?.getAttribute('data-guide-focus') === 'true' && scrollY > 0 : document.querySelector('[data-guide-focus="true"]') === null && scrollY === 0, focus === 'pvz/adept-glaives-robo'));
      await ctx.close();
    }
    for (const mode of ['all', 'admins', 'off']) {
      const { ctx, page } = await context(390, 'light'); await page.goto(`${origin}/fixture?surface=guide&mode=${mode}`);
      expect(await page.getByRole('link', { name: 'analyze your replays in your browser — no download' }).count()).toBe(mode === 'all' ? 1 : 0); checks++;
      await page.goto(`${origin}/fixture?surface=landing&mode=${mode}`); expect(await page.getByRole('button', { name: 'See a sample report' }).count()).toBe(mode === 'all' ? 1 : 0); checks++;
      if (mode === 'all') { await page.getByRole('button', { name: 'See a sample report' }).click(); await expect(page.getByRole('heading', { name: 'Example results' })).toBeVisible(); await capture(page, 'landing-sample-light-390', page.getByRole('region', { name: 'Sample replay report' })); }
      await ctx.close();
    }
    const denied = await context(390, 'light', 'denied'); await denied.page.goto(`${origin}/fixture?mode=admins`); await expect(denied.page.getByText('Coming soon')).toBeVisible();
    expect(await denied.page.getByRole('button', { name: 'See a sample report' }).count()).toBe(0); checks++;
    await denied.page.goto(`${origin}/fixture?case=stale`); await denied.page.getByRole('button', { name: 'See a sample report' }).click(); await expect(denied.page.getByRole('button', { name: 'Retry sample' })).toBeVisible(); checks++;
    await check(denied.page.evaluate(() => window.__ga.length === 0)); await denied.ctx.close();
    expect(external).toEqual([]); expect(writes).toEqual([]); expect(errors).toEqual([]); checks += 3;
    const result = { checks, captures, writes: writes.length, externalRequests: external.length, engineBoots: 0, mockedNativeSharing: true, evidence };
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } finally { await browser.close(); server.close(); }
}
main().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
