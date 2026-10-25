/* Real saved-view/provider/filter/default-page components. Explicit synthetic
 * Next/auth/API/clipboard boundaries; the browser runner blocks remote IO. */
const fs = require('node:fs'), path = require('node:path');
const esbuild = require('esbuild');
const web = process.cwd(), scratch = path.resolve(web, '../../.cache');
fs.mkdirSync(scratch, { recursive: true });
const mocks = {
  'next/navigation': `import{useSyncExternalStore}from'react';const sub=f=>{addEventListener('popstate',f);addEventListener('fixture:navigate',f);return()=>{removeEventListener('popstate',f);removeEventListener('fixture:navigate',f)}};const snap=()=>location.href;const nav=(url,mode='replace',delay=0)=>{history[mode==='push'?'pushState':'replaceState']({},'',url);if(delay)setTimeout(()=>dispatchEvent(new Event('fixture:navigate')),delay);else dispatchEvent(new Event('fixture:navigate'));};window.fixtureNavigate=nav;const router={replace:(url,options)=>{(window.fixtureReplaces||=[]).push({url,options});nav(url)},push:url=>nav(url,'push')};export const useRouter=()=>router;export const usePathname=()=>new URL(useSyncExternalStore(sub,snap,snap)).pathname;export const useSearchParams=()=>new URL(useSyncExternalStore(sub,snap,snap)).searchParams;export function redirect(href){throw{fixtureRedirect:href}};`,
  'next/headers': `export const cookies=async()=>({has:()=>!!window.fixtureSessionStarted});`,
  'next/link': `export default function Link({href,children,...rest}){return <a href={href} {...rest}>{children}</a>}`,
  'next/dynamic': `import React,{Suspense,lazy}from'react';export default function dynamic(load,options={}){const C=lazy(()=>Promise.resolve(load()).then(m=>({default:m.default||m})));return props=><Suspense fallback={options.loading?<options.loading/>:null}><C {...props}/></Suspense>}`,
  '@clerk/nextjs': `export const useAuth=()=>({isLoaded:true,isSignedIn:true,userId:'synthetic-owner',getToken:async()=>'synthetic-token'});`,
  '@/lib/useUserSocket': `export function useUserSocket(){}`,
  '@/lib/useSeasons': `export const useSeasons=()=>({data:{items:[]}});export const rollUpSeasons=()=>[];`,
  '@/components/analyzer/arcade/hooks/useAnalysisGames': `export function AnalysisGamesProvider({children}){return children}`,
  '@/components/dashboard/TodayView': `export function TodayView(){return <p>Today fixture boundary</p>}`,
  '@/components/help/LazyHelpLink': `export function LazyHelpLink({slug,anchor,children}){return <a className='inline-flex min-h-11 items-center text-caption text-accent underline' href={'/help/'+slug+(anchor?'#'+anchor:'')}>{children||'Help'}</a>}`,
  '@/lib/api': `export async function apiFetch(path){if(path!=='/v1/me/analyzer-default-view')throw Error('Unexpected server fixture path');window.fixtureDefaultLookups=(window.fixtureDefaultLookups||0)+1;const prefs=window.fixtureViews;return{ok:true,data:{defaultView:prefs.views.find(v=>v.id===prefs.defaultViewId)||null,defaultTab:'macro'}}}`,
  '@/lib/clientApi': `import{useSyncExternalStore}from'react';import{sanitizeAnalyzerViews as validate}from'../api/src/util/analyzerViews.js';
    window.fixtureViews={views:[{id:'seeded',name:'Other matchup',section:'macro',filters:{preset:'all',race:'Z',opp_race:'T',map_pool:'ladder',game_size:'1v1'}}],defaultViewId:null};
    let version=0,cached;const listeners=new Set();const sub=f=>{listeners.add(f);return()=>listeners.delete(f)};const bump=()=>{version++;for(const f of listeners)f()};export const API_BASE='http://127.0.0.1:3227';
    export function useApi(path){useSyncExternalStore(sub,()=>version,()=>version);if(path?.startsWith('/v1/random-summary'))return{data:{total:0,perRace:{},best:null,worst:null,minDecidedForBest:5},isLoading:false};if(path&&path!=='/v1/me/preferences/analyzerViews')throw Error('Unexpected client fixture path:'+path);return{data:path?(cached||window.fixtureViews):undefined,isLoading:false,error:null,mutate:async value=>{if(value)cached=value;bump();return cached||window.fixtureViews}}}
    export async function apiCall(getToken,path,init){await getToken();if(path!=='/v1/me/preferences/analyzerViews'||init.method!=='PUT')throw Error('Unexpected fixture write');(window.fixtureWrites||=[]).push(JSON.parse(init.body));if(window.fixtureFailNext){window.fixtureFailNext=false;throw{status:503,message:'Fixture temporarily unavailable'}}const saved=validate(JSON.parse(init.body),true);window.fixtureViews=saved;cached=saved;bump();return saved};`,
};
const entry = `import React,{useEffect}from'react';import{createRoot}from'react-dom/client';import{AnalyzerProvider}from'@/components/AnalyzerProvider';import{FilterBar}from'@/components/analyzer/FilterBar';import{ActiveFilterChips}from'@/components/analyzer/ActiveFilterChips';import{Card}from'@/components/ui/Card';import{useFilters}from'@/lib/filterContext';import AppHome from'@/app/app/page';
window.fixtureResolveHome=async(query={},session=false)=>{window.fixtureSessionStarted=session;try{await AppHome({searchParams:Promise.resolve(query)});return null}catch(e){if(e.fixtureRedirect)return e.fixtureRedirect;throw e}};
function Workspace(){const{filters,setFilters}=useFilters();useEffect(()=>{window.fixtureFilters=filters},[filters]);return <main className='mx-auto max-w-6xl space-y-5 p-4 sm:p-8'><h1 className='font-display text-h2 font-bold'>Your saved analyzer views</h1><p className='text-body-sm text-text-muted'>Synthetic personal history · no account or game requests</p><FilterBar/><ActiveFilterChips/><Card title='Your filtered history'><p className='text-body text-text-muted'>The selected filters apply to your own synced games. This fixture uses no replay records.</p><div className='mt-4 flex flex-wrap gap-2'><button type='button' className='min-h-11 rounded border border-border px-3' onClick={()=>setFilters({...filters,race:'T'})}>Fixture Terran</button><button type='button' className='min-h-11 rounded border border-border px-3' onClick={()=>setFilters({...filters,race:'P'})}>Fixture Protoss</button></div></Card></main>};createRoot(document.getElementById('root')).render(<AnalyzerProvider syncUrl><Workspace/></AnalyzerProvider>);`;
esbuild.build({ stdin: { contents: entry, loader: 'tsx', resolveDir: web }, bundle: true, outfile: path.join(scratch, 'analyzer-views-fixture.js'), platform: 'browser', jsx: 'automatic', alias: { '@': web }, define: { 'process.env': '{}', 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'explicit-synthetic-boundaries', setup(build) {
  build.onResolve({ filter: /.*/ }, args => {
    let key = args.path;
    if (key === './clientApi' && args.importer.replaceAll('\\','/').includes('/lib/')) key = '@/lib/clientApi';
    if (mocks[key]) return { path: key, namespace: 'fixture' };
  });
  build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'tsx', resolveDir: web, contents: mocks[args.path] }));
} }], logLevel: 'warning' }).catch(error => { console.error(error); process.exitCode = 1; });
