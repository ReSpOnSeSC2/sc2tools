const fs = require('fs'), path = require('path');
const web = path.resolve(__dirname, '../..'), repo = path.resolve(web, '../..');
const scratch = path.join(repo, '.cache'), shots = path.join(repo, 'docs/screenshots');
fs.mkdirSync(scratch, { recursive: true });
const esbuild = require(web + '/node_modules/esbuild'), { chromium } = require(web + '/node_modules/playwright');
const catalog = require(path.join(repo, 'apps/api/src/config/presetCatalog.json'));
const released = catalog.definitions.find(row => row.name === 'PvZ - Archon Drop');
fs.mkdirSync(shots, { recursive: true });
const mocks = {
  '@clerk/nextjs': `export const useAuth=()=>({getToken:async()=>'synthetic-admin'});`,
  'next/navigation': `import{useSyncExternalStore}from'react';const sub=f=>{addEventListener('popstate',f);addEventListener('fixture:nav',f);return()=>{removeEventListener('popstate',f);removeEventListener('fixture:nav',f)}};const snap=()=>location.href;export const useSearchParams=()=>new URL(useSyncExternalStore(sub,snap,snap)).searchParams;export const usePathname=()=>new URL(useSyncExternalStore(sub,snap,snap)).pathname;const write=(url,mode)=>{history[mode]({},'',url);dispatchEvent(new Event('fixture:nav'))};export const useRouter=()=>({replace:url=>write(url,'replaceState'),push:url=>write(url,'pushState')});`,
  'next/link': `import React from'react';export default function Link({href,children,...props}){return <a href={href} {...props}>{children}</a>};`,
  '@/components/help/LazyHelpLink': `export const LazyHelpLink=()=>null;`,
  '@/lib/clientApi': `import{useSyncExternalStore}from'react';export const API_BASE='https://fixture.test';
    const released=${JSON.stringify(released)};
    const base='/v1/admin/build-studio';let version=0;const listeners=new Set();const sub=f=>{listeners.add(f);return()=>listeners.delete(f)};const bump=()=>{version++;for(const f of listeners)f()};
    const preset={id:released.name,name:released.name,scope:'preset',owner:null,mode:'rule-only',released,replacement:null,expectedHash:'a'.repeat(64),policyRevision:3,evaluatorVersion:1,schemaVersion:1,releaseHash:'b'.repeat(64)};
    const build={name:'Private rule-only opener',race:'Protoss',vsRace:'Zerg',schemaVersion:3,perspective:'you',steps:[],rules:[{type:'count_min',name:'BuildGateway',count:1,time_lt:180}]};
    const custom={id:'custom-demo',name:build.name,scope:'custom',owner:'synthetic-owner',mode:'rule-only',revision:7,build,history:[]};
    const community={id:'community-demo',name:'Published snapshot',scope:'community',owner:'synthetic-owner',sourceSlug:'private-source',removed:true,mode:'rule-only',revision:2,title:'Published snapshot',description:'Synthetic public listing',build,history:[]};
    const details=new Map([[base+'/preset/'+encodeURIComponent(preset.id),preset],[base+'/custom/custom-demo',custom],[base+'/community/community-demo',community]]);
    const mutate=async(value,path)=>{if(value)details.set(path,value);bump();return value||details.get(path)};
    export function useApi(url){useSyncExternalStore(sub,()=>version,()=>version);if(!url)return{mutate:async()=>{}};let data=details.get(url);if(!data){const p=new URL(url,'https://fixture.test');if(p.pathname.endsWith('/history'))data={items:[],nextBefore:null};else{const scope=p.searchParams.get('scope');const item=scope==='custom'?custom:scope==='community'?community:preset;data={items:[item],nextAfter:null}}}return{data,error:null,isLoading:false,mutate:async value=>mutate(value,url)}}
    export async function apiCall(_token,url,init){if(!init)return details.get(url);(window.fixtureWrites||=[]).push({url,init});if(window.fixtureFail){window.fixtureFail=false;throw{status:503,message:'Fixture temporarily unavailable'}}const old=details.get(url);const input=JSON.parse(init.body);if(url.endsWith('/preview'))return{label:'Unclassified - Protoss',hash:'c'.repeat(64),evaluatorVersion:1};const next=old.scope==='preset'?{...old,replacement:input.replacement,expectedHash:'c'.repeat(64),policyRevision:4}:{...old,build:input.build,revision:old.revision+1,title:input.title||old.title,description:input.description||old.description};details.set(url,next);bump();return next};`,
};
const entry = `import React from'react';import{createRoot}from'react-dom/client';import Page from'@/app/admin/build-studio/page';createRoot(document.getElementById('root')).render(<main className='mx-auto min-w-0 max-w-6xl p-4'><Page/></main>);`;
(async () => {
  const bundle = path.join(scratch, `studio-browser-${process.pid}.js`);
  await esbuild.build({ stdin: { contents: entry, loader: 'tsx', resolveDir: web }, outfile: bundle, bundle: true, platform: 'browser', jsx: 'automatic', define: { 'process.env': '{}', 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'fixture', setup(b) {
    b.onResolve({ filter: /.*/ }, a => {
      if (mocks[a.path]) return { path: a.path, namespace: 'fixture' };
      if (a.path.startsWith('@/')) { const base = path.resolve(web, a.path.slice(2)); return { path: fs.existsSync(base) && fs.statSync(base).isDirectory() ? fs.existsSync(base + '/index.tsx') ? base + '/index.tsx' : base + '/index.ts' : fs.existsSync(base) ? base : fs.existsSync(base + '.tsx') ? base + '.tsx' : base + '.ts' }; }
    });
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, a => ({ contents: mocks[a.path], loader: 'tsx', resolveDir: web }));
  } }] });
  let css = fs.readdirSync(web + '/.next/static/css').map(file => fs.readFileSync(web + '/.next/static/css/' + file, 'utf8')).join('\n');
  css += '@font-face{font-family:PreviewSans;src:url(data:font/woff2;base64,' + fs.readFileSync(web + '/app/fonts/hanken-grotesk-latin.woff2').toString('base64') + ')}@font-face{font-family:PreviewDisplay;src:url(data:font/woff2;base64,' + fs.readFileSync(web + '/app/fonts/bricolage-grotesque-latin.woff2').toString('base64') + ')}html{--font-sans:PreviewSans;--font-display:PreviewDisplay}body{font-family:PreviewSans,sans-serif}';
  const browser = await chromium.launch({ headless: true });
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: true });
    const errors = [], requests = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      if (route.request().isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: `<html data-theme="dark"><head><style>${css}</style></head><body class="bg-bg text-text"><div id="root"></div></body></html>` });
      requests.push(route.request().url()); return route.abort();
    });
    await page.goto('https://fixture.test/admin/build-studio'); await page.addScriptTag({ path: bundle });
    const row = page.getByRole('button', { name: /^PvZ - Archon Drop/ }); await row.waitFor(); await row.tap();
    const editor = page.getByRole('dialog', { name: 'Build definition', exact: true }); await editor.waitFor();
    await editor.getByText('Released definition and source', { exact: true }).tap();
    await editor.getByRole('button', { name: 'Use actual released criteria as replacement' }).tap();
    const deadline = editor.getByLabel('Deadline (m:ss)').last();
    if (await deadline.inputValue() !== '6:00') throw new Error('Real released Prism completion gate not exposed');
    await deadline.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(shots, `admin-build-studio-${width}.png`), fullPage: false });
    await deadline.fill('5:30'); await deadline.press('Tab');
    await page.keyboard.press('Escape');
    const discard = page.getByRole('dialog', { name: 'Discard unsaved definition changes?' }); await discard.waitFor();
    await discard.getByRole('button', { name: 'Keep editing' }).tap();
    if (await editor.getByLabel('Deadline (m:ss)').last().inputValue() !== '5:30') throw new Error('Closing dialog lost unsaved gate');
    await page.evaluate(() => window.fixtureFail = true);
    await editor.getByRole('button', { name: 'Review changes', exact: true }).tap();
    let review = page.getByRole('dialog', { name: 'Review definition changes' }); await review.waitFor();
    if (!(await review.textContent()).includes('"beforeSeconds": 330')) throw new Error('Reviewed rule does not match edit');
    if (await page.evaluate(() => (window.fixtureWrites || []).length) !== 0) throw new Error('Review performed a write');
    await review.getByRole('button', { name: 'Confirm save' }).tap(); await editor.getByRole('alert').waitFor();
    if (await editor.getByLabel('Deadline (m:ss)').last().inputValue() !== '5:30') throw new Error('Failed save lost draft');
    await editor.getByRole('button', { name: 'Review changes', exact: true }).tap();
    review = page.getByRole('dialog', { name: 'Review definition changes' }); await review.getByRole('button', { name: 'Confirm save' }).tap();
    await editor.getByText('Definition saved as a new version.', { exact: true }).waitFor();
    const writes = await page.evaluate(() => window.fixtureWrites);
    if (writes.length !== 2 || writes.some(write => JSON.parse(write.init.body).expectedHash !== 'a'.repeat(64))) throw new Error('Expected hash/version contract changed');
    await page.keyboard.press('Escape');
    if (!(await row.evaluate(node => node === document.activeElement))) throw new Error('Editor did not restore row focus: '+JSON.stringify(await page.evaluate(()=>({active:document.activeElement?.outerHTML.slice(0,300),dialogs:[...document.querySelectorAll('[role="dialog"]')].map(node=>node.querySelector('h2')?.textContent)}))));
    await row.press('Enter'); await editor.waitFor(); await page.keyboard.press('Escape');
    await row.press('Space'); await editor.waitFor(); await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'All private custom builds' }).tap();
    await page.getByRole('button', { name: /^Private rule-only opener/ }).tap(); await editor.waitFor();
    if (!(await editor.textContent()).includes('owner synthetic-owner') || !(await editor.textContent()).includes('Rule-only definition')) throw new Error('Private owner/rule-only details missing');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'All community snapshots' }).tap();
    await page.getByRole('button', { name: /^Published snapshot/ }).tap(); await editor.waitFor();
    if (!(await editor.textContent()).includes('keeps it removed')) throw new Error('Removed community state not explicit');
    const overflow = await page.evaluate(() => document.body.scrollWidth > innerWidth);
    if (overflow || errors.length || requests.length) throw new Error(JSON.stringify({ width, overflow, errors, requests }));
    console.log(JSON.stringify({ width, touch: true, keyboard: ['Enter', 'Space', 'Escape'], criteria: 'real6:00→5:30', reviewBeforeWrite: true, failedSaveRetainsDraft: true, discardGuard: true, privateAndRemovedCommunity: true, overflow, errors, requests }));
    await page.close();
  }
  await browser.close();
})().catch(error => { console.error(error); process.exit(1); });
