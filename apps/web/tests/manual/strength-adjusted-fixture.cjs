/* Actual analyzer consumers and fetch hooks. Synthetic auth/Next, unrelated
 * MMR panels and the map-veto planner are explicit fixture boundaries. */
const fs = require('node:fs'), esbuild = require('esbuild');
const root = process.cwd();
const model = { method: 'calibrated', eloScale: 400, sampleGames: 2400, supportedBins: 8 };
const rows = [
  { name: 'Blink pressure', total: 18, wins: 12, losses: 6, winRate: 12/18, ratedGames: 14, ratedWins: 8, expectedWins: 7.25, winsAboveExpected: .75, perfRating: 4120, excludedNoMmr: 4, excludedIneligible: 0, winRateRange: { low: .437, high: .837 }, expectation: model },
  { name: 'Gateway expansion', total: 8, wins: 3, losses: 5, winRate: 3/8, ratedGames: 6, ratedWins: 1, expectedWins: 3.5, winsAboveExpected: -2.5, perfRating: 3970, excludedNoMmr: 2, excludedIneligible: 0, winRateRange: { low: .137, high: .694 }, expectation: model },
  { name: 'Unrecorded opener', total: 5, wins: 3, losses: 2, winRate: .6, ratedGames: 0, ratedWins: 0, expectedWins: null, winsAboveExpected: null, perfRating: null, excludedNoMmr: 5, excludedIneligible: 0, winRateRange: { low: .231, high: .882 }, expectation: model },
  { name: 'Stargate follow-up with a deliberately long saved build name', total: 10, wins: 10, losses: 0, winRate: 1, ratedGames: 10, ratedWins: 10, expectedWins: 6, winsAboveExpected: 4, perfRating: null, excludedNoMmr: 0, excludedIneligible: 0, winRateRange: { low: .722, high: 1 }, expectation: model },
];
const ratings = ['PvZ','PvT'].map((matchup, pair) => ({ matchup, totalGames: 65, sampleGames: 16, windowGames: 10, ratedGames: 14, excludedNoMmr: 2, perfRating: 4120 + pair*120,
  points: Array.from({ length: 16 }, (_, i) => ({ date: new Date(Date.UTC(2026,9,1+i)).toISOString(), games: Math.min(i+1,10), ratedGames: Math.max(1,Math.min(i+1,10)-1), excludedNoMmr: i ? 1 : 0, perfRating: i < 2 || i === 9 || i === 15 ? null : 4000 + i*14 + pair*120 })), expectation: model,
}));
module.exports = { rows, ratings };
if (require.main === module) {
  const boundaries = {
    'next/link': `import React from'react';export default function Link({href,children,prefetch,...props}){return <a href={href} {...props}>{children}</a>}`,
    'next/image': `import React from'react';export default function Image({fill,priority,unoptimized,loader,quality,...props}){return <img {...props}/>} `,
    'next/navigation': `export const useRouter=()=>({push:href=>location.assign(href),replace:href=>history.replaceState(null,'',href),prefetch(){}});export const usePathname=()=>location.pathname;export const useSearchParams=()=>new URLSearchParams(location.search);`,
    'next/dynamic': `import React from'react';export default function dynamic(loader,options){const Lazy=React.lazy(()=>Promise.resolve(loader()).then(mod=>typeof mod==='function'?{default:mod}:mod));return props=><React.Suspense fallback={options?.loading?.()||null}><Lazy {...props}/></React.Suspense>}`,
    '@clerk/nextjs': `export const useAuth=()=>({isLoaded:true,isSignedIn:true,userId:'fixture-owner',getToken:async()=>'fixture-token'});export const useUser=()=>({isLoaded:true,isSignedIn:true,user:{id:'fixture-owner'}});`,
    '@sentry/nextjs': `export function captureException(){}export function captureMessage(){}export function addBreadcrumb(){}`,
    './maps/MapVetoPlanner': `export function MapVetoPlanner(){return null}`,
    './BuildEditorModal': `export function BuildEditorModal(){return null}`,
  };
  for (const name of ['BuildMmrPanel','BuildAgingCurve','MmrProgressionByBuild']) boundaries[`./mmr/${name}`] = `export function ${name}(){return null}`;
  fs.mkdirSync('.tmp', { recursive: true });
  fs.writeFileSync('.tmp/strength-adjusted-entry.tsx', `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{SWRConfig}from'swr';import{FiltersContext}from'@/lib/filterContext';import{BuildsTab}from'@/components/analyzer/BuildsTab';import{StrategiesTab}from'@/components/analyzer/StrategiesTab';import{BattlefieldTab}from'@/components/analyzer/BattlefieldTab';import{MatchupRatingCard}from'@/components/analyzer/charts/MatchupRatingCard';import{MatchupOverTimeChart}from'@/components/analyzer/charts/MatchupOverTimeChart';import{ToastProvider}from'@/components/ui/Toast';function Preview(){const[filters,setFilters]=useState({race:'P',since:'2026-09-01',map_pool:'ladder',game_size:'1v1'});const section=location.pathname.split('/').pop();return <SWRConfig value={{dedupingInterval:60000,shouldRetryOnError:false}}><ToastProvider><FiltersContext.Provider value={{filters,setFilters,dbRev:0,bumpRev(){},seasons:[]}}><header className="border-b-2 border-line bg-bg-surface px-4 py-3 text-caption text-text-muted">SC2 Tools · Results given who you played · synthetic local sample</header><main id="strength-main" className="mx-auto min-w-0 max-w-6xl space-y-5 p-4 sm:p-6"><h1 className="font-display text-h2 font-bold">{section==='builds'?'Build stats':section==='strategies'?'Strategies':section==='maps'?'Battlefield':'Trends'}</h1>{section==='builds'?<BuildsTab/>:section==='strategies'?<StrategiesTab/>:section==='maps'?<BattlefieldTab/>:<><MatchupRatingCard/><MatchupOverTimeChart bucket="day"/></>}</main></FiltersContext.Provider></ToastProvider></SWRConfig>}createRoot(document.getElementById('root')).render(<Preview/>);`);
  esbuild.build({ entryPoints: ['.tmp/strength-adjusted-entry.tsx'], bundle: true, outfile: '.tmp/strength-adjusted-fixture.js', alias: { '@': root }, jsx: 'automatic', minify: true,
    define: { 'process.env': '{}', 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_API_BASE': '"http://127.0.0.1:3224"' },
    plugins: [{ name: 'explicit-fixture-boundaries', setup(build) { build.onResolve({ filter: /.*/ }, args => boundaries[args.path] ? { path: args.path, namespace: 'fixture' } : undefined); build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: boundaries[args.path], loader: 'tsx', resolveDir: root })); } }], logLevel: 'warning',
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
