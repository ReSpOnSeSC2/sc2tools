/* Reproducible auth return matrix. Every request stays on loopback; no Clerk
 * account, real preference write, provider operation or engine parse occurs. */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
process.chdir(path.resolve(__dirname, '../..'));
const { chromium, expect } = require('@playwright/test');
const origin = 'http://127.0.0.1:3261', writes = [], unexpected = [];
const shots = process.env.AUTH_SHOTS_DIR || '.cache/auth-return-shots';
let saved = [], vote = 0, config = { v: 2, revision: 0, slots: {} };
const css = fs.readdirSync('.next/static/css', { recursive: true }).filter(n => n.endsWith('.css')).map(n => fs.readFileSync(path.join('.next/static/css', n), 'utf8')).join('\n');
const fonts = `@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay;--font-serif:serif}`;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, origin), p = url.pathname;
  const json = (data, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)); };
  if (p.startsWith('/v1/')) {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    if (req.method !== 'GET') {
      writes.push({ path: p, method: req.method, body });
      if (req.headers.authorization !== 'Bearer synthetic-local-token') { unexpected.push('unauthed-write:' + p); return json({}, 401); }
    }
    if (p === '/v1/me/preferences/ghost') {
      if (req.method === 'GET') return json(config);
      if (req.method === 'PATCH') { config = { v: 2, revision: config.revision + 1, slots: { ...config.slots, [body.matchup]: body.target } }; return json(config); }
    }
    if (p === '/v1/community/builds/blink/my-vote') return json({ votes: 3 + vote, myVote: vote });
    if (p === '/v1/community/builds/blink/vote' && req.method === 'POST') { vote = body.delta; return json({ votes: 3 + vote, myVote: vote }); }
    if (p === '/v1/custom-builds') return json({ items: saved, total: saved.length });
    if (p.startsWith('/v1/custom-builds/') && req.method === 'PUT') { saved.push({ slug: body.slug, forkedFrom: body.forkedFrom }); return json({ ok: true }); }
    if (p === '/v1/me') return json({ userId: 'synthetic-owner', games: { total: 0 }, onboarding: { goals: ['improve'] }, agentPaired: false });
    if (p === '/v1/coaching/me') return json({ role: 'none' });
    if (p === '/v1/site/banner') return json({ banner: null });
    if (p.endsWith('/unread-count')) return json({ count: 0 });
    if (p === '/v1/me/import-status') return json({ job: null });
    if (p === '/v1/me/preferences/onboarding' && req.method === 'PUT') return json({ ok: true });
    if (req.method !== 'GET') unexpected.push(p);
    return json({});
  }
  if (p === '/fixture.js') { res.setHeader('content-type', 'text/javascript'); return res.end(fs.readFileSync('.tmp/auth-return-fixture.js')); }
  if (p.startsWith('/fonts/')) { res.setHeader('content-type', 'font/woff2'); return res.end(fs.readFileSync(path.join('app', p))); }
  const assets = path.resolve('public'), asset = path.resolve(assets, '.' + p);
  if (asset.startsWith(assets + path.sep) && fs.existsSync(asset) && fs.statSync(asset).isFile()) { res.setHeader('content-type', ({ '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png' })[path.extname(asset)] || 'application/octet-stream'); return res.end(fs.readFileSync(asset)); }
  res.setHeader('content-type', 'text/html;charset=utf-8');
  const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
  res.end(`<!doctype html><html lang="en" data-theme="${theme}" data-theme-mode="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script>try{const mode=localStorage.getItem('sc2tools.theme');if(mode==='light'||mode==='dark'){document.documentElement.dataset.theme=mode;document.documentElement.dataset.themeMode=mode;}}catch{}</script><style>${css}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
});
(async () => {
  await require('./auth-return-fixture.cjs')(origin);
  await new Promise(resolve => server.listen(3261, '127.0.0.1', resolve));
  let browser; let checks = 0;
  fs.mkdirSync(shots, { recursive: true });
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PW_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PW_CHROMIUM_EXECUTABLE } : {}) });
    for (const width of [320, 390, 768, 1440]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      await context.route('**/*', route => {
        if (route.request().url().startsWith(origin + '/')) return route.continue();
        unexpected.push(route.request().method() + ' ' + route.request().url()); return route.abort();
      });
      await context.addInitScript(theme => { localStorage.setItem('sc2tools.theme', theme); }, theme);
      const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
      const go = async href => {
        await page.goto(origin + href); await page.evaluate(() => document.fonts.ready);
        await page.getByRole('banner').waitFor();
        await expect(page.locator('html')).toHaveAttribute('data-theme-mode', theme);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        expect(await page.evaluate(() => localStorage.getItem('sc2tools.theme'))).toBe(theme);
        expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()))
          .toBe(theme === 'light' ? '244 246 250' : '6 9 14');
      };
      const complete = async () => { await page.getByRole('button', { name: 'Complete fixture authentication' }).click(); };
      saved = []; vote = 0; config = { v: 2, revision: 0, slots: {} };
      const detail = `/community/builds/blink?theme=${theme}`;
      await go(detail);
      if (width < 1024) {
        await page.getByRole('button', { name: 'Open menu', exact: true }).click();
        await page.getByRole('dialog', { name: 'Site navigation' }).getByRole('link', { name: 'Sign in', exact: true }).click();
      } else await page.getByRole('banner').getByRole('link', { name: 'Sign in', exact: true }).click();
      await expect(page.getByTestId('forced-destination')).toHaveText(detail); checks++;
      await complete(); await expect(page.getByRole('heading', { name: 'Public Blink opening', exact: true })).toBeVisible(); checks++;
      // New-account Save crosses actual sign-up -> welcome -> original action.
      await go(detail); const beforeSave = writes.length;
      await page.getByRole('link', { name: /Create.*account.*save|Sign up.*save/i }).click();
      await expect(page.getByTestId('forced-destination')).toHaveText('/welcome?next=%2Fcommunity%2Fbuilds%2Fblink');
      await complete(); await expect(page.getByText(/Continue where you left off:/)).toBeVisible(); checks += 2;
      await page.screenshot({ path: `${shots}/auth-return-welcome-${theme}-${width}.png` });
      await page.getByRole('button', { name: /Skip/ }).click();
      await expect(page.getByRole('link', { name: /In your library.*Open/ })).toBeVisible();
      expect(writes.slice(beforeSave).filter(w => w.path.startsWith('/v1/custom-builds/'))).toHaveLength(1); checks += 2;
      await go(detail); const beforeVote = writes.length;
      await page.getByRole('link', { name: 'Sign in to downvote' }).first().click(); await complete();
      await expect(page.getByRole('button', { name: 'Downvote', exact: true }).first()).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByRole('button', { name: 'Downvote', exact: true }).last()).toHaveAttribute('aria-pressed', 'true');
      expect(writes.slice(beforeVote).filter(w => w.path.endsWith('/vote'))).toHaveLength(1); checks += 3;
      await page.screenshot({ path: `${shots}/auth-return-vote-${theme}-${width}.png` });
      await go(detail); const beforePractice = writes.length;
      await page.getByRole('button', { name: 'Practice in PvT', exact: true }).first().click(); await complete();
      await expect(page.getByRole('heading', { name: 'Ghost settings', exact: true })).toBeVisible();
      await expect(page.getByText('Practice assignment saved. Your Ghost URL updates automatically.')).toBeVisible();
      expect(page.url()).toBe(origin + '/settings?tab=overlay#ghost');
      expect(writes.slice(beforePractice).filter(w => w.path.endsWith('/preferences/ghost'))).toHaveLength(1); checks += 4;
      await go('/sign-in?redirect_url=' + encodeURIComponent('//outside.invalid/')); await expect(page.getByTestId('forced-destination')).toHaveText('/app'); checks++;
      await go('/sign-up?redirect_url=' + encodeURIComponent('/guides/pvt/blink?compare=1')); await complete();
      await expect(page.getByText(/Continue where you left off:/)).toBeVisible();
      await page.evaluate(() => { const p = new URL(location.href); p.searchParams.set('step', 'done'); history.replaceState({}, '', p); dispatchEvent(new Event('fixture-nav')); });
      const continuation = page.getByRole('link', { name: /Continue where you left off/ });
      await expect(continuation).toHaveAttribute('href', '/guides/pvt/blink?compare=1'); checks += 2;
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); checks++;
      expect(errors).toEqual([]); checks++;
      console.log(`auth return ${width} ${theme}: ${checks} cumulative checks`);
      await context.close();
    }
    expect(unexpected).toEqual([]);
    console.log(JSON.stringify({ checks: checks + 1, contexts: 8, captures: 16, syntheticWrites: writes.length, unexpected }));
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
