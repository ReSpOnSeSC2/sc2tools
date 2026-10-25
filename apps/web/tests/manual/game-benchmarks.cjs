/* Run after a production build: node tests/manual/game-benchmarks.cjs.
 * Actual comparison/autopsy components + production CSS; synthetic API/auth
 * boundaries only. No requests leave the fixture and no account is written.
 */
const fs = require('node:fs'), path = require('node:path');
const web = path.resolve(__dirname, '../..'), repo = path.resolve(web, '../..');
const scratch = path.join(repo, '.cache'), shots = path.join(repo, 'docs/handoff/screenshots');
fs.mkdirSync(scratch, { recursive: true }); fs.mkdirSync(shots, { recursive: true });
const esbuild = require(path.join(web, 'node_modules/esbuild'));
const { chromium, expect } = require(path.join(web, 'node_modules/@playwright/test'));
const table = { leagueId: 4, league: 'Diamond', matchup: 'ZvT', n: 450, updatedAt: '2026-10-24T03:00:00Z', metrics: {
  macroScore: { n: 450, deciles: [35,40,45,50,55,60,65,70,75] }, apm: { n: 439, deciles: [80,100,120,140,160,180,200,220,240] },
  spq: { n: 320, deciles: [30,35,40,45,50,55,60,65,70] }, durationSec: { n: 450, deciles: [300,360,420,480,540,600,660,720,780] },
} };
const context = { matchup: 'ZvT', personal: { n: 36, limit: 50, build: 'Checked-in macro opener', expansionTimings: { Hatchery: 100 }, expansionSample: 12, expansionLimit: 25, expansionMinSample: 5,
  metrics: { macroScore: { n: 36, median: 64, p25: 58, p75: 70 }, apm: { n: 35, median: 158, p25: 130, p75: 180 },
    spq: { n: 30, median: 52, p25: 43, p75: 60 }, durationSec: { n: 36, median: 620, p25: 500, p75: 790 } } }, league: { table } };
