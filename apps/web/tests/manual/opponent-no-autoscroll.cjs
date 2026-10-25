/* Actual component/CSS proof: delayed analysis below the viewport must not
 * move the reader. Only an explicit section click moves the page. */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
process.chdir(path.resolve(__dirname, '../..'));
const { build } = require('esbuild'), { chromium, expect } = require('@playwright/test');
const root = process.cwd(), css = fs.readdirSync('.next/static/css', { recursive: true }).filter(n => n.endsWith('.css')).map(n => fs.readFileSync(path.join('.next/static/css', n), 'utf8')).join('\n');
const fixture = `import React,{useEffect,useState} from 'react';import{createRoot}from'react-dom/client';import{PhaseCompositionTabs}from'./components/analyzer/PhaseCompositionTabs';import{SectionNav}from'./components/ui/SectionNav';
function Fixture(){const[ready,setReady]=useState(false);useEffect(()=>{window.releaseAnalysis=()=>setReady(true)},[]);const row={signatures:[],tech:[],upgrades:[]};return <main style={{padding:16}}><button id="reader">Stay at my current position</button><SectionNav variant="bar" aria-label="Dossier sections" items={[{id:'brief',label:'Brief'},{id:'timings',label:'Timings'}]}/><section id="brief" style={{height:2200}}><h1>Opponent dossier fixture</h1><p>Analysis is held below the viewport.</p></section><section id="timings" style={{minHeight:1200}}><h2>Recorded compositions</h2>{ready?<PhaseCompositionTabs sampleSize={{early:4,earlyMid:4,mid:4,midLate:4,late:4}} perPhase={{early:row,earlyMid:row,mid:row,midLate:row,late:row}}/>:<p>Loading analysis</p>}</section></main>}createRoot(document.getElementById('root')).render(<Fixture/>);`;
let origin, javascript = '', checks = 0; const errors = [];
const mocks = {
  'next/link': `import React from 'react';export default function Link({children,...props}){return <a {...props}>{children}</a>}`,
  'next/image': `import React from 'react';export default function Image({priority,fill,unoptimized,...props}){return <img {...props}/>}`,
  'next/navigation': `export const usePathname=()=>'/fixture';export const useSearchParams=()=>new URLSearchParams();export const useRouter=()=>({push(){},replace(){},prefetch(){}});`,
  '@clerk/nextjs': `export const useAuth=()=>({isLoaded:true,isSignedIn:true,userId:'synthetic',getToken:async()=>null});`,
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin || 'http://127.0.0.1');
  if (url.pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); return res.end(javascript); }
  if (url.pathname === '/fixture') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(`<!doctype html><html lang="en" data-theme="${url.searchParams.get('theme')}"><head><meta charset="utf-8"><title>Delayed opponent composition proof</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`); }
  res.statusCode = 404; res.end();
});
(async () => {
  const compiled = await build({ stdin: { contents: fixture, resolveDir: root, sourcefile: 'opponent-scroll-fixture.tsx', loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', tsconfig: 'tsconfig.json', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'local-platform', setup(b) { b.onResolve({ filter: /^(next\/(link|image|navigation)|@clerk\/nextjs)$/ }, args => ({ path: args.path, namespace: 'local' })); b.onLoad({ filter: /.*/, namespace: 'local' }, args => ({ contents: mocks[args.path], resolveDir: root, loader: 'jsx' })); } }] });
  javascript = compiled.outputFiles[0].text;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [320,390,768,1440]) for (const theme of ['light','dark']) {
      const context = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: 'reduce' });
      const page = await context.newPage(); page.on('pageerror', e => { errors.push(e.message); console.error(e.message); });
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await page.goto(origin + '/fixture?theme=' + theme);
      await expect(page.getByRole('button', { name: 'Stay at my current position' })).toBeVisible();
      await page.evaluate(() => { document.getElementById('reader').focus({ preventScroll: true }); scrollTo(0, 0); });
      await page.waitForFunction(() => typeof window.releaseAnalysis === 'function');
      await page.evaluate(() => window.releaseAnalysis());
      await expect(page.getByRole('tablist', { name: 'Phase compositions' })).toBeVisible();
      await page.waitForTimeout(500);
      expect(await page.evaluate(() => scrollY), 'async composition load must not move the page').toBe(0); checks++;
      expect(await page.evaluate(() => document.activeElement.id)).toBe('reader'); checks++;
      await page.getByRole('link', { name: 'Timings', exact: true }).click();
      await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(1000); checks++;
      const first = page.getByRole('tab').first(); await first.focus(); const before = await page.evaluate(() => scrollY);
      await first.press('End'); await expect(page.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true'); checks++;
      expect(Math.abs(await page.evaluate(() => scrollY) - before)).toBeLessThanOrEqual(1); checks++;
      if (width < 500) { expect(await page.getByRole('tablist').evaluate(node => node.scrollLeft)).toBeGreaterThan(0); checks++; }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); checks++;
      await context.close(); console.log(JSON.stringify({ width, theme, checks }));
    }
    expect(errors).toEqual([]); checks++; console.log(JSON.stringify({ checks, externalTraffic: 'blocked', writes: 0 }));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
