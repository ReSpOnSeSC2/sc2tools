/* Real game/card/player/Practice code. Framework/auth/socket transport are
 * explicit loopback-only boundaries; generated files stay disposable. */
const fs = require('node:fs'), esbuild = require('esbuild');
const root = process.cwd(); fs.mkdirSync('.tmp', { recursive: true });
fs.writeFileSync('.tmp/build-execution-data.ts', `export {executionFixture} from '@/components/analyzer/game/__tests__/buildExecutionFixtures';export {intent,confirmedResponse,opponentState} from '@/components/build-checkin/__tests__/cardFixtures';`);
esbuild.buildSync({ entryPoints: ['.tmp/build-execution-data.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: '.tmp/build-execution-data.cjs', alias: { '@': root }, logLevel: 'warning' });
const boundaries = {
  '@sentry/nextjs': `export function captureException(){}export function captureMessage(){}export function addBreadcrumb(){}`,
  'next/navigation': `const router={push(href){location.assign(href)},replace(href){history.replaceState(history.state,'',href)},prefetch(){}};export function useRouter(){return router}export function usePathname(){return location.pathname}export function useSearchParams(){return new URLSearchParams(location.search)}`,
  'next/link': `import React from'react';export default function Link({children,href,prefetch,scroll,replace,...props}){return <a href={href} {...props}>{children}</a>}`,
  'next/image': `import React from'react';export default function Image({fill,priority,unoptimized,loader,quality,src,...props}){return <img src={typeof src==='object'?src.src:src} {...props}/>} `,
  'next/dynamic': `import React from'react';export default function dynamic(loader,options){const Lazy=React.lazy(()=>Promise.resolve(loader()).then(mod=>typeof mod==='function'?{default:mod}:mod));return props=><React.Suspense fallback={options?.loading?.()||null}><Lazy {...props}/></React.Suspense>}`,
  '@clerk/nextjs': `import{useSyncExternalStore}from'react';let auth={isLoaded:true,isSignedIn:true,userId:'owner-a'};const subscribe=fn=>{addEventListener('fixture-auth',fn);return()=>removeEventListener('fixture-auth',fn)};const token=async()=>auth.userId;window.fixtureAuth=(userId,isLoaded=true)=>{auth={isLoaded,isSignedIn:!!userId,userId};dispatchEvent(new Event('fixture-auth'))};export function useAuth(){return{...useSyncExternalStore(subscribe,()=>auth),getToken:token}}export function useUser(){return{...useAuth(),user:{id:auth.userId,publicMetadata:{}}}}`,
  '@/lib/useUserSocket': `export function useUserSocket(){}`,
};
fs.writeFileSync('.tmp/build-execution-entry.tsx', `import React from'react';import{createRoot}from'react-dom/client';import{SWRConfig}from'swr';import{GameDetailPage}from'@/components/analyzer/game/GameDetailPage';import{BuildCheckInProvider}from'@/components/build-checkin/BuildCheckInProvider';const cache=new Map();function Preview(){return <SWRConfig value={{provider:()=>cache,shouldRetryOnError:false,revalidateOnFocus:false}}><header className='border-b-2 border-line bg-bg-surface px-4 py-3 text-caption'>SC2 Tools · synthetic private replay</header><main className='mx-auto max-w-7xl p-3 sm:p-7'><BuildCheckInProvider><GameDetailPage gameId={decodeURIComponent(location.pathname.split('/').pop())}/></BuildCheckInProvider></main></SWRConfig>}createRoot(document.getElementById('root')).render(<Preview/>);`);
const plugin = { name: 'explicit-local-boundaries', setup(build) {
  build.onResolve({ filter: /.*/ }, args => boundaries[args.path] ? { path: args.path, namespace: 'fixture' } : undefined);
  build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'tsx', resolveDir: root, contents: boundaries[args.path] }));
} };
esbuild.build({ entryPoints: ['.tmp/build-execution-entry.tsx'], bundle: true, outfile: '.tmp/build-execution-fixture.js', alias: { '@': root }, plugins: [plugin], jsx: 'automatic', define: { 'process.env': '{}', 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_API_BASE': '"http://127.0.0.1:3292"' }, logLevel: 'warning' }).catch(error => { console.error(error); process.exitCode = 1; });
