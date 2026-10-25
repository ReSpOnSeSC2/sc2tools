/* Run from apps/web after a production build: node tests/manual/game-navigation.cjs.
 * Real game components and production CSS, with explicit synthetic API/auth/Next boundaries.
 * No requests leave this local fixture; no account data or production writes are used.
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');
execFileSync(process.execPath, ['tests/manual/game-navigation-fixture.cjs'], { stdio: 'inherit' });
const root = process.cwd();
const styles = fs.readdirSync('.next/static/css').filter((name) => name.endsWith('.css')).map((name) => fs.readFileSync(path.join('.next/static/css', name), 'utf8')).join('\n');
const fonts = `@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2')}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2')}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay;--font-serif:serif}`;
const html = `<!doctype html><html data-theme="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:3217');
  if (url.pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync('.tmp/game-navigation-fixture.js')); }
  if (url.pathname.startsWith('/app')) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(html); }
  const base = url.pathname.startsWith('/_next/') ? path.join(root, '.next') : url.pathname.startsWith('/fonts/') ? path.join(root, 'app', 'fonts') : path.join(root, 'public');
  const relative = url.pathname.startsWith('/_next/') ? url.pathname.slice(7) : url.pathname.startsWith('/fonts/') ? url.pathname.slice(7) : url.pathname.slice(1);
  const file = path.resolve(base, relative);
  if (!file.startsWith(`${base}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  const mime = { '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(file)] || 'application/octet-stream';
  res.setHeader('Content-Type', mime); res.end(fs.readFileSync(file));
});

(async () => {
  await new Promise((resolve) => server.listen(3217, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  let checks = 0;
  try {
    for (const width of [320, 390, 768, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      await context.route('**/*', (route) => route.request().url().startsWith('http://127.0.0.1:3217/') ? route.continue() : route.abort());
      const page = await context.newPage(); const errors = []; page.on('pageerror', (error) => errors.push(error.message));
      const origin = '/app/replays?race=Z&q=Sample#archive';
      await page.goto(`http://127.0.0.1:3217${origin}`);
      await page.getByRole('link', { name: 'Open sample replay' }).click();
      await expect(page.getByRole('link', { name: 'Back to Replays' })).toHaveAttribute('href', origin); checks++;
      await expect(page).toHaveTitle(/Defeat.*ZvT on Sanctuary III LE.*SC2 Tools/);
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: `../../docs/handoff/screenshots/game-navigation-header-${width}.png`, fullPage: false });
      const nav = page.getByRole('navigation', { name: 'Move between games' });
      await expect(nav).toContainText('H2H 3–2 all-time');
      const nextUrl = new URL(await nav.getByRole('link', { name: 'Newer ›' }).getAttribute('href'), 'https://fixture.test');
      if (nextUrl.searchParams.get('from') !== origin) throw new Error('Lost source filters'); checks++;
      await nav.getByRole('combobox').selectOption('matchup');
      await page.getByRole('link', { name: 'Back to Replays' }).click();
      await expect(page).toHaveURL(`http://127.0.0.1:3217${origin}`); checks++;
      await page.getByRole('link', { name: 'Open sample replay' }).click();
      await expect(page.getByRole('combobox', { name: 'Games to step through' })).toHaveValue('matchup'); checks++;
      const stage = page.getByTestId('replay-stage'); await stage.scrollIntoViewIfNeeded(); await stage.focus();
      await page.keyboard.press('5'); await expect(stage.getByLabel('Game clock 5:00 of 10:00')).toBeVisible();
      await page.keyboard.press('j'); await expect(stage.getByLabel('Game clock 4:50 of 10:00')).toBeVisible();
      await page.keyboard.press('Shift+ArrowRight'); await expect(stage.getByLabel('Game clock 4:55 of 10:00')).toBeVisible(); checks++;
      await page.keyboard.press('Home'); await page.keyboard.press('l'); await expect(stage.getByLabel('Game clock 0:10 of 10:00')).toBeVisible(); checks++;
      const slider = stage.getByRole('slider', { name: 'Playback position' }); await slider.focus(); await page.keyboard.press('l');
      await expect(stage.getByLabel('Game clock 0:10 of 10:00')).toBeVisible(); checks++;
      await stage.focus(); for (let i = 0; i < 8; i++) await page.keyboard.press('[');
      await expect(stage.getByRole('button', { name: /Playback speed/ })).toHaveText('0.25×'); checks++;
      await page.keyboard.press('?'); await expect(page.getByRole('dialog', { name: 'Replay keyboard shortcuts' })).toBeVisible();
      await page.keyboard.press('Escape'); await expect(stage).toBeFocused(); checks++;
      const play = stage.getByRole('button', { name: 'Play', exact: true }); await play.focus(); await page.keyboard.press('Space');
      await expect(stage.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
      await page.keyboard.press('Space'); await expect(stage.getByRole('button', { name: 'Play', exact: true })).toBeVisible(); checks++;
      await stage.getByRole('button', { name: 'Replay display settings' }).click(); await page.keyboard.press('Escape');
      await expect(stage.getByRole('button', { name: 'Replay display settings' })).toHaveAttribute('aria-expanded', 'false'); checks++;
      if (width < 768) {
        await stage.getByRole('button', { name: /Show production & build order/ }).click();
        await stage.getByRole('tab', { name: 'Build order', exact: true }).click();
      }
      await page.reload(); await expect(stage.getByRole('button', { name: /Playback speed/ })).toHaveText('0.25×');
      if (width < 768) await expect(stage.getByRole('tab', { name: 'Build order', exact: true })).toHaveAttribute('aria-selected', 'true'); checks++;
      await stage.scrollIntoViewIfNeeded();
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`Overflow at ${width}`);
      await page.screenshot({ path: `../../docs/handoff/screenshots/game-navigation-${width}.png`, fullPage: false }); checks++;
      if (width === 1440) {
        await stage.focus(); await page.keyboard.press('f');
        if (await page.evaluate(() => document.fullscreenEnabled)) {
          await expect.poll(() => page.evaluate(() => !!document.fullscreenElement?.hasAttribute('data-replay-stage'))).toBe(true);
          await page.keyboard.press('?'); await expect(page.getByRole('dialog', { name: 'Replay keyboard shortcuts' })).toBeVisible();
          await page.keyboard.press('Escape'); await page.evaluate(() => document.fullscreenElement ? document.exitFullscreen() : undefined); checks++;
        }
        await page.keyboard.press('Alt+ArrowRight'); await expect(page).toHaveURL(/\/app\/game\/newer\?/); checks++;
      }
      if (errors.length) throw new Error(JSON.stringify(errors));
      console.log(JSON.stringify({ width, checks, errors })); await context.close();
    }
    console.log(`${checks} browser checks passed`);
  } finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
})().catch((error) => { console.error(error); process.exitCode = 1; server.close(); });
