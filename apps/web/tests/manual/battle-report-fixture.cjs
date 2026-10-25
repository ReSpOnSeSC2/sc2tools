/* Synthetic local boundaries around real game/report components and authenticated SWR hooks.
 * Run from apps/web. No live account, provider or write operation is used.
 */
const fs = require('node:fs');
const esbuild = require('esbuild');
const root = process.cwd();
fs.mkdirSync('.tmp', { recursive: true });
fs.writeFileSync('.tmp/battle-report-data.ts', `export {reportFixtures} from '@/lib/battleReport/__tests__/fixtures'; export {intent,confirmedResponse,opponentState} from '@/components/build-checkin/__tests__/cardFixtures'; export {makeSegmentFixture} from '@/lib/__tests__/segmentedPlayback.fixture';`);
esbuild.buildSync({ entryPoints: ['.tmp/battle-report-data.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: '.tmp/battle-report-data.cjs', alias: { '@': root }, logLevel: 'warning' });
const boundaries = {
  '@sentry/nextjs': `export function captureException(){}export function captureMessage(){}export function addBreadcrumb(){}`,
  'next/navigation': `const router={push(href){location.assign(href)},replace(href){history.replaceState(history.state,'',href);dispatchEvent(new Event('fixture-navigation'))},prefetch(){}};export function useRouter(){return router}export function usePathname(){return location.pathname}export function useSearchParams(){return new URLSearchParams(location.search)}`,
  'next/link': `import React from'react';export default function Link({children,href,prefetch,scroll,replace,...props}){return <a href={href} {...props}>{children}</a>}`,
  'next/image': `import React from'react';export default function Image({fill,priority,unoptimized,loader,quality,...props}){return <img {...props}/>}`,
  'next/dynamic': `import React from'react';export default function dynamic(loader,options){const Lazy=React.lazy(()=>Promise.resolve(loader()).then(mod=>typeof mod==='function'?{default:mod}:mod));return props=><React.Suspense fallback={options?.loading?.()||null}><Lazy {...props}/></React.Suspense>}`,
  '@clerk/nextjs': `const auth={isLoaded:true,isSignedIn:true,userId:'synthetic-local-fixture',getToken:async()=> 'synthetic-local-token'};const user={isLoaded:true,isSignedIn:true,user:{id:auth.userId}};export function useAuth(){return auth}export function useUser(){return user}`,
  '@/lib/useUserSocket': `export function useUserSocket(){}`,
  '@/components/help/LazyHelpLink': `import React from'react';export function LazyHelpLink({slug,anchor,children,className}){return <a href={'/help/'+slug+(anchor?'#'+anchor:'')} className={className}>{children||'Help'}</a>}`,
};
fs.writeFileSync('.tmp/battle-report-fixture.tsx', `import React,{useState,useEffect}from'react';import{createRoot}from'react-dom/client';import{SWRConfig}from'swr';import{GameDetailPage}from'@/components/analyzer/game/GameDetailPage';import{BuildCheckInProvider}from'@/components/build-checkin/BuildCheckInProvider';function Preview(){const[time,setTime]=useState(()=>Number(new URLSearchParams(location.search).get('t'))||0);useEffect(()=>{const update=()=>setTime(Number(new URLSearchParams(location.search).get('t'))||0);addEventListener('fixture-navigation',update);return()=>removeEventListener('fixture-navigation',update)},[]);return <SWRConfig value={{provider:()=>new Map(),shouldRetryOnError:false,revalidateOnFocus:false}}><header className="sticky top-0 z-30 flex h-12 items-center border-b-2 border-line bg-bg-surface px-4 text-caption">SC2 Tools · synthetic local replay fixture</header><main className="mx-auto max-w-7xl p-3 sm:p-7"><BuildCheckInProvider><GameDetailPage gameId={decodeURIComponent(location.pathname.split('/').pop())} initialTimeSec={time}/></BuildCheckInProvider></main></SWRConfig>}createRoot(document.getElementById('root')).render(<Preview/>);`);
const plugin = { name: 'explicit-local-boundaries', setup(build) {
  build.onResolve({ filter: /.*/ }, args => boundaries[args.path] ? { path: args.path, namespace: 'fixture' } : undefined);
  build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'tsx', resolveDir: root, contents: boundaries[args.path] }));
} };
esbuild.build({ entryPoints: ['.tmp/battle-report-fixture.tsx'], bundle: true, outfile: '.tmp/battle-report-fixture.js', alias: { '@': root }, plugins: [plugin], jsx: 'automatic', define: { 'process.env': '{}', 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_API_BASE': '"http://127.0.0.1:3232"', 'process.env.NEXT_PUBLIC_REVIEWS_ENABLED': '"on"' }, logLevel: 'warning' }).catch(error => { console.error(error); process.exitCode = 1; });
