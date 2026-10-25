/* Real Dock controls and layout, production Tailwind/fonts + source CSS module.
 * No provider connections, speech, database or non-loopback traffic.
 */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process'), { chromium, expect } = require('@playwright/test');
const axe = require('axe-core');
execFileSync(process.execPath, ['tests/manual/dock-polish-fixture.cjs'], { stdio: 'inherit' });
const root = process.cwd(), origin = 'http://127.0.0.1:3255', shots = '../../docs/handoff/screenshots';
fs.mkdirSync(shots, { recursive: true });
const cssFiles = fs.readdirSync('.next/static/css').filter(name => name.endsWith('.css'));
const css = cssFiles.map(name => fs.readFileSync(path.join('.next/static/css', name), 'utf8')).join('\n') + fs.readFileSync('.tmp/dock-polish-fixture.css', 'utf8');
const fonts = `@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay}`;
const initialStudio = () => ({ highlight: { platform: 'twitch', user: 'Aurora', text: 'That was a clean hold!', atMs: Date.now() }, poll: null, goals: [{ id: 'one', label: 'Games today', current: 3, target: 10 }, { id: 'two', label: 'Community games', current: 1, target: 3 }], blockedUsers: [], scene: { mode: 'brb', message: 'Back after a short break', countdownEndsAt: Date.now() + 300000, setAtMs: Date.now() }, timer: { label: 'Next game', endsAt: Date.now() + 360000 }, streamStartMs: Date.now() - 600000, vodUrl: null, broll: { clips: [{ id: 'first', title: 'Hold the natural', videoId: 'abcDEF_1234', startSeconds: 30, endSeconds: 60 }], shuffle: false, muted: true, volume: 50, skipNonce: 0 }, updatedAt: new Date().toISOString() });
let studio = initialStudio(), checks = 0; const calls = [], unexpected = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, origin), pathname = url.pathname;
  const json = (data, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
  if (pathname.startsWith('/v1/')) {
    calls.push({ method: req.method, path: pathname });
    if (pathname.endsWith('/studio')) {
      if (req.method === 'POST') { const chunks = []; for await (const chunk of req) chunks.push(chunk); studio = { ...studio, ...JSON.parse(Buffer.concat(chunks)), updatedAt: new Date().toISOString() }; }
      return json(studio);
    }
    if (pathname.endsWith('/config')) return json({ config: { twitch: { enabled: true, channel: 'synthetic' }, kick: { enabled: true, chatroomId: 'fixture' }, youtube: { enabled: true, channel: 'synthetic' } } });
    if (pathname.endsWith('/engagement')) return json({ clipMoments: [{ atMs: Date.now() - 50000, kind: 'game-event', reason: 'Victory — a held counterattack', sampleLines: [] }, { atMs: Date.now() - 10000, kind: 'chat-spike', reason: 'Chat celebrated the hold', sampleLines: ['Aurora: well played'] }] });
    if (pathname.endsWith('/viewers')) return json({ platforms: [{ platform: 'twitch', viewers: 24, live: true }, { platform: 'kick', viewers: null, live: true }], total: 24, partial: true });
    if (pathname.endsWith('/presence')) return json({ sources: 1, widgets: 3, docks: 1, duplicates: 0 });
    if (pathname.endsWith('/builds')) return json({ builds: [] });
    // Synthetic engagement intake only; no actual provider/server actions.
    if (req.method === 'POST' && pathname.includes('/ingest')) return json({ ok: true });
    unexpected.push({ method: req.method, path: pathname }); return json({}, 404);
  }
  if (pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync('.tmp/dock-polish-fixture.js')); }
  if (pathname.startsWith('/dock/')) {
    const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(`<!doctype html><html lang="en" data-theme="${theme}"><head><title>Local Dock fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  }
  const base = pathname.startsWith('/fonts/') ? path.join(root, 'app/fonts') : path.join(root, 'public'), file = path.resolve(base, pathname.startsWith('/fonts/') ? pathname.slice(7) : pathname.slice(1));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', ({ '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
});
const hit = locator => locator.evaluate(node => { const box = node.getBoundingClientRect(), target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2); return { hit: !!target && (node === target || node.contains(target)), height: box.height, width: box.width }; });
(async () => {
  await new Promise(resolve => server.listen(3255, '127.0.0.1', resolve)); const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [300, 320, 390, 768, 1440]) for (const theme of ['light', 'dark']) {
      studio = initialStudio(); calls.length = 0; unexpected.length = 0;
      const coarse = width < 1000, context = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion: 'reduce', hasTouch: coarse, isMobile: coarse });
      await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Synthetic OBS clipboard denial'); } } });
        Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { getVoices: () => [], addEventListener() {}, removeEventListener() {}, cancel() {}, speak() { throw new Error('Speech is blocked in fixture'); } } });
      });
      const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/dock/synthetic-dock-local?theme=${theme}`); await expect(page.getByText('Twitch · connected')).toBeVisible(); await expect(page.getByPlaceholder('Poll question')).toBeVisible(); checks += 2;
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); checks++;
      await page.screenshot({ path: `${shots}/dock-polish-open-${theme}-${width}.png` });
      await page.getByRole('button', { name: /Actions for message from Aurora:/ }).click();
      for (const name of ['Highlight message from Aurora', 'Block Aurora']) { const control = page.getByRole('button', { name, exact: true }); await control.scrollIntoViewIfNeeded(); const target = await hit(control); expect(target.hit).toBe(true); expect(target.height).toBeGreaterThanOrEqual(coarse ? 40 : 28); expect(target.width).toBeGreaterThanOrEqual(40); checks++; }
      for (const control of [page.getByRole('spinbutton', { name: 'Timer minutes', exact: true }), page.getByRole('combobox', { name: 'Aggressiveness', exact: true })]) { await control.scrollIntoViewIfNeeded(); const target = await hit(control); expect(target.hit).toBe(true); expect(target.height).toBeGreaterThanOrEqual(coarse ? 40 : 28); expect(target.width).toBeGreaterThanOrEqual(40); checks++; }
      await page.getByPlaceholder('Poll question').fill('Which opening next?');
      const fold = page.getByRole('button', { name: 'Poll', exact: true, expanded: true }); await fold.scrollIntoViewIfNeeded(); const target = await hit(fold); expect(target.hit).toBe(true); expect(target.height).toBeGreaterThanOrEqual(coarse ? 40 : 28); checks++;
      await fold.click(); await expect(page.getByPlaceholder('Poll question')).toBeHidden();
      await page.getByRole('button', { name: 'Pin Poll to top', exact: true }).click(); await expect(page.locator('[data-dock-section]').first()).toHaveAttribute('id', 'dock-poll'); checks++;
      if (width < 1000) { await page.getByRole('navigation', { name: 'Dock sections' }).getByRole('button', { name: 'Poll', exact: true }).click(); await expect(page.locator('#dock-poll-toggle')).toBeFocused(); }
      else await page.getByRole('button', { name: 'Poll · No poll', expanded: false }).click();
      await expect(page.getByPlaceholder('Poll question')).toHaveValue('Which opening next?'); checks++;
      await page.locator('#dock-poll-toggle').focus(); await page.keyboard.press('Enter'); await expect(page.locator('#dock-poll-toggle')).toHaveAttribute('aria-expanded', 'false'); await page.keyboard.press('Enter'); await expect(page.locator('#dock-poll-toggle')).toHaveAttribute('aria-expanded', 'true'); checks++;
      await page.getByRole('button', { name: 'Reset layout' }).click(); await expect(page.locator('[data-dock-section]').first()).toHaveAttribute('id', 'dock-chat'); await expect(page.getByPlaceholder('Poll question')).toHaveValue('Which opening next?'); checks++;
      await page.getByRole('button', { name: 'Scenes', exact: true, expanded: true }).click(); await expect(page.getByRole('button', { name: /Scenes · BRB/, expanded: false })).toBeVisible(); checks++;
      await page.getByRole('button', { name: 'Goals', exact: true, expanded: true }).click(); await expect(page.getByRole('button', { name: 'Goals · 2 active', expanded: false })).toBeVisible(); checks++;
      await page.getByRole('button', { name: 'Clips', exact: true, expanded: true }).click(); await expect(page.getByRole('button', { name: 'Clips · 2 moments', expanded: false })).toBeVisible(); checks++;
      await page.reload(); await expect(page.getByRole('button', { name: 'Goals · 2 active', expanded: false })).toBeVisible(); checks++;
      const expanded = await page.locator('[data-dock-section] button[aria-expanded="true"]').evaluateAll(nodes => nodes.map(node => node.id).filter(Boolean));
      for (const id of expanded) await page.locator(`#${id}`).click();
      await expect(page.locator('[data-dock-section] button[id$="-toggle"][aria-expanded="false"]')).toHaveCount(9); checks++;
      await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: `${shots}/dock-polish-folded-${theme}-${width}.png` });
      for (const id of expanded) await page.locator(`#${id}`).click();
      await page.getByRole('button', { name: 'Copy dock URL', exact: true }).click(); const urlField = page.getByRole('textbox', { name: 'Copy dock URL manually' }); await expect(urlField).toHaveValue(page.url()); await expect(urlField).toBeFocused(); expect(await urlField.evaluate(node => node.selectionEnd === node.value.length)).toBe(true); checks++;
      await page.getByRole('button', { name: 'Hide copy field', exact: true }).click();
      await page.getByRole('button', { name: 'Clips · 2 moments', expanded: false }).click(); await page.getByRole('button', { name: 'Copy timestamps', exact: true }).click(); const timestamps = page.getByRole('textbox', { name: 'Copy timestamps manually' }); await expect(timestamps).toBeFocused(); expect((await timestamps.inputValue()).split('\n')).toHaveLength(2); checks++;
      if (width === 300 && theme === 'dark' || width === 1440 && theme === 'light') await page.screenshot({ path: `${shots}/dock-polish-copy-${theme}-${width}.png` });
      await page.getByRole('button', { name: 'Hide copy field', exact: true }).click();
      await page.getByRole('button', { name: /Scenes · BRB/, expanded: false }).click(); await expect(page.getByPlaceholder('YouTube URL or video ID')).toHaveCount(0); await page.getByRole('button', { name: 'Manage b-roll', expanded: false }).click(); const video = page.getByPlaceholder('YouTube URL or video ID'); await expect(video).toBeVisible(); await video.fill('abcDEF_1234'); checks++;
      await page.getByRole('button', { name: 'Manage b-roll', expanded: true }).click(); await page.getByRole('button', { name: 'Manage b-roll', expanded: false }).click(); await expect(video).toHaveValue('abcDEF_1234'); checks++;
      await page.getByRole('button', { name: 'Build vote', exact: true }).click(); await expect(page.getByText(/No saved builds yet/)).toBeVisible(); checks++;
      await page.addScriptTag({ content: axe.source }); const violations = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map(issue => ({ id: issue.id, nodes: issue.nodes.map(node => node.target) }))); expect(violations).toEqual([]); checks++;
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]); expect(unexpected).toEqual([]); expect(calls.filter(call => call.method === 'POST' && call.path.endsWith('/studio'))).toHaveLength(0); checks += 4;
      console.log(JSON.stringify({ width, theme, coarse, checks })); await context.close();
    }
    console.log(JSON.stringify({ checks, cssFiles, captures: 22 }));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
