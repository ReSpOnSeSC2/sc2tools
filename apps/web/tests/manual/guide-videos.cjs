/* Actual client island, production CSS/fonts, synthetic video metadata.
 * Run from apps/web after build: node tests/manual/guide-videos.cjs
 * Every nonlocal request is blocked; no provider or account writes. */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const esbuild = require('esbuild'), { chromium, expect } = require('@playwright/test');
const root = process.cwd(), origin = 'http://127.0.0.1:3244';
fs.mkdirSync('.tmp', { recursive: true });
const boundaries = {
  'next/link': "import React from'react';export default function Link({href,children,prefetch,scroll,replace,...props}){return <a href={href} {...props}>{children}</a>}",
  'next/navigation': "import{useSyncExternalStore}from'react';const subscribe=fn=>{addEventListener('fixture-navigation',fn);return()=>removeEventListener('fixture-navigation',fn)},router={replace(href){history.replaceState({},'',href);dispatchEvent(new Event('fixture-navigation'))},refresh(){}};export function useRouter(){return router}export function usePathname(){return useSyncExternalStore(subscribe,()=>location.pathname)}export function useSearchParams(){useSyncExternalStore(subscribe,()=>location.search);return new URLSearchParams(location.search)}",
};
const entry = `import React from'react';import{createRoot}from'react-dom/client';import{GuideVideosList}from'@/components/guides/GuideVideosList';import{filterGuideVideos,parseVideoMatchup}from'@/lib/guides/videoFilters';
const videos=Array.from({length:55},(_,i)=>{const youtubeId='fixture-'+String(i).padStart(3,'0');return{youtubeId,title:i===54?'Économie — Glaïves build order':'Recorded build order '+String(i+1).padStart(2,'0')+' — scouting and expansion guide',publishedAt:'2026-10-24T10:00:00.000Z',url:'https://www.youtube.com/watch?v='+youtubeId,thumbnailUrl:'https://i.ytimg.com/vi/'+youtubeId+'/hqdefault.jpg',embedUrl:'https://www.youtube-nocookie.com/embed/'+youtubeId,excerpt:'Synthetic local metadata.',checklist:null,matchup:i<30?'PvZ':i<50?'TvP':null,buildSlug:i===0?'stargate-into-glaives':null}});
const payload={videos,eightWorkerVideos:[{...videos[1],youtubeId:'archive-001',title:'8-worker patch archive',eightWorkerPatch:true}],channel:{name:'Synthetic channel',url:'https://www.youtube.com/@response'},playlists:null},initialMatchup=parseVideoMatchup(new URLSearchParams(location.search).get('matchup'));
createRoot(document.getElementById('root')).render(<main className='mx-auto max-w-7xl px-4 py-8 sm:px-6'><GuideVideosList payload={payload} initialMatchup={initialMatchup} initialVideos={filterGuideVideos(videos,initialMatchup)}/></main>);`;
const plugin = { name: 'local-router-boundary', setup(build) {
  build.onResolve({ filter: /.*/ }, args => boundaries[args.path] ? { path: args.path, namespace: 'fixture' } : undefined);
  build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'tsx', resolveDir: root, contents: boundaries[args.path] }));
} };
const fonts = "@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay;--font-serif:serif}";
(async () => {
  await esbuild.build({ stdin: { contents: entry, loader:'tsx', resolveDir:root }, bundle:true, outfile:'.tmp/guide-videos-fixture.js', alias:{'@':root}, plugins:[plugin], jsx:'automatic', define:{'process.env.NODE_ENV':'"production"','process.env.NEXT_PUBLIC_SITE_URL':'"https://sc2tools.com"'}, logLevel:'warning' });
  const css=fs.readdirSync('.next/static/css',{recursive:true}).filter(name=>name.endsWith('.css')).map(name=>fs.readFileSync(path.join('.next/static/css',name),'utf8')).join('\n');
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,origin);
    if(url.pathname==='/fixture.js'){res.setHeader('content-type','text/javascript;charset=utf-8');return res.end(fs.readFileSync('.tmp/guide-videos-fixture.js'))}
    if(url.pathname.startsWith('/fonts/')){res.setHeader('content-type','font/woff2');return res.end(fs.readFileSync(path.join('app',url.pathname)))}
    res.setHeader('content-type','text/html;charset=utf-8');res.end('<!doctype html><html data-theme="'+(url.searchParams.get('theme')==='dark'?'dark':'light')+'"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'\n'+fonts+'</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
  });
  await new Promise(resolve=>server.listen(3244,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true});let checks=0;
  try {
    for(const width of [375,1440])for(const theme of ['light','dark']){
      const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'});
      await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.request().url().startsWith('https://i.ytimg.com/')?route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="480" height="270" fill="#142432"/><text x="240" y="140" text-anchor="middle" fill="#b2d4df" font-family="sans-serif" font-size="18">Local fixture thumbnail</text></svg>'}):route.abort());
      const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.goto(origin+'/guides/videos?theme='+theme);await expect(page.getByRole('heading',{name:'All build order videos'})).toBeVisible();
      await expect(page.locator('[data-guide-video-watch]')).toHaveCount(24);checks++;
      await expect(page.getByRole('button',{name:'All (55)',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'PvZ (30)',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Other (5)',exact:true})).toBeVisible();expect((await page.getByRole('button',{name:'PvZ (30)',exact:true}).boundingBox()).height).toBeGreaterThanOrEqual(44);checks++;
      await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:'../../docs/handoff/screenshots/guide-videos-'+theme+'-'+width+'.png'});checks++;
      await page.getByRole('button',{name:'Show more (31 left)'}).click();await expect(page.locator('[data-guide-video-watch]')).toHaveCount(48);expect(await page.evaluate(()=>document.activeElement?.textContent)).toContain('Recorded build order 25');checks++;
      await page.getByRole('button',{name:'PvZ (30)',exact:true}).click();await expect(page.getByRole('status')).toContainText('30 videos found · Showing 24');await expect(page).toHaveURL(/matchup=pvz/);checks++;
      await page.getByRole('button',{name:'TvP (20)',exact:true}).click();await expect(page.locator('[data-guide-video-watch]')).toHaveCount(20);await expect(page.getByRole('link',{name:/Read the guide/})).toHaveCount(0);checks++;
      await page.getByRole('button',{name:'All (55)',exact:true}).click();await page.getByRole('searchbox').fill('eCONOMIE');await expect(page.getByRole('status')).toHaveText('1 video found.');await expect(page.locator('[data-guide-video-watch]')).toContainText('Économie');checks++;
      await page.getByRole('searchbox').fill('unmatched title');await expect(page.getByText('No videos match',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Clear filters'}).click();await expect(page.locator('[data-guide-video-watch]')).toHaveCount(24);checks++;
      const guide=page.getByRole('link',{name:/Read the guide/});await expect(guide).toHaveAttribute('href','/guides/pvz/stargate-into-glaives');expect(await guide.getAttribute('target')).toBeNull();checks++;
      expect(await page.locator('[type="application/ld+json"]').evaluate(node=>JSON.parse(node.textContent).filter(item=>item['@type']==='VideoObject').length)).toBe(56);checks++;
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);checks++;
      await page.goto(origin+'/guides/videos?theme='+theme+'&matchup=tvp');await expect(page.locator('[data-guide-video-watch]')).toHaveCount(20);await expect(page.getByRole('button',{name:'TvP (20)',exact:true})).toHaveAttribute('aria-pressed','true');checks++;
      await context.close();console.log(JSON.stringify({width,theme,checks}));
    }
    console.log(JSON.stringify({checks,nonlocalTraffic:'blocked',providerWrites:0}));
  } finally { await browser.close();await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1});
