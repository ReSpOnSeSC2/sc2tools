/* All traffic is disposable loopback. The worker parses the real repository
 * replay fixture; no API/provider/account/installer is contacted. */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process'), { chromium, expect } = require('@playwright/test');
const root = process.cwd(), shots = '../../docs/handoff/screenshots', api = [], external = [], pageErrors = [];
const replay = path.resolve('../replay-engine/tests/fixtures/replays/warpgate_adept_tracking.SC2Replay');
const cssNames = fs.readdirSync('.next/static/css', { recursive: true }).filter(name => name.endsWith('.css'));
const css = cssNames.map(name => fs.readFileSync(path.join('.next/static/css', name), 'utf8')).join('\n');
const fonts = `@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay}`;
let origin, checks = 0, captures = 0;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, origin || 'http://127.0.0.1'), p = url.pathname;
  if (p.startsWith('/v1/')) {
    api.push({ method: req.method, path: p });
    if (p === '/v1/public/preview-replay') {
      for await (const _chunk of req) { /* Local legacy compatibility fixture only. */ }
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ ok: true, game_id: 'legacy-local', map: 'Synthetic map', duration_sec: 600, date: '2020-01-01', players: [
        { name: 'Synthetic Alpha', race: 'Protoss', result: 'Win', handle: '1-S2-1-1', build_log: ['[0:18] Pylon'] }, { name: 'Synthetic Beta', race: 'Zerg', result: 'Loss', handle: '1-S2-1-2', build_log: ['[0:20] Hatchery'] },
      ] }));
    }
    res.statusCode = 404; return res.end('{}');
  }
  if (p === '/fixture.js' || p === '/fixture-worker.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync(p === '/fixture.js' ? '.tmp/landing-demo-fixture.js' : '.tmp/landing-demo-worker.js')); }
  if (p === '/fixture' || p === '/try') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(`<!doctype html><html lang="en" data-theme="${url.searchParams.get('theme') === 'dark' ? 'dark' : 'light'}"><head><title>Local landing browser demo proof</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`); }
  const base = p.startsWith('/fonts/') ? path.join(root, 'app/fonts') : path.join(root, 'public'), file = path.resolve(base, p.startsWith('/fonts/') ? p.slice(7) : p.slice(1));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', ({ '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
});
async function check(value) { expect(await value).toBe(true); checks++; }
async function capture(page, name, target) { await target.scrollIntoViewIfNeeded(); await page.evaluate(() => document.fonts.ready); await check(target.evaluate(node => { const r = node.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; })); await page.screenshot({ path: `${shots}/landing-demo-${name}.png` }); captures++; }
async function noOverflow(page) { await check(page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); }
async function target44(locator) { const r = await locator.boundingBox(); expect(r && r.width >= 44 && r.height >= 44).toBeTruthy(); checks++; }
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  execFileSync(process.execPath, ['tests/manual/landing-demo-fixture.cjs'], { cwd: root, env: { ...process.env, LANDING_DEMO_FIXTURE_ORIGIN: origin }, stdio: 'pipe' });
  const browser = await chromium.launch({ headless: true, args: ['--proxy-server=direct://', '--proxy-bypass-list=*'] });
  try {
    for (const width of [320, 390, 768, 1440]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce', hasTouch: width < 768 });
      await context.route('**/*', route => { const u = new URL(route.request().url()); if (u.origin !== origin) { external.push(u.origin); return route.abort(); } return route.continue(); });
      const page = await context.newPage(), engine = []; page.on('pageerror', error => pageErrors.push(error.message)); context.on('request', req => { if (/\/(engine|pyodide)\//.test(new URL(req.url()).pathname)) engine.push(req.url()); });
      const startApi = api.length;
      await page.goto(`${origin}/fixture?theme=${theme}&mode=all`); const choose = page.getByRole('button', { name: 'Choose a replay', exact: true }); await expect(choose).toBeVisible(); checks++;
      await page.waitForTimeout(150); expect(engine).toHaveLength(0); checks++;
      await target44(choose); await noOverflow(page); await capture(page, `card-${theme}-${width}`, choose);
      await choose.focus(); await expect.poll(() => engine.length, { timeout: 30_000 }).toBeGreaterThan(0); checks++;
      await page.getByLabel('Replay for the build editor demo').setInputFiles(replay);
      await expect(page.getByRole('heading', { name: 'Which player are you?' })).toBeVisible({ timeout: 120_000 }); checks++;
      await target44(page.getByRole('button', { name: /ReSpOnSe.*Protoss/ })); await capture(page, `chooser-${theme}-${width}`, page.getByRole('heading', { name: 'Which player are you?' }));
      await page.getByRole('button', { name: /ReSpOnSe.*Protoss/ }).click();
      let editor = page.getByRole('dialog', { name: /Save as new build/ }); await expect(editor).toBeVisible({ timeout: 120_000 }); checks++;
      await expect(editor.getByText(/Pylon/).first()).toBeVisible(); checks++;
      await noOverflow(page); await capture(page, `editor-${theme}-${width}`, editor);
      await editor.getByRole('button', { name: 'Close', exact: true }).last().click();
      const other = page.getByRole('button', { name: /· Zerg/ }); await target44(other);
      await other.click(); editor = page.getByRole('dialog', { name: /Save as new build/ }); await expect(editor.getByText(/Hatchery|Spawning Pool|SpawningPool/).first()).toBeVisible(); checks++;
      await capture(page, `opponent-${theme}-${width}`, editor);
      expect(api.length - startApi).toBe(0); checks++;
      await editor.getByRole('button', { name: 'Close', exact: true }).last().click(); await expect(editor).toBeHidden(); checks++;
      const how = page.getByRole('link', { name: 'How this works' }); await how.click(); await expect(page.getByRole('heading', { name: 'Can I try it with one replay from the home page?' })).toBeVisible(); checks++;
      await context.close();
      if ([320, 1440].includes(width)) {
        const unsupported = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme });
        await unsupported.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        await unsupported.addInitScript(() => { window.Worker = undefined; });
        const p = await unsupported.newPage(); await p.goto(`${origin}/fixture?theme=${theme}&mode=all`); const before = api.length;
        await p.getByLabel('Replay for the build editor demo').setInputFiles(replay); await expect(p.getByText('This browser cannot run the replay analyzer.')).toBeVisible(); checks++;
        await expect(p.getByRole('link', { name: 'use the desktop app' })).toHaveAttribute('href', '/download'); checks++;
        await noOverflow(p); await capture(p, `unsupported-${theme}-${width}`, p.getByRole('dialog')); expect(api.length).toBe(before); checks++; await unsupported.close();
      }
    }
    for (const mode of ['off', 'admins']) {
      const page = await browser.newPage({ viewport: { width: 390, height: 1000 } }); await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await page.goto(`${origin}/fixture?mode=${mode}`); const before = api.length;
      await page.getByLabel('Replay for the build editor demo').setInputFiles(replay); await expect(page.getByRole('dialog', { name: /Save as new build/ })).toBeVisible(); checks++;
      expect(api.length - before).toBe(1); checks++; await expect(page.getByText('Uploaded once to our server, parsed, then deleted.')).toBeAttached(); checks++; await page.close();
    }
    expect(pageErrors).toEqual([]); expect(external).toEqual([]); checks += 2;
    console.log(JSON.stringify({ checks, captures, widths: [320, 390, 768, 1440], themes: ['light', 'dark'], productionCss: cssNames, browserApiRequests: 0, compatibilityApiRequests: api.length, externalRequests: external.length, boundary: 'Real demo/editor/session and real worker/fixture replay; local Next/Clerk/analytics/Worker URL adapter. API synthetic only for explicit off/admins compatibility.' }, null, 2));
  } finally { await browser.close(); server.close(); }
}
main().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
