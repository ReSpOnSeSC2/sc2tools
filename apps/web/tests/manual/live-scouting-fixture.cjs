/* Explicit Next/Clerk boundaries; real owner SSE and Dock Socket.IO consumers. */
const fs = require('node:fs'), esbuild = require('esbuild');
const root = process.cwd(); fs.mkdirSync('.tmp', { recursive: true });
const boundaries = {
  'next/link': `import React from'react';export default function Link({children,prefetch,scroll,replace,...props}){return <a {...props}>{children}</a>}`,
  'next/image': `import React from'react';export default function Image({fill,priority,unoptimized,...props}){return <img {...props}/>} `,
  'next/navigation': `export function useRouter(){return{push:href=>location.assign(href),replace:href=>location.replace(href)}}export function usePathname(){return location.pathname}export function useSearchParams(){return new URLSearchParams(location.search)}`,
  '@clerk/nextjs': `const auth={isLoaded:true,isSignedIn:true,userId:'synthetic-local-owner',sessionId:'synthetic-local-session',getToken:async()=> 'synthetic-local-token'};export function useAuth(){return auth}`,
  '@sentry/nextjs': 'export function captureException(){}export function captureMessage(){}export function addBreadcrumb(){}',
  'next/dynamic': `import React from'react';export default function dynamic(loader,options){const Lazy=React.lazy(()=>Promise.resolve(loader()).then(mod=>typeof mod==='function'?{default:mod}:mod));return props=><React.Suspense fallback={options?.loading?.()||null}><Lazy {...props}/></React.Suspense>}`,
};
fs.writeFileSync('.tmp/live-scouting-fixture.tsx', `import React from'react';import{createRoot}from'react-dom/client';import{LiveScoutingBrief}from'@/components/scouting/LiveScoutingBrief';import{LiveScoutingScreen}from'@/components/scouting/LiveScoutingScreen';import{DockClient}from'@/components/dock/DockClient';const dock=location.pathname.startsWith('/dock/');createRoot(document.getElementById('root')).render(dock?<DockClient token="synthetic-dock-local"/>:<main className="mx-auto max-w-6xl p-4 sm:p-6">{location.pathname==='/app/live'?<LiveScoutingScreen/>:<><h1 className="mb-5 text-h1">Today</h1><LiveScoutingBrief/></>}</main>);`);
const plugin = { name: 'explicit-local-boundaries', setup(build) {
  build.onResolve({ filter: /.*/ }, args => boundaries[args.path] ? { path: args.path, namespace: 'fixture' } : undefined);
  build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'tsx', resolveDir: root, contents: boundaries[args.path] }));
} };
esbuild.build({ entryPoints: ['.tmp/live-scouting-fixture.tsx'], bundle: true, outfile: '.tmp/live-scouting-fixture.js', alias: { '@': root }, plugins: [plugin], jsx: 'automatic', define: { 'process.env': '{}', 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_API_BASE': '"http://127.0.0.1:3253"' }, logLevel: 'warning' }).catch(error => { console.error(error); process.exitCode = 1; });
