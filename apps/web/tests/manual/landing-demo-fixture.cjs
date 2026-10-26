/* Real ReplayDemo/editor/session/worker. Boundaries are only local Next,
 * signed-out Clerk, analytics and the bundler's Worker URL construction. */
const fs = require('node:fs'), path = require('node:path'), esbuild = require('esbuild');
const root = process.cwd(), origin = process.env.LANDING_DEMO_FIXTURE_ORIGIN;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin || '')) throw Error('Loopback origin required');
fs.mkdirSync('.tmp', { recursive: true });
const boundaries = {
  'next/link': `import React from'react';export default function Link({children,prefetch,scroll,replace,...props}){return <a {...props}>{children}</a>}`,
  'next/image': `import React from'react';export default function Image({fill,priority,unoptimized,...props}){return <img {...props}/>} `,
  'next/navigation': `export function useRouter(){return{push:href=>location.assign(href),replace:href=>location.replace(href)}}export function usePathname(){return location.pathname}export function useSearchParams(){return new URLSearchParams(location.search)}`,
  'next/dynamic': `import React from'react';export default function dynamic(loader,options){const Lazy=React.lazy(()=>Promise.resolve(loader()).then(mod=>typeof mod==='function'?{default:mod}:mod));return props=><React.Suspense fallback={options?.loading?.()||null}><Lazy {...props}/></React.Suspense>}`,
  '@clerk/nextjs': `export function useAuth(){return{isLoaded:true,isSignedIn:false,userId:null,getToken:async()=>null}}export function useUser(){return{isLoaded:true,isSignedIn:false,user:null}}export function useClerk(){return{openSignIn(){},openSignUp(){}}}`,
  '@sentry/nextjs': 'export function captureException(){}export function captureMessage(){}export function addBreadcrumb(){}',
  '@/lib/analytics/gtag': 'export function gaEvent(){}export function gaPageView(){}',
  '@/lib/instant/flag': `export function getInstantImportMode(){return new URLSearchParams(location.search).get('mode')||'all'}`,
  '@/lib/instant/engineClient': `import{createEngineClient as real}from${JSON.stringify(path.join(root,'lib/instant/engineClient.ts'))};export function createEngineClient(options){return real({...options,workerFactory:()=>new Worker('/fixture-worker.js',{type:'module'})})}`,
};
const plugin = { name: 'local-demo-boundaries', setup(build) {
  build.onResolve({ filter: /.*/ }, args => {
    if (args.path === './engineClient' && args.resolveDir === path.join(root, 'lib/instant')) return { path: '@/lib/instant/engineClient', namespace: 'fixture' };
    return boundaries[args.path] ? { path: args.path, namespace: 'fixture' } : undefined;
  });
  build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'tsx', resolveDir: root, contents: boundaries[args.path] }));
} };
fs.writeFileSync('.tmp/landing-demo-fixture.tsx', `import React from'react';import{createRoot}from'react-dom/client';import{ReplayDemo}from'@/components/landing/ReplayDemo';import{TryExplainer}from'@/components/instant/TryExplainer';createRoot(document.getElementById('root')).render(<main className="mx-auto min-w-0 max-w-6xl p-3 sm:p-6">{location.pathname==='/try'?<TryExplainer/>:<ReplayDemo/>}</main>);`);
Promise.all([
  esbuild.build({ entryPoints: ['.tmp/landing-demo-fixture.tsx'], bundle: true, outfile: '.tmp/landing-demo-fixture.js', alias: { '@': root }, plugins: [plugin], jsx: 'automatic', define: { 'process.env': '{}', 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_API_BASE': JSON.stringify(origin) }, logLevel: 'warning' }),
  esbuild.build({ entryPoints: ['lib/instant/engineWorker.ts'], bundle: true, format: 'esm', outfile: '.tmp/landing-demo-worker.js', alias: { '@': root }, define: { 'process.env': '{}', 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning' }),
]).catch(error => { console.error(error); process.exitCode = 1; });
