// Real replay/card components, local synthetic API/auth and committed fonts.
// Run after a production build from apps/web: node tests/manual/playback-quality.cjs.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');
execFileSync(process.execPath, ['tests/manual/game-navigation-fixture.cjs'], { stdio: 'inherit' });
const root = process.cwd(), origin = 'http://127.0.0.1:3218';
const css = fs.readdirSync('.next/static/css').filter(name => name.endsWith('.css')).map(name => fs.readFileSync(path.join('.next/static/css', name), 'utf8')).join('\n');
const fonts = `@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2')}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2')}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay;--font-serif:serif}`;
const html = `<!doctype html><html data-theme="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin);
  if (url.pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync('.tmp/game-navigation-fixture.js')); }
  if (url.pathname.startsWith('/app')) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(html); }
  const font = url.pathname.startsWith('/fonts/'), next = url.pathname.startsWith('/_next/');
  const base = path.join(root, font ? 'app/fonts' : next ? '.next' : 'public');
  const file = path.resolve(base, url.pathname.slice(font || next ? 7 : 1));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', { '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp' }[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise(resolve => server.listen(3218, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true }); let checks = 0;
  try {
    for (const width of [320, 390, 768, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
      await page.goto(origin + '/app/game/sample?phase=processing');
      const card = page.getByRole('complementary', { name: 'Playback quality' });
      await expect(card).toContainText('Desktop app online');
      await expect(card.locator('[aria-current="step"]')).toContainText('Recording in StarCraft'); checks += 2;
      await page.getByRole('link', { name: 'Replay accuracy' }).click();
      await expect(card.locator('details')).toHaveAttribute('open', '');
      await expect(card.locator('summary')).toBeFocused(); checks += 2;
      await card.scrollIntoViewIfNeeded(); await page.evaluate(() => document.fonts.ready);
      await card.evaluate(node => window.scrollTo(0, scrollY + node.getBoundingClientRect().top - 120));
      const geometry = await page.getByTestId('map-replayer').evaluate(node => ({
        replayer: node.getBoundingClientRect().height, band: node.parentElement.getBoundingClientRect().height,
        bandHeight: getComputedStyle(node.parentElement).height, bandMinHeight: getComputedStyle(node.parentElement).minHeight,
      }));
      console.log(JSON.stringify({ width, geometry }));
      if (width < 1280 && geometry.band < 256) throw new Error(`Collapsed replay band at ${width}`); checks++;
      const clippedStats = await page.getByTestId('replay-top-bar').locator('[title*=" — "]').evaluateAll(nodes => nodes.filter(node => [...node.children].some(child => !child.classList.contains('sr-only') && child.scrollWidth > child.clientWidth + 1)).length);
      if (clippedStats) throw new Error(`Clipped replay HUD stats at ${width}`); checks++;
      const overlap = await page.evaluate(() => document.querySelector('[data-testid="replay-top-bar"]').getBoundingClientRect().bottom > document.querySelector('[data-testid="replay-transport"]').getBoundingClientRect().top + 1);
      if (overlap) throw new Error(`Replay transport covers the HUD at ${width}`); checks++;
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`Body overflow at ${width}`); checks++;
      await page.screenshot({ path: `../../docs/handoff/screenshots/playback-quality-${width}.png`, fullPage: false });
      await page.goto(origin + '/app/game/sample?recorded=1');
      await expect(card).toContainText('Recorded playback');
      await expect(card.getByRole('button', { name: 'Generate accurate playback' })).toHaveCount(0); checks += 2;
      await page.goto(origin + '/app/game/sample?offline=1');
      await expect(card).toContainText('Desktop app offline');
      await expect(card.getByRole('button', { name: 'Generate accurate playback' })).toBeDisabled();
      await expect(card.getByRole('status')).toHaveCount(0); checks += 3;
      if (width === 390 || width === 1440) {
        await expect(page.getByTestId('replay-stage')).toBeVisible();
        await expect(page.getByText('Loading replay controls…')).toHaveCount(0); checks += 2;
        await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
        await page.evaluate(() => document.fonts.ready);
        await card.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `../../docs/handoff/screenshots/playback-quality-${width}-dark.png`, fullPage: false }); checks++;
      }
      if (errors.length) throw new Error(JSON.stringify(errors));
      console.log(JSON.stringify({ width, checks, errors })); await page.close();
    }
    console.log(`${checks} playback quality browser checks passed`);
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
