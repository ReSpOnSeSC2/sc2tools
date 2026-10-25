/* After the joint production build: node tests/manual/game-story.cjs.
 * Actual story/page/replay components and production CSS; explicit synthetic
 * API/auth/Next boundaries. No request may leave this localhost fixture. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');
execFileSync(process.execPath, ['tests/manual/game-story-fixture.cjs'], { stdio: 'inherit' });
const root = process.cwd(), origin = 'http://127.0.0.1:3218';
const styles = fs.readdirSync('.next/static/css').filter(name => name.endsWith('.css')).map(name => fs.readFileSync(path.join('.next/static/css', name), 'utf8')).join('\n')
  + '\n' + fs.readFileSync('.tmp/game-story-fixture.css', 'utf8');
const fonts = "@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2')}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2')}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay;--font-serif:serif}";
const html = `<!doctype html><html data-theme="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin);
  if (url.pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync('.tmp/game-story-fixture.js')); }
  if (url.pathname.startsWith('/app')) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(html); }
  const base = url.pathname.startsWith('/_next/') ? path.join(root, '.next') : url.pathname.startsWith('/fonts/') ? path.join(root, 'app', 'fonts') : path.join(root, 'public');
  const relative = url.pathname.startsWith('/_next/') || url.pathname.startsWith('/fonts/') ? url.pathname.slice(7) : url.pathname.slice(1);
  const file = path.resolve(base, relative);
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', { '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
let checks = 0;
(async () => {
  await new Promise(resolve => server.listen(3218, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [320, 390, 768, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      for (const theme of ['light', 'dark']) {
        await page.goto(origin + '/app/game/sample?variant=loss');
        await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
        const loss = page.getByRole('tab', { name: 'Why you lost', exact: true });
        await expect(loss).toHaveAttribute('aria-selected', 'true'); checks++;
        await page.getByRole('tab', { name: 'Game story', exact: true }).click();
        const story = page.getByTestId('game-story-card');
        await expect(story).toBeVisible();
        await expect(story.getByRole('img', { name: /Relative lead/ })).toBeVisible(); checks++;
        const ledger = story.getByTestId(width === 1440 ? 'fight-ledger-table' : 'fight-ledger-cards');
        await expect(ledger).toBeVisible(); checks++;
        await expect(ledger.getByText('Trade unknown · missing prices')).toBeVisible(); checks++;
        await story.evaluate(element => window.scrollTo(0, scrollY + element.getBoundingClientRect().top - 115));
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Story overflow at ' + width);
        const targets = await story.locator('button:visible').evaluateAll(buttons => buttons.map(button => ({ label: button.textContent, height: button.getBoundingClientRect().height })));
        if (targets.some(target => target.height < 43)) throw new Error(JSON.stringify(targets)); checks++;
        await page.screenshot({ path: `../../docs/handoff/screenshots/game-story-${theme}-${width}.png`, fullPage: false });
        if (width === 390 || width === 1440) {
          await ledger.evaluate(element => window.scrollTo(0, scrollY + element.getBoundingClientRect().top - 200));
          await page.screenshot({ path: `../../docs/handoff/screenshots/game-story-ledger-${theme}-${width}.png`, fullPage: false });
        }
        const stage = page.getByTestId('replay-stage');
        await ledger.getByRole('button', { name: 'Watch fight at 3:10' }).click();
        await expect(stage.getByLabel('Game clock 3:10 of 10:00')).toBeVisible();
        await expect(stage).toBeFocused(); checks++;
      }
      await page.goto(origin + '/app/game/sample?variant=win');
      await expect(page.getByRole('heading', { name: 'Still cost you' })).toBeVisible();
      await expect(page.getByRole('tablist', { name: 'Game analysis' })).toHaveCount(0); checks++;
      await page.goto(origin + '/app/game/sample?variant=draw');
      await expect(page.getByRole('heading', { name: 'Game story', exact: true })).toBeVisible(); checks++;
      await page.goto(origin + '/app/game/sample?variant=empty');
      await expect(page.getByTestId('game-story-card')).toHaveCount(0);
      await expect(page.getByTestId('game-story-layout')).not.toHaveClass(/md:grid-cols-2/); checks++;
      await page.goto(origin + '/app/game/sample?variant=win&estimated=1');
      await expect(page.getByRole('heading', { name: /Fight ledger.*estimated/ })).toBeVisible();
      await expect(page.getByText('Army-value drops estimate fight windows.', { exact: false })).toBeVisible(); checks++;
      if (errors.length) throw new Error(JSON.stringify(errors));
      console.log(JSON.stringify({ width, checks, errors }));
      await context.close();
    }
    console.log(`${checks} story browser checks passed`);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
