/* Actual Macro/Builds components and fetch hooks; only auth/Next and the
 * unrelated MMR subpanels are explicit fixture boundaries. Local API only. */
const fs = require('node:fs'), path = require('node:path'), esbuild = require('esbuild');
const root = process.cwd();
const dates = { day: ['2026-10-01','2026-10-02','2026-10-03','2026-10-10','2026-10-11'], week: ['2026-09-06','2026-09-13','2026-09-20','2026-10-04','2026-10-11'], month: ['2026-05-01','2026-06-01','2026-07-01','2026-09-01','2026-10-01'] };
const points = interval => dates[interval].map((date, i) => ({ bucket: date + 'T00:00:00Z', total: [9,10,2,8,12][i], wins: [4,6,1,4,8][i], losses: [5,4,1,4,4][i], avgMacroScore: [55,63,null,71,78][i], macroN: [4,5,0,6,8][i], avgApm: [120,132,null,145,150][i], apmN: [5,8,0,6,10][i], avgSpq: [58,61,null,68,72][i], spqN: [4,5,0,5,2][i] }));
const leak = { name: 'Supply Blocked', games: 8, share: 8/23, totalMinerals: 2400, mineralsPerGame: 300, avgPenalty: 8, wins: 3, losses: 5, winRateWith: .375, winRateWithout: 10/15, trend: null };
const segment = { key: 'PvZ', label: 'PvZ', games: 23, wins: 13, losses: 10, winRate: 13/23, avgScore: 68.9 };
const report = { ok: true, gamesTotal: 41, gamesScored: 23, avgScore: 68.9, winRate: 13/23, scoreBuckets: [{ key: 'mid', label: '50–74', min: 50, max: 75, games: 15, wins: 8, losses: 7, winRate: 8/15, avgScore: 64.1 }, { key: 'high', label: '75–100', min: 75, max: 101, games: 8, wins: 5, losses: 3, winRate: 5/8, avgScore: 78 }], leaks: [leak], segments: { matchup: [segment], duration: [{...segment,key:'6-10',label:'6–10 minutes',minMinutes:6,maxMinutes:10}], build: [{...segment,key:'Blink pressure',label:'Blink pressure'}] }, trend: null };
module.exports = { points, report };
if (require.main === module) {
  const boundaries = {
    'next/link': `import React from'react';export default function Link({href,children,prefetch,...props}){return <a href={href} {...props}>{children}</a>}`,
    'next/image': `import React from'react';export default function Image({fill,priority,unoptimized,loader,quality,...props}){return <img {...props}/>} `,
    'next/navigation': `export const useRouter=()=>({push:href=>location.assign(href),replace:href=>history.replaceState(null,'',href),prefetch(){}});export const usePathname=()=>location.pathname;export const useSearchParams=()=>new URLSearchParams(location.search);`,
    'next/dynamic': `import React from'react';export default function dynamic(loader,options){const Lazy=React.lazy(()=>Promise.resolve(loader()).then(mod=>typeof mod==='function'?{default:mod}:mod));return props=><React.Suspense fallback={options?.loading?.()||null}><Lazy {...props}/></React.Suspense>}`,
    '@clerk/nextjs': `export const useAuth=()=>({isLoaded:true,isSignedIn:true,userId:'fixture-owner',getToken:async()=>'fixture-token'});export const useUser=()=>({isLoaded:true,isSignedIn:true,user:{id:'fixture-owner'}});`,
    '@sentry/nextjs': `export function captureException(){}export function captureMessage(){}export function addBreadcrumb(){}`,
  };
  for (const name of ['BuildMmrPanel','BuildAgingCurve','MmrProgressionByBuild']) boundaries[`./mmr/${name}`] = `export function ${name}(){return null}`;
  fs.mkdirSync('.tmp', { recursive: true });
  fs.writeFileSync('.tmp/mechanics-progress-entry.tsx', `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{SWRConfig}from'swr';import{FiltersContext}from'@/lib/filterContext';import{MacroTab}from'@/components/analyzer/MacroTab';import{BuildsTab}from'@/components/analyzer/BuildsTab';import{ToastProvider}from'@/components/ui/Toast';function Preview(){const[filters,setFilters]=useState({race:'P',opp_race:'Z',since:'2026-05-01',map_pool:'ladder',game_size:'1v1'});return <SWRConfig value={{dedupingInterval:60000,shouldRetryOnError:false}}><ToastProvider><FiltersContext.Provider value={{filters,setFilters,dbRev:0,bumpRev(){},seasons:[]}}><header className="border-b-2 border-line bg-bg-surface px-4 py-3 text-caption text-text-muted">SC2 Tools · Mechanics progress · synthetic local replay sample</header><main className="mx-auto min-w-0 max-w-5xl space-y-5 p-4 sm:p-6"><h1 className="font-display text-h2 font-bold">{location.pathname.includes('builds')?'Build stats':'Macro'}</h1>{location.pathname.includes('builds')?<BuildsTab/>:<MacroTab/>}</main></FiltersContext.Provider></ToastProvider></SWRConfig>}createRoot(document.getElementById('root')).render(<Preview/>);`);
  esbuild.build({ entryPoints: ['.tmp/mechanics-progress-entry.tsx'], bundle: true, outfile: '.tmp/mechanics-progress-fixture.js', alias: { '@': root }, jsx: 'automatic', minify: true,
    define: { 'process.env': '{}', 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_API_BASE': '"http://127.0.0.1:3220"' },
    plugins: [{ name: 'explicit-fixture-boundaries', setup(build) { build.onResolve({ filter: /.*/ }, args => boundaries[args.path] ? { path: args.path, namespace: 'fixture' } : undefined); build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: boundaries[args.path], loader: 'tsx', resolveDir: root })); } }], logLevel: 'warning',
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
