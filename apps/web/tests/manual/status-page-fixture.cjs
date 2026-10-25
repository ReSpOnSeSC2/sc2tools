/* Real public route/components; only framework boundaries are synthetic. */
const path = require('node:path');
const { build } = require('esbuild');

async function compileStatusFixture(origin) {
  const root = path.resolve(__dirname, '../..');
  const boundaries = {
    'next/link': `import React from 'react';export default function Link({children,href,prefetch,scroll,onNavigate,...props}){return <a href={href} {...props}>{children}</a>}`,
    'next/navigation': `export function useRouter(){return{push(){throw Error('Unexpected navigation')},replace(){},prefetch(){}}}export function usePathname(){return '/status'}export function useSearchParams(){return new URLSearchParams()}`,
    'next/dynamic': `import React from 'react';export default function dynamic(loader,options){const Lazy=React.lazy(()=>Promise.resolve(loader()).then(mod=>typeof mod==='function'?{default:mod}:mod));return props=><React.Suspense fallback={options?.loading?.()||null}><Lazy {...props}/></React.Suspense>}`,
    '@sentry/nextjs': `export function captureException(){}export function captureMessage(){}export function addBreadcrumb(){}`,
    '@clerk/nextjs': `export function useAuth(){throw Error('Status must not read account authentication')}export function SignedOut(){throw Error('Status must not render an account boundary')}`,
  };
  const compiled = await build({
    stdin: { contents: `import React from 'react';import {createRoot}from'react-dom/client';import StatusPage from './app/status/page';createRoot(document.getElementById('root')).render(<React.StrictMode><StatusPage/></React.StrictMode>);`, resolveDir: root, sourcefile: 'status-page-fixture.tsx', loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', tsconfig: path.join(root, 'tsconfig.json'),
    define: { 'process.env': '{}', 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_API_BASE': JSON.stringify(origin) },
    plugins: [{ name: 'explicit-status-boundaries', setup(b) {
      b.onResolve({ filter: /.*/ }, args => boundaries[args.path] ? { path: args.path, namespace: 'status-fixture' } : undefined);
      b.onLoad({ filter: /.*/, namespace: 'status-fixture' }, args => ({ contents: boundaries[args.path], resolveDir: root, loader: 'jsx' }));
    } }],
  });
  return compiled.outputFiles[0].text;
}
module.exports = { compileStatusFixture };