const mocks = {
  '@/lib/useBenchmarks': `import{useSyncExternalStore}from'react';const table=${JSON.stringify(table)};const sub=f=>{addEventListener('fixture:change',f);return()=>removeEventListener('fixture:change',f)};export function useBenchmarks(){const mode=useSyncExternalStore(sub,()=>window.fixtureMode||'ready',()=> 'ready');return mode==='league404'?{error:{status:404}}:{data:{table}}};`,
  '@/components/help/LazyHelpLink': `export function LazyHelpLink(){return <button type='button' className='min-h-[44px] rounded px-2 text-caption underline' onClick={()=>window.fixtureHelp=(window.fixtureHelp||0)+1}>Help</button>}`,
  'next/link': `export default function Link({href,children,...rest}){return <a href={href} {...rest}>{children}</a>}`,
};
const entry = `import React,{useSyncExternalStore}from'react';import{createRoot}from'react-dom/client';import{GameContextCard}from'@/components/analyzer/game/GameContextCard';import{LossAutopsyCard}from'@/components/analyzer/game/LossAutopsyCard';
const context=${JSON.stringify(context)};const sub=f=>{addEventListener('fixture:change',f);return()=>removeEventListener('fixture:change',f)};
function Fixture(){const mode=useSyncExternalStore(sub,()=>window.fixtureMode||'ready',()=> 'ready');const missing=mode==='missing';return <main className='mx-auto max-w-6xl space-y-5 p-4'><h1 className='font-display text-h2 font-bold'>ZvT vs Fixture rival</h1><p className='text-body-sm text-text-muted'>Synthetic game data · no account requests</p><div className='grid items-start gap-6 md:grid-cols-2'><div className='min-w-0 space-y-4'><section className='rounded-xl border-2 border-line bg-bg-surface p-4 shadow-hard'><h2 className='font-display text-h3 font-bold'>Mechanics</h2><p className='text-body-sm text-text-muted'>Mechanics fixture boundary</p></section><GameContextCard game={{gameId:'fixture',macroScore:missing?null:71,apm:172,spq:57,durationSec:700,opponent:{leagueId:4}}} context={mode==='error'?undefined:mode==='league404'?{...context,league:null}:context} error={mode==='error'?{status:503,message:'Synthetic temporary failure'}:undefined} onRetry={()=>{window.fixtureRetries=(window.fixtureRetries||0)+1;window.fixtureMode='ready';dispatchEvent(new Event('fixture:change'))}}/></div><LossAutopsyCard game={{id:'fixture',result:'Defeat',buildLog:['[0:00] Hatchery','[3:40] Hatchery'],macroBreakdown:{race:'Zerg',raw:{}}}} personalMedians={context.personal} seekTarget='replay' onSeek={sec=>window.fixtureSeek=sec}/></div></main>};createRoot(document.getElementById('root')).render(<Fixture/>);`;
(async () => {
  const bundle = path.join(scratch, `benchmarks-browser-${process.pid}.js`);
  await esbuild.build({ stdin: { contents: entry, loader: 'tsx', resolveDir: web }, outfile: bundle, bundle: true, platform: 'browser', jsx: 'automatic', define: { 'process.env': '{}', 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'fixture', setup(b) {
    b.onResolve({ filter: /.*/ }, a => {
      if (mocks[a.path]) return { path: a.path, namespace: 'fixture' };
      if (a.path.startsWith('@/')) { const base = path.resolve(web, a.path.slice(2)); return { path: fs.existsSync(base) ? base : fs.existsSync(base + '.tsx') ? base + '.tsx' : base + '.ts' }; }
    });
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, a => ({ contents: mocks[a.path], loader: 'tsx', resolveDir: web }));
  } }] });
  let css = fs.readdirSync(path.join(web, '.next/static/css')).map(file => fs.readFileSync(path.join(web, '.next/static/css', file), 'utf8')).join('\n');
  css += '@font-face{font-family:FixtureSans;src:url(data:font/woff2;base64,' + fs.readFileSync(path.join(web, 'app/fonts/hanken-grotesk-latin.woff2')).toString('base64') + ')}@font-face{font-family:FixtureDisplay;src:url(data:font/woff2;base64,' + fs.readFileSync(path.join(web, 'app/fonts/bricolage-grotesque-latin.woff2')).toString('base64') + ')}html{--font-sans:FixtureSans;--font-display:FixtureDisplay}body{font-family:FixtureSans,sans-serif}';
  const browser = await chromium.launch({ headless: true });
  let checks = 0;
  try {
    for (const theme of ['dark','light']) for (const width of [320,390,768,1440]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, hasTouch: true });
      const errors = [], requests = []; page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        if (route.request().isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: `<html data-theme="${theme}"><head><style>${css}</style></head><body class="bg-bg text-text"><div id="root"></div></body></html>` });
        requests.push(route.request().url()); return route.abort();
      });
      await page.goto('https://fixture.test/app/game/synthetic'); await page.addScriptTag({ path: bundle });
      await expect(page.getByRole('heading', { name: /Your usual and your league/ })).toBeVisible(); checks++;
      await expect(page.getByText('82nd percentile · Diamond ZvT')).toBeVisible(); checks++;
      await expect(page.getByRole('img', { name: /Macro score: band = opponent's league/ })).toBeVisible(); checks++;
      await page.getByRole('button', { name: 'Watch the replay at 3:40' }).tap();
      if (await page.evaluate(() => window.fixtureSeek) !== 220) throw new Error('Autopsy seek not wired'); checks++;
      await page.getByRole('button', { name: 'Help', exact: true }).focus(); await page.keyboard.press('Enter');
      if (await page.evaluate(() => window.fixtureHelp) !== 1) throw new Error('Help keyboard activation failed'); checks++;
      if (width === 390 || width === 1440) await page.screenshot({ path: path.join(shots, `game-benchmarks-${theme}-${width}.png`), fullPage: true });
      await page.evaluate(() => { window.fixtureMode = 'league404'; dispatchEvent(new Event('fixture:change')); });
      await expect(page.getByText(/Your ZvT median64|Your ZvT median 64/)).toBeVisible(); await expect(page.getByText(/percentile ·/)).toHaveCount(0); checks++;
      await page.evaluate(() => { window.fixtureMode = 'error'; dispatchEvent(new Event('fixture:change')); });
      const retry = page.getByRole('button', { name: 'Retry', exact: true }); await retry.focus(); await page.keyboard.press('Enter');
      await expect(page.getByText('82nd percentile · Diamond ZvT')).toBeVisible(); checks++;
      await page.evaluate(() => { window.fixtureMode = 'missing'; dispatchEvent(new Event('fixture:change')); });
      await expect(page.getByRole('img', { name: /Macro score:/ })).toHaveCount(0); await expect(page.getByText(/Macro score Unavailable/)).toBeVisible(); checks++;
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      if (overflow || errors.length || requests.length) throw new Error(JSON.stringify({ width, theme, overflow, errors, requests })); checks++;
      console.log(JSON.stringify({ width, theme, checks, overflow, errors, requests })); await page.close();
    }
  } finally { await browser.close(); }
  console.log(`${checks} browser checks passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
