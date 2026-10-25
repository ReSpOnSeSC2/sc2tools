/* Real Dock consumers; synthetic loopback API, socket and chat-provider boundaries. */
const fs = require('node:fs'), esbuild = require('esbuild');
const root = process.cwd(); fs.mkdirSync('.tmp', { recursive: true });
const boundaries = {
  'next/link': `import React from'react';export default function Link({href,children,prefetch,...props}){return <a href={href} {...props}>{children}</a>}`,
  'next/image': `import React from'react';export default function Image({fill,priority,unoptimized,...props}){return <img {...props}/>} `,
  'next/navigation': `export function useRouter(){return{push:href=>location.assign(href),replace:href=>location.replace(href)}}export function usePathname(){return location.pathname}export function useSearchParams(){return new URLSearchParams(location.search)}`,
  '@clerk/nextjs': `export function useAuth(){return{isLoaded:true,isSignedIn:false,userId:null,getToken:async()=>null}}`,
  '@sentry/nextjs': 'export function captureException(){}export function captureMessage(){}export function addBreadcrumb(){}',
  'next/dynamic': `import React from'react';export default function dynamic(loader,options){const Lazy=React.lazy(()=>Promise.resolve(loader()).then(mod=>typeof mod==='function'?{default:mod}:mod));return props=><React.Suspense fallback={options?.loading?.()||null}><Lazy {...props}/></React.Suspense>}`,
  '@/lib/multichat/useMultiChat': `import{useSyncExternalStore}from'react';const now=Date.now();let state={messages:[{id:'one',platform:'twitch',user:'Aurora',text:'!1',atMs:now},{id:'two',platform:'kick',user:'Nova',text:'!2',atMs:now},{id:'three',platform:'youtube',user:'Sable',text:'Great hold at the natural!',atMs:now}],events:[],statuses:{twitch:{state:'connected'},kick:{state:'connecting'},youtube:{state:'offline'}},active:true};const subscribe=fn=>{addEventListener('fixture-chat',fn);return()=>removeEventListener('fixture-chat',fn)};export function useMultiChat(){return useSyncExternalStore(subscribe,()=>state)};window.fixtureChat=patch=>{state={...state,...patch};dispatchEvent(new Event('fixture-chat'))}`,
  'socket.io-client': `const sockets=[];window.fixtureStudio=state=>sockets.forEach(s=>s.fire('overlay:multichat',state));export function io(){const handlers=new Map();const s={connected:false,on(e,fn){if(!handlers.has(e))handlers.set(e,new Set());handlers.get(e).add(fn);return s},off(e,fn){if(!e)handlers.clear();else if(fn)handlers.get(e)?.delete(fn);else handlers.delete(e);return s},emit(){},connect(){s.connected=true;s.fire('connect')},disconnect(){s.connected=false},fire(e,...args){for(const fn of handlers.get(e)||[])fn(...args)}};sockets.push(s);return s}`,
};
fs.writeFileSync('.tmp/dock-polish-fixture.tsx', `import React from'react';import{createRoot}from'react-dom/client';import{DockClient}from'@/components/dock/DockClient';createRoot(document.getElementById('root')).render(<DockClient token="synthetic-dock-local"/>);`);
const plugin = { name: 'explicit-local-boundaries', setup(build) {
  build.onResolve({ filter: /.*/ }, args => boundaries[args.path] ? { path: args.path, namespace: 'fixture' } : undefined);
  build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'tsx', resolveDir: root, contents: boundaries[args.path] }));
} };
esbuild.build({ entryPoints: ['.tmp/dock-polish-fixture.tsx'], bundle: true, outfile: '.tmp/dock-polish-fixture.js', alias: { '@': root }, plugins: [plugin], jsx: 'automatic', define: { 'process.env': '{}', 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_API_BASE': '"http://127.0.0.1:3255"' }, logLevel: 'warning' }).catch(error => { console.error(error); process.exitCode = 1; });
