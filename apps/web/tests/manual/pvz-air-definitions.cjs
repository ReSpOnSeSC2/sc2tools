const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-proxy-server', '--proxy-server=direct://', '--proxy-bypass-list=*'] });
  const output = path.resolve('../../.cache/pvz-air-definition-captures');
  fs.mkdirSync(output, { recursive: true });
  let checks = 0;
  for (const [width, theme] of [[320, 'light'], [1440, 'dark']]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme });
    await context.addInitScript(theme => localStorage.setItem('sc2t.theme', theme), theme);
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    const response = await page.goto('http://127.0.0.1:3994/definitions?matchup=PvZ&q=Stargate', { waitUntil: 'domcontentloaded' });
    expect(response.status()).toBe(200); checks++;
    for (const label of ['PvZ - 2 Stargate Void Ray', 'PvZ - 2 Stargate Phoenix', 'PvZ - 3 Stargate Phoenix']) {
      const card = page.locator('article').filter({ has: page.getByText(label, { exact: true }) });
      await expect(card).toHaveCount(1);
      await expect(card.locator('p')).toContainText('by 7:00 or the first capital ship, whichever comes first');
      checks += 2;
      if ((width === 320 && label === 'PvZ - 2 Stargate Phoenix') || (width === 1440 && label === 'PvZ - 2 Stargate Void Ray')) {
        await card.screenshot({ path: path.join(output, `${width}-${theme}.png`) });
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); checks++;
    await context.close();
  }
  await browser.close();
  console.log(`${checks} production definition checks passed; ${output}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
