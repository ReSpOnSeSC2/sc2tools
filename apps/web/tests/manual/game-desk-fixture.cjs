/* Real Dock/widget consumers. Only Next, identity and provider chat boundaries
 * are synthetic; Socket.IO, rendering and Game Desk API controls are real. */
const fs = require('node:fs'), esbuild = require('esbuild');
const root = process.cwd(), origin = process.env.GAME_DESK_FIXTURE_ORIGIN;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin || '')) throw new Error('Loopback origin required');
fs.mkdirSync('.tmp', { recursive: true });
const boundaries = {
  'next/link': `import React from'react';export default function Link({children,prefetch,scroll,replace,...props}){return <a {...props}>{children}</a>}`,
  'next/image': `import React from'react';export default function Image({fill,priority,unoptimized,...props}){return <img {...props}/>} `,
  'next/navigation': `export function useRouter(){return{push:href=>location.assign(href),replace:href=>location.replace(href)}}export function usePathname(){return location.pathname}export function useSearchParams(){return new URLSearchParams(location.search)}`,
  '@clerk/nextjs': `export function useAuth(){return{isLoaded:true,isSignedIn:false,userId:null,getToken:async()=>null}}`,
  '@sentry/nextjs': 'export function captureException(){}export function captureMessage(){}export function addBreadcrumb(){}',
  'next/dynamic': `import React from'react';export default function dynamic(loader,options){const Lazy=React.lazy(()=>Promise.resolve(loader()).then(mod=>typeof mod==='function'?{default:mod}:mod));return props=><React.Suspense fallback={options?.loading?.()||null}><Lazy {...props}/></React.Suspense>}`,
  '@/lib/multichat/useMultiChat': `import{useSyncExternalStore}from'react';const state={messages:[{id:'one',platform:'twitch',user:'Aurora',text:'!win',atMs:Date.now()},{id:'two',platform:'kick',user:'Nova',text:'Great hold!',atMs:Date.now()}],events:[],statuses:{twitch:{state:'connected'},kick:{state:'offline'},youtube:{state:'offline'}},active:true};export function useMultiChat(){return useSyncExternalStore(()=>()=>{},()=>state)}`,
};
fs.writeFileSync('.tmp/game-desk-fixture.tsx', `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{DockClient}from'@/components/dock/DockClient';import{OverlayWidgetClient}from'@/components/OverlayWidgetClient';function Fixture(){const[token,setToken]=useState('synthetic-desk-a');window.fixtureOwner=setToken;const widget=new URLSearchParams(location.search).get('widget');return widget?<OverlayWidgetClient token={token} widget={widget}/>:<DockClient token={token}/>}createRoot(document.getElementById('root')).render(<Fixture/>);`);
const plugin = { name: 'explicit-local-boundaries', setup(build) {
  build.onResolve({ filter: /.*/ }, args => boundaries[args.path] ? { path: args.path, namespace: 'fixture' } : undefined);
  build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'tsx', resolveDir: root, contents: boundaries[args.path] }));
} };
esbuild.build({ entryPoints: ['.tmp/game-desk-fixture.tsx'], bundle: true, outfile: '.tmp/game-desk-fixture.js', alias: { '@': root }, plugins: [plugin], jsx: 'automatic', define: { 'process.env': '{}', 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_API_BASE': JSON.stringify(origin) }, logLevel: 'warning' }).catch(error => { console.error(error); process.exitCode = 1; });
