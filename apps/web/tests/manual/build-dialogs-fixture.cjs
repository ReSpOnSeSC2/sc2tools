/* Actual Library, dossier, launcher, editor, Practice and Help. Only framework,
 * auth/socket transport and unrelated MMR/mix panels are fixture boundaries. */
const fs = require('node:fs'), path = require('node:path'), esbuild = require('esbuild');
const buildDoc = {
  slug: 'dialog-opening', name: 'Synthetic private opener', race: 'Protoss', vsRace: 'Zerg',
  description: 'Synthetic recorded opening for local dialog checks.', notes: '', isPublic: false,
  rules: [{ type: 'count_min', name: 'BuildStargate', time_lt: 300, count: 1 }],
  winConditions: ['Keep producing'], losesTo: ['Early pressure'], transitionsInto: ['Ground army'],
  createdAt: '2026-10-20T12:00:00Z', updatedAt: '2026-10-20T12:00:00Z',
};
module.exports = { buildDoc };

if (require.main === module) {
  const root = process.cwd(), workspace = path.resolve(root, '../..');
  const host = path.resolve(process.env.BUILD_DIALOGS_HOST_DIR || '../../.cache/build-dialogs-current-host');
  if (!host.startsWith(path.join(workspace, '.cache') + path.sep)) throw new Error('Fixture host must stay inside this workspace cache');
  fs.mkdirSync(path.dirname(host), { recursive: true }); fs.mkdirSync(host);
  const boundaries = {
    'next/link': `import React from'react';export default function Link({href,children,prefetch,scroll,replace,...props}){return <a href={href} {...props}>{children}</a>}`,
    'next/image': `import React from'react';export default function Image({fill,priority,unoptimized,loader,quality,src,...props}){return <img src={typeof src==='object'?src.src:src} {...props}/>} `,
    'next/navigation': `const router={push:href=>location.assign(href),replace:href=>history.replaceState(null,'',href),prefetch(){}};export const useRouter=()=>router;export const usePathname=()=>location.pathname;export const useSearchParams=()=>new URLSearchParams(location.search);`,
    'next/dynamic': `import React from'react';export default function dynamic(loader,options){const Lazy=React.lazy(()=>Promise.resolve(loader()).then(mod=>typeof mod==='function'?{default:mod}:mod));return props=><React.Suspense fallback={options?.loading?.()||null}><Lazy {...props}/></React.Suspense>}`,
    '@clerk/nextjs': `import React,{useSyncExternalStore}from'react';let auth={isLoaded:true,isSignedIn:true,userId:'dialog-owner'};const token=async()=>auth.userId;const sub=f=>{addEventListener('fixture-auth',f);return()=>removeEventListener('fixture-auth',f)};window.fixtureAuth=(userId,isLoaded=true)=>{auth={userId,isLoaded,isSignedIn:!!userId};dispatchEvent(new Event('fixture-auth'))};export function useAuth(){return{...useSyncExternalStore(sub,()=>auth),getToken:token}}export function useUser(){return{...useAuth(),user:{id:auth.userId,publicMetadata:{}}}}export const SignedIn=({children})=>children,SignedOut=()=>null,ClerkLoading=()=>null,ClerkLoaded=({children})=>children;export function UserButton(){return <button type='button' aria-label='Fixture account'>J</button>}UserButton.MenuItems=({children})=>children;UserButton.Action=()=>null;UserButton.Link=()=>null;export function useClerk(){return{signOut:async()=>{}}}`,
    '@sentry/nextjs': `export function captureException(){}export function captureMessage(){}export function addBreadcrumb(){}`,
    '@/lib/useUserSocket': `export function useUserSocket(){}`,
  };
  for (const name of ['BuildMmrPanel', 'BuildAgingCurve', 'MmrProgressionByBuild']) boundaries[`./mmr/${name}`] = `export function ${name}(){return null}`;
  boundaries['./charts/MixOverTimeChart'] = 'export function MixOverTimeChart(){return null}';
  const entry = path.join(host, 'entry.tsx');
  fs.writeFileSync(entry, `import React from'react';import{createRoot}from'react-dom/client';import{SWRConfig}from'swr';import{AppChrome}from'@/components/chrome/AppChrome';import{ToastProvider}from'@/components/ui/Toast';import{BuildsLibrary}from'@/components/builds/BuildsLibrary';createRoot(document.getElementById('root')).render(<SWRConfig value={{provider:()=>new Map(),revalidateOnFocus:false,shouldRetryOnError:false}}><ToastProvider><AppChrome><div className='mx-auto max-w-5xl p-4'><BuildsLibrary/></div></AppChrome></ToastProvider></SWRConfig>);`);
  esbuild.build({ stdin: { contents: fs.readFileSync(entry, 'utf8'), resolveDir: root, sourcefile: entry, loader: 'tsx' }, bundle: true, outfile: path.join(host, 'fixture.js'), alias: { '@': root }, jsx: 'automatic', minify: true,
    define: { 'process.env': '{}', 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_API_BASE': '"http://127.0.0.1:3272"' },
    plugins: [{ name: 'explicit-dialog-fixture-boundaries', setup(build) {
      build.onResolve({ filter: /.*/ }, args => boundaries[args.path] ? { path: args.path, namespace: 'fixture' } : undefined);
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: boundaries[args.path], loader: 'tsx', resolveDir: root }));
    } }], logLevel: 'warning',
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
