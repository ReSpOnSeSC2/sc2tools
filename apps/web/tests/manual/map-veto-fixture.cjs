// Production components/hooks with explicit synthetic auth and Next boundaries; local fixture API only.
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const root = process.cwd();
const cells = [
  { map: 'Ancient Cistern LE', matchup: 'vs Z', wins: 2, losses: 10, total: 13 },
  { map: 'Ancient Cistern LE', matchup: 'vs T', wins: 5, losses: 2, total: 7 },
  { map: 'Ruby Rock LE', matchup: 'vs Z', wins: 9, losses: 3, total: 12 },
  { map: 'Ruby Rock LE', matchup: 'vs P', wins: 4, losses: 3, total: 7 },
  { map: 'Sanctuary III LE', matchup: 'vs Z', wins: 0, losses: 4, total: 12 },
  { map: 'Custom Practice Map', matchup: 'vs T', wins: 5, losses: 0, total: 5 },
].map(row => ({ ...row, winRate: row.wins / row.total }));
const community = { computedAt: '2026-10-20T12:00:00Z', era: 'after', patch: '5.0.17', maps: cells.slice(0, 5).map((row, i) => ({ map: row.map, slug: `map-${i}`, games: 120, cells: [{ matchup: `Pv${row.matchup.at(-1)}`, games: 120, winRate: 0.54, ci: { low: 0.45, high: 0.62 } }] })) };
const guide = { published: true, map: 'Ancient Cistern', mapSlug: 'ancient-cistern', era: 'after', patch: '5.0.17', computedAt: community.computedAt, games: 120, matchups: [{ matchup: 'PvZ', slug: 'pvz', games: 120, users: 20, wins: 65, winRate: 0.54, ci: { low: 0.45, high: 0.62 }, openers: [] }] };
module.exports = { cells, community, guide };

if (require.main === module) {
  fs.mkdirSync('.tmp', { recursive: true });
  const boundaries = {
    'next/link': `import React from 'react';export default function Link({href,children,prefetch,onNavigate,...props}){return <a href={href} {...props}>{children}</a>}`,
    'next/image': `import React from 'react';export default function Image({fill,priority,unoptimized,loader,quality,...props}){return <img {...props}/>} `,
    'next/navigation': `export const useRouter=()=>({push:href=>location.assign(href),replace:href=>location.replace(href),prefetch(){}});export const usePathname=()=>location.pathname;export const useSearchParams=()=>new URLSearchParams(location.search);`,
    'next/dynamic': `import React from 'react';export default function dynamic(loader,options){const Lazy=React.lazy(()=>Promise.resolve(loader()).then(mod=>typeof mod==='function'?{default:mod}:mod));return props=><React.Suspense fallback={options?.loading?.()||null}><Lazy {...props}/></React.Suspense>}`,
    '@clerk/nextjs': `const signedIn=()=>!new URLSearchParams(location.search).has('signedOut');export const useAuth=()=>({isLoaded:true,isSignedIn:signedIn(),userId:signedIn()?'fixture-owner':null,getToken:async()=>'fixture-token'});export const useUser=()=>({isLoaded:true,isSignedIn:signedIn(),user:{id:'fixture-owner'}});export const SignedIn=({children})=>signedIn()?children:null;export const SignedOut=({children})=>signedIn()?null:children;`,
    '@sentry/nextjs': `export function captureException(){}export function captureMessage(){}export function addBreadcrumb(){}`,
  };
  fs.writeFileSync('.tmp/map-veto-entry.tsx', `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{SWRConfig}from'swr';import{FiltersContext}from'@/lib/filterContext';import{BattlefieldTab}from'@/components/analyzer/BattlefieldTab';import{GuideMapPersonalComparison}from'@/components/guides/map/GuideMapPersonalComparison';import{ToastProvider}from'@/components/ui/Toast';function Preview(){const[filters,setFilters]=useState({race:'P',since:'2026-10-01',map_pool:'ladder',game_size:'1v1'});return <SWRConfig value={{dedupingInterval:0,shouldRetryOnError:false}}><ToastProvider><FiltersContext.Provider value={{filters,setFilters,dbRev:0,bumpRev(){},seasons:[{number:70,isCurrent:true,start:'2026-09-15'}]}}><header className="border-b-2 border-line bg-bg-surface px-4 py-3 text-caption text-text-muted">SC2 Tools · Maps · synthetic local replay sample</header><main className="mx-auto min-w-0 max-w-7xl space-y-5 p-4 sm:p-6"><h1 className="font-display text-h2 font-bold text-text">{location.pathname.startsWith('/guides')?'Ancient Cistern map guide':'Maps'}</h1><output className="sr-only" aria-label="Applied global map">{filters.map||''}</output>{location.pathname.startsWith('/guides')?<GuideMapPersonalComparison payload={${JSON.stringify(guide)}}/>:<BattlefieldTab/>}</main></FiltersContext.Provider></ToastProvider></SWRConfig>}createRoot(document.getElementById('root')).render(<Preview/>);`);
  esbuild.build({ entryPoints: ['.tmp/map-veto-entry.tsx'], bundle: true, outfile: '.tmp/map-veto-fixture.js', alias: { '@': root }, jsx: 'automatic', minify: true,
    define: { 'process.env': '{}', 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_API_BASE': '"http://127.0.0.1:3218"', 'process.env.NEXT_PUBLIC_GUIDES_ENABLED': '"on"', 'process.env.NEXT_PUBLIC_REVIEWS_ENABLED': '"on"' },
    plugins: [{ name: 'explicit-auth-next-boundaries', setup(build) { build.onResolve({ filter: /.*/ }, args => boundaries[args.path] ? { path: args.path, namespace: 'fixture' } : undefined); build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: boundaries[args.path], loader: 'tsx', resolveDir: root })); } }], logLevel: 'warning',
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
