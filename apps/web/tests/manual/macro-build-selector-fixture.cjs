/* Actual Macro surfaces, check-in card, picker, editor and clientApi/SWR.
 * Only framework/auth/realtime boundaries are synthetic; API is loopback-only. */
const fs = require('node:fs'), esbuild = require('esbuild');
const root = process.cwd(), origin = process.env.MACRO_BUILD_FIXTURE_ORIGIN;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin || '')) throw new Error('Loopback origin required');
fs.mkdirSync('.cache', { recursive: true });
const boundaries = {
  'next/link': `import React from'react';export default function Link({children,prefetch,scroll,replace,...props}){return <a {...props}>{children}</a>}`,
  'next/image': `import React from'react';export default function Image({fill,priority,unoptimized,...props}){return <img {...props}/>} `,
  'next/navigation': `export function useRouter(){return{push(){},replace(){}}}export function usePathname(){return'/app/game/g1'}export function useSearchParams(){return new URLSearchParams()}`,
  'next/dynamic': `import React from'react';export default function dynamic(loader,options){const Lazy=React.lazy(()=>Promise.resolve(loader()).then(mod=>typeof mod==='function'?{default:mod}:mod));return props=><React.Suspense fallback={options?.loading?.({isLoading:true})||null}><Lazy {...props}/></React.Suspense>}`,
  '@clerk/nextjs': `import{useSyncExternalStore}from'react';let state={isLoaded:true,isSignedIn:true,userId:'synthetic-a'};const sub=fn=>{addEventListener('fixture-auth',fn);return()=>removeEventListener('fixture-auth',fn)};const getToken=async()=>state.userId;window.fixtureAuth=id=>{state={isLoaded:true,isSignedIn:!!id,userId:id};dispatchEvent(new Event('fixture-auth'))};export function useAuth(){return{...useSyncExternalStore(sub,()=>state),getToken}}`,
  '@sentry/nextjs': 'export function captureException(){}export function captureMessage(){}export function addBreadcrumb(){}',
  '@/lib/useUserSocket': 'export function useUserSocket(){}',
  '@/lib/useMapReplay': 'export function useMapReplay(){return{completedRequestId:null}}',
};
const entry = `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{SWRConfig}from'swr';import{ToastProvider}from'@/components/ui/Toast';import{BuildCheckInProvider}from'@/components/build-checkin/BuildCheckInProvider';import{MacroBreakdownPanel}from'@/components/analyzer/macro/MacroBreakdownPanel';import{GameMacroSection}from'@/components/analyzer/game/GameMacroSection';function Fixture(){const[game,setGame]=useState('g1'),[open,setOpen]=useState(true);window.fixtureGame=setGame;const modal=new URLSearchParams(location.search).get('surface')==='modal';return <SWRConfig value={{provider:()=>new Map(),shouldRetryOnError:false,revalidateOnFocus:false}}><ToastProvider><BuildCheckInProvider><main className="mx-auto min-w-0 max-w-5xl space-y-4 p-3 sm:p-6"><h1 className="text-h2">Game Macro</h1>{modal?<><button onClick={()=>setOpen(true)}>Open Macro</button><MacroBreakdownPanel open={open} onClose={()=>setOpen(false)} gameId={game}/></>:<GameMacroSection gameId={game} data={null} loading={false} onRetry={()=>{}} action={null} onRecompute={()=>{}} recomputing={false} headerMeta={{}} onBuildChanged={()=>{window.fixtureChanges=(window.fixtureChanges||0)+1}}/>}</main></BuildCheckInProvider></ToastProvider></SWRConfig>}createRoot(document.getElementById('root')).render(<Fixture/>);`;
const plugin = { name: 'local-framework-boundaries', setup(build) {
  build.onResolve({ filter: /.*/ }, args => boundaries[args.path] ? { path: args.path, namespace: 'fixture' } : undefined);
  build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'tsx', resolveDir: root, contents: boundaries[args.path] }));
} };
esbuild.build({ stdin: { contents: entry, loader: 'tsx', resolveDir: root }, bundle: true, outfile: '.cache/macro-build-selector-fixture.js', alias: { '@': root }, plugins: [plugin], jsx: 'automatic', define: { 'process.env': '{}', 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_API_BASE': JSON.stringify(origin) }, logLevel: 'warning' }).catch(error => { console.error(error); process.exitCode = 1; });
