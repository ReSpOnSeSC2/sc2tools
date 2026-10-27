/* Run from apps/web after its own production build. Requires an unused absolute
 * REFERENCE_SAVE_ARTIFACTS directory; all writes and requests stay disposable. */
const fs = require('node:fs');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');
const axe = require('axe-core');
const { prepareReferenceSaveFixture, GAME_ID, OWNER } = require('./reference-save-regression-fixture.cjs');

const CHROME = 'C:\\Users\\jay19\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe';
const artifacts = process.env.REFERENCE_SAVE_ARTIFACTS;
if (!artifacts || !path.isAbsolute(artifacts) || fs.existsSync(artifacts)) throw new Error('Set REFERENCE_SAVE_ARTIFACTS to a new absolute directory');
fs.mkdirSync(artifacts, { recursive: true });
const summary = { result: 'RUNNING', cases: [], aa: [], external: [], errors: [], console: [], failures: [], fixture: null, closure: null };
let browser, fixture;
const timeout = setTimeout(() => { summary.errors.push('Overall 6 minute verification deadline exceeded'); void cleanup().finally(() => { process.exitCode = 1; }); }, 360000);
const write = (name, value) => fs.writeFileSync(path.join(artifacts, name), JSON.stringify(value, null, 2), { flag: 'wx' });
async function cleanup() {
  clearTimeout(timeout);
  if (browser) { const current = browser; browser = null; await current.close(); }
  if (fixture) await fixture.close();
  summary.closure = { browserConnected: browser?.isConnected() || false, serverListening: fixture?.listening() || false, sockets: fixture?.state.sockets.size || 0 };
}
async function geometry(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const dialog = page.getByRole('dialog');
  if (await dialog.count()) expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
}
async function capture(page, caseName, phase) {
  await page.evaluate(() => document.fonts.ready);
  await geometry(page);
  const file = `${caseName}-${phase}.png`;
  await page.screenshot({ path: path.join(artifacts, file), fullPage: true });
  await page.addScriptTag({ content: axe.source });
  const result = await page.evaluate(async () => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  write(`${caseName}-${phase}-axe.json`, result);
  summary.aa.push({ caseName, phase, screenshot: file, violations: result.violations.length, incomplete: result.incomplete.length });
  expect(result.violations.map(row => ({ id: row.id, targets: row.nodes.map(node => node.target) }))).toEqual([]);
}
async function observeCase(context, page, caseName) {
  page.setDefaultTimeout(12000); page.setDefaultNavigationTimeout(15000);
  page.on('pageerror', error => summary.errors.push({ caseName, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') summary.console.push({ caseName, text: message.text(), location: message.location() }); });
  page.on('requestfailed', request => summary.failures.push({ caseName, url: request.url(), method: request.method(), failure: request.failure() }));
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === fixture.state.origin) return route.continue();
    summary.external.push({ caseName, url: route.request().url(), method: route.request().method() }); return route.abort();
  });
}
async function openSourceReference(page, caseName, theme) {
    await page.goto(`${fixture.state.origin}/fixture?theme=${theme}&case=${caseName}`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect.poll(() => page.evaluate(() => document.fonts.check('16px FixtureSans') && document.fonts.check('16px FixtureDisplay'))).toBe(true);
    await page.getByRole('button', { name: 'Create source build' }).click();
    const save = page.getByRole('button', { name: 'Save build', exact: true });
    await expect(page.getByText(/no rule checks Gateways/)).toBeVisible();
    await expect(save).toBeEnabled();
    await page.getByRole('button', { name: 'Dismiss this name check' }).click();
    await expect(page.getByText(/no rule checks Gateways/)).toHaveCount(0);
    await expect(save).toBeEnabled();
    await capture(page, caseName, 'before-invalid');
    return save;
}
async function rejectMalformedReference(page, caseName, save) {
    await page.getByRole('tab', { name: 'Build order', exact: true }).click();
    await page.getByRole('textbox', { name: 'Step 1 time' }).fill('7:99');
    await expect(save).toBeDisabled();
    await expect(page.getByRole('alert').filter({ hasText: /Step 1: use a valid m:ss/ })).toBeVisible();
    await page.getByRole('tab', { name: 'Match rules', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: /Build order: Step 1:/ })).toBeVisible();
    await capture(page, caseName, 'invalid');
}
async function reviewReference(page, caseName) {
    // Start at the bottom of the old rules panel. The explicit Review action
    // must reveal its focused tab itself; a later locator.fill() must not hide
    // a failure by scrolling the corrected field into view on the test's behalf.
    const scroller = page.getByRole('dialog').locator(':scope > div.overflow-y-auto');
    const beforeReview = await scroller.evaluate(node => { node.scrollTop = node.scrollHeight; return node.scrollTop; });
    expect(beforeReview).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Review build order' }).click();
    const orderTab = page.getByRole('tab', { name: 'Build order', exact: true });
    await expect(orderTab).toHaveAttribute('aria-selected', 'true');
    await expect(orderTab).toBeFocused();
    const reviewFocus = await orderTab.evaluate(node => {
      const rect = node.getBoundingClientRect(), container = node.closest('[role="dialog"]').querySelector(':scope > div.overflow-y-auto');
      const bounds = container.getBoundingClientRect();
      return { focused: document.activeElement === node, scrollTop: container.scrollTop, tabTop: rect.top, tabBottom: rect.bottom, tabLeft: rect.left, tabRight: rect.right,
        scrollportTop: bounds.top, scrollportBottom: bounds.bottom,
        fullyInScrollport: rect.top >= Math.max(0, bounds.top) - 1 && rect.bottom <= Math.min(innerHeight, bounds.bottom) + 1
          && rect.left >= Math.max(0, bounds.left) - 1 && rect.right <= Math.min(innerWidth, bounds.right) + 1 };
    });
    expect(reviewFocus.focused).toBe(true); expect(reviewFocus.fullyInScrollport).toBe(true);
    write(`${caseName}-review-focus.json`, { beforeReview, ...reviewFocus });
    await capture(page, caseName, 'review-focused');
}
async function repairAndSave(page, caseName, save) {
    await page.getByRole('textbox', { name: 'Step 1 time' }).fill('0:00');
    await expect(save).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Review build order' })).toHaveCount(0);
    await capture(page, caseName, 'corrected');
    await save.click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Saved build', exact: true })).toBeVisible();
    await capture(page, caseName, 'saved');
}
async function readAndReopenSaved(page, context, start) {
    const first = fixture.state.calls.slice(start).filter(call => call.method === 'PUT');
    expect(first).toHaveLength(1); expect(first[0].status).toBe(200);
    expect(first[0].body.reclassify).toBe(false); expect(first[0].body.buildOrder.sourceGameId).toBe(GAME_ID);
    expect(first[0].referenceValid).toBe(true); expect(first[0].customBuildValid).toBe(true);
    const ownerRead = await context.request.get(`${fixture.state.origin}${first[0].path}`, { headers: { authorization: `Bearer ${OWNER}` } });
    expect(ownerRead.status()).toBe(200); expect((await ownerRead.json()).buildOrder.sourceGameId).toBe(GAME_ID);
    const foreignRead = await context.request.get(`${fixture.state.origin}${first[0].path}`, { headers: { authorization: 'Bearer synthetic-b' } });
    expect(foreignRead.status()).toBe(404);
    await page.getByRole('button', { name: 'Edit saved build', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
    await page.getByRole('tab', { name: 'Build order', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Step 1 time' })).toHaveValue('0:00');
    await expect(page.getByRole('textbox', { name: 'Step 3 time' })).toHaveValue('1:06');
    await expect(page.getByRole('combobox', { name: 'Step 3 action' })).toHaveValue('Gateway');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    return { ownerRead, foreignRead };
}
async function saveAndRematch(page, caseName, start, { ownerRead, foreignRead }) {
    await page.getByRole('button', { name: 'Create source build' }).click();
    await page.getByRole('button', { name: 'Dismiss this name check' }).click();
    await page.getByRole('button', { name: 'Save & re-match', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const writes = fixture.state.calls.slice(start).filter(call => call.method === 'PUT');
    expect(writes).toHaveLength(2); expect(writes.filter(call => call.body.reclassify === true)).toHaveLength(1);
    expect(writes.every(call => call.owner === OWNER && call.status === 200 && call.body.buildOrder.sourceGameId === GAME_ID)).toBe(true);
    summary.cases.push({ caseName, result: 'PASS', writes: writes.length, reclassifyRequests: 1, ownerReadStatus: ownerRead.status(), foreignReadStatus: foreignRead.status() });
}
async function runCase(width, theme) {
  const caseName = `${width}-${theme}`, start = fixture.state.calls.length;
  // A shorter desktop window exercises genuine scroll recovery in both layouts.
  const height = width === 1280 ? 720 : 1000;
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
  const page = await context.newPage();
  await observeCase(context, page, caseName);
  try {
    const save = await openSourceReference(page, caseName, theme);
    await rejectMalformedReference(page, caseName, save);
    await reviewReference(page, caseName);
    await repairAndSave(page, caseName, save);
    const reads = await readAndReopenSaved(page, context, start);
    await saveAndRematch(page, caseName, start, reads);
  } finally { await context.close(); }
}
(async () => {
  try {
    if (!fs.existsSync(CHROME)) throw new Error('Explicit installed Chrome1228 executable missing');
    fixture = await prepareReferenceSaveFixture(artifacts); summary.fixture = fixture.receipt;
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    for (const width of [390, 1280]) for (const theme of ['light', 'dark']) await runCase(width, theme);
    expect(summary.cases).toHaveLength(4); expect(summary.external).toEqual([]); expect(summary.errors).toEqual([]); expect(summary.console).toEqual([]);
    expect(fixture.state.unexpected).toEqual([]); expect(fixture.state.serverErrors).toEqual([]);
    summary.result = 'PASS';
  } catch (error) { summary.result = 'FAIL'; summary.failure = String(error.stack || error); process.exitCode = 1; }
  finally {
    await cleanup();
    if (fixture) write('wire.json', { calls: fixture.state.calls, unexpected: fixture.state.unexpected, serverErrors: fixture.state.serverErrors,
      saved: Array.from(fixture.state.saved.entries()), external: summary.external, errors: summary.errors, console: summary.console, failures: summary.failures, closure: summary.closure });
    write('SUMMARY.json', summary);
    console.log(JSON.stringify({ result: summary.result, cases: summary.cases.length, aaScans: summary.aa.length, aaViolations: summary.aa.reduce((count, scan) => count + scan.violations, 0),
      aaIncompleteRuleItems: summary.aa.reduce((count, scan) => count + scan.incomplete, 0), artifacts, closure: summary.closure, failure: summary.failure }));
  }
})();
