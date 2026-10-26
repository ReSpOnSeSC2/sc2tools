/* Run after a production CSS build: node tests/manual/status-page.cjs
 * Only loopback synthetic public probes; no real accounts or deployments. */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium, expect } = require('@playwright/test');
const { compileStatusFixture } = require('./status-page-fixture.cjs');
const root = path.resolve(__dirname, '../..'), origin = 'http://127.0.0.1:3273';
const shots = process.env.STATUS_SHOTS_DIR || path.resolve(root, '../../.cache/status-page-screenshots');
const css = fs.readdirSync(path.join(root, '.next/static/css'), { recursive: true }).filter(name => name.endsWith('.css')).map(name => fs.readFileSync(path.join(root, '.next/static/css', name), 'utf8')).join('\n');
const fonts = `@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:600 800}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay}`;
let javascript = '', mode = 'hold', checks = 0;
const held = [], probes = [], external = [], errors = [], writes = [];
function json(res, body, status = 200) { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); }
const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin);
  if (req.method !== 'GET') { writes.push(req.method + ' ' + url.pathname); res.statusCode = 405; return res.end(); }
  if (['/api/ping', '/v1/ping'].includes(url.pathname)) {
    probes.push({ path: url.pathname, authorization: req.headers.authorization, cookie: req.headers.cookie });
    if (mode === 'hold') return held.push(res);
    if (mode === 'network') return req.socket.destroy();
    if (mode === 'error' || (mode === 'mixed' && url.pathname === '/v1/ping')) return json(res, { status: 'degraded' }, 503);
    return json(res, mode === 'unexpected' ? { message: 'Unexpected synthetic payload' } : { status: 'ok' });
  }
  if (url.pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(javascript); }
  if (url.pathname.startsWith('/fonts/')) { res.setHeader('Content-Type', 'font/woff2'); return fs.createReadStream(path.join(root, 'app/fonts', path.basename(url.pathname))).pipe(res); }
  if (url.pathname === '/status') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(`<!doctype html><html lang="en" data-theme="${url.searchParams.get('theme') === 'light' ? 'light' : 'dark'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>SC2 Tools status · synthetic component proof</title><style>${css}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  }
  res.statusCode = 404; res.end();
});
async function check(assertion) { await assertion(); checks++; }

(async () => {
  javascript = await compileStatusFixture(origin);
  fs.mkdirSync(shots, { recursive: true });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(3273, '127.0.0.1', resolve); });
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [320, 390, 768, 1440]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 850 }, reducedMotion: 'reduce' });
      await context.addCookies([{ name: 'synthetic-account-cookie', value: 'must-not-reach-probes', url: origin }]);
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await context.route('**/*', route => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        external.push(route.request().url()); return route.abort();
      });
      mode = 'hold'; const before = probes.length;
      await page.goto(`${origin}/status?theme=${theme}`);
      await check(() => expect(page.getByText('Checking…', { exact: true })).toHaveCount(2));
      await check(() => expect(page.getByRole('button', { name: 'Refresh checks' })).toBeDisabled());
      await page.evaluate(() => document.fonts.ready);
      await expect.poll(() => held.length).toBe(2);
      mode = 'ok'; while (held.length) json(held.shift(), { status: 'ok' });
      await check(() => expect(page.getByText('Reachable', { exact: true })).toHaveCount(2));
      await check(() => expect(page.locator('time')).toHaveCount(2));
      await check(async () => expect(await page.locator('time').evaluateAll(nodes => nodes.every(node => Number.isFinite(Date.parse(node.dateTime)) && node.textContent.trim()))).toBe(true));
      const initialRequests = probes.length;
      await page.evaluate(() => { dispatchEvent(new Event('focus')); dispatchEvent(new Event('online')); });
      await page.waitForTimeout(100);
      await check(() => expect(probes.length - before).toBe(2));
      await check(() => expect(probes.length).toBe(initialRequests));
      await check(async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true));
      await check(async () => expect(await page.getByRole('button', { name: 'Refresh checks' }).evaluate(node => { const box = node.getBoundingClientRect(); return box.width >= 44 && box.height >= 44; })).toBe(true));
      await page.getByRole('button', { name: 'Refresh checks' }).focus();
      await page.keyboard.press('Tab');
      await check(() => expect(page.getByRole('link', { name: 'Open SC2 Tools' })).toBeFocused());
      await page.keyboard.press('Tab');
      await check(() => expect(page.getByRole('link', { name: 'Help', exact: true })).toBeFocused());
      await page.screenshot({ path: path.join(shots, `status-${theme}-${width}.png`), fullPage: true });

      mode = 'mixed'; await page.getByRole('button', { name: 'Refresh checks' }).focus(); await page.keyboard.press('Enter');
      await check(() => expect(page.getByRole('region', { name: 'Website', exact: true }).getByText('Reachable', { exact: true })).toBeVisible());
      await check(() => expect(page.getByRole('region', { name: 'API', exact: true }).getByText('Unavailable', { exact: true })).toBeVisible());
      await check(() => expect(page.getByText('The service responded with HTTP 503. Try again shortly.')).toBeVisible());
      await check(async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true));
      if (width === 390) await page.screenshot({ path: path.join(shots, `status-partial-${theme}-${width}.png`), fullPage: true });
      mode = 'unexpected'; await page.getByRole('button', { name: 'Refresh checks' }).click();
      await check(() => expect(page.getByText('Unknown', { exact: true })).toHaveCount(2));
      await check(() => expect(page.getByText(/returned an unexpected response/)).toHaveCount(2));
      await check(async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true));
      mode = 'network'; await page.getByRole('button', { name: 'Refresh checks' }).click();
      await check(() => expect(page.getByText(/browser access rules/)).toHaveCount(2));
      await check(() => expect(page.getByText('Unknown', { exact: true })).toHaveCount(2));
      await check(async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true));
      await context.close(); console.log(JSON.stringify({ width, theme, checks }));
    }
    await check(() => expect(probes.every(probe => !probe.authorization && !probe.cookie)).toBe(true));
    await check(() => expect(writes).toEqual([]));
    await check(() => expect(external).toEqual([]));
    await check(() => expect(errors).toEqual([]));
    console.log(JSON.stringify({ checks, screenshots: shots, probes: probes.length, writes: 0, externalTraffic: 'blocked' }));
  } finally {
    while (held.length) held.shift().destroy();
    await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.closeAllConnections(); server.close(); process.exitCode = 1; });
