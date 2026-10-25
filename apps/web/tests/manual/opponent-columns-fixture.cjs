/* Actual list/picker/table/hooks; only Next, Clerk, and HTTP are synthetic. */
const path = require('node:path');
const esbuild = require('esbuild');

module.exports = async function buildOpponentColumnsFixture(root, origin) {
  const boundaries = {
    'next/link': `import React from 'react';
      export default function Link({href,children,prefetch,scroll,replace,onClick,...props}) {
        return <a href={href} {...props} onClick={event=>{
          onClick?.(event);
          if(!event.defaultPrevented&&event.button===0&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey&&String(href).startsWith('/')) {
            event.preventDefault();
            history[replace?'replaceState':'pushState']({},'',href);
            window.fixtureNavigation.push(String(href));
            dispatchEvent(new Event('fixture-navigation'));
          }
        }}>{children}</a>
      }`,
    'next/image': `import React from 'react';export default function Image({fill,priority,unoptimized,loader,quality,...props}){return <img {...props}/>}`,
    'next/navigation': `import {useSyncExternalStore} from 'react';
      const subscribe=fn=>{addEventListener('fixture-navigation',fn);addEventListener('popstate',fn);return()=>{removeEventListener('fixture-navigation',fn);removeEventListener('popstate',fn)}};
      const snapshot=()=>location.pathname+location.search+location.hash;
      const router={push(href){history.pushState({},'',href);window.fixtureNavigation.push(href);dispatchEvent(new Event('fixture-navigation'))},replace(href){history.replaceState(history.state,'',href);dispatchEvent(new Event('fixture-navigation'))},prefetch(href){window.fixturePrefetch.push(href)},back(){history.back()}};
      export function useRouter(){return router}
      export function usePathname(){useSyncExternalStore(subscribe,snapshot);return location.pathname}
      export function useSearchParams(){useSyncExternalStore(subscribe,snapshot);return new URLSearchParams(location.search)}`,
    'next/dynamic': `import React from 'react';export default function dynamic(loader,options){const Lazy=React.lazy(()=>Promise.resolve(loader()).then(mod=>typeof mod==='function'?{default:mod}:mod));return props=><React.Suspense fallback={options?.loading?.()||null}><Lazy {...props}/></React.Suspense>}`,
    '@clerk/nextjs': `import {useSyncExternalStore} from 'react';
      const subscribe=fn=>{addEventListener('fixture-auth',fn);return()=>removeEventListener('fixture-auth',fn)};
      const getToken=async()=>{window.fixtureTokenCalls++;return window.fixtureOwner||'columns-owner'};
      export function useAuth(){const userId=useSyncExternalStore(subscribe,()=>window.fixtureOwner||'columns-owner');return{isLoaded:true,isSignedIn:true,userId,getToken}}`,
  };
  const entry = `import React from 'react';import {createRoot} from 'react-dom/client';
    import {SWRConfig} from 'swr';import Link from 'next/link';import {usePathname} from 'next/navigation';
    import {FiltersContext} from '@/lib/filterContext';import {OpponentsRoute} from '@/components/analyzer/OpponentsRoute';
    window.fixtureNavigation=[];window.fixturePrefetch=[];window.fixtureDeliveries=[];window.fixtureTokenCalls=0;
    const nativeAnchorClick=HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click=function(){
      if(this.hostname==='replays.fixture.invalid'){
        window.fixtureDeliveries.push({href:this.href,filename:this.download,referrerPolicy:this.referrerPolicy,rel:this.rel});return;
      }
      return nativeAnchorClick.call(this);
    };
    function Fixture(){
      const pathname=usePathname(),cache=React.useMemo(()=>new Map(),[]);
      const [filters,setFilters]=React.useState({preset:'all',map_pool:'all',game_size:'all'}),[dbRev,bump]=React.useState(1);
      window.fixtureRefresh=()=>bump(value=>value+1);window.fixtureSetFilters=setFilters;
      const value=React.useMemo(()=>({filters,setFilters,dbRev,bumpRev:()=>bump(value=>value+1),seasons:[]}),[filters,dbRev]);
      return <React.StrictMode><SWRConfig value={{provider:()=>cache,shouldRetryOnError:false,revalidateOnFocus:false}}>
        <FiltersContext.Provider value={value}><main className="mx-auto min-w-0 max-w-7xl p-3 sm:p-6">
          <h1 className="mb-3 text-h2 font-semibold">Opponent columns · local fixture</h1>
          <nav className="mb-4 flex flex-wrap gap-3"><button id="reader" className="min-h-11 rounded border border-line px-3">Keep reading here</button><Link className="inline-flex min-h-11 items-center underline" href="/fixture-away">Leave list</Link></nav>
          {pathname==='/app/opponents'?<OpponentsRoute/>:<section aria-label="Synthetic destination" className="rounded-xl border-2 border-line bg-bg-surface p-4"><h2 className="text-h2">Synthetic destination</h2><p className="break-all">{pathname}</p><Link className="inline-flex min-h-11 items-center underline" href="/app/opponents">Return to opponents</Link></section>}
        </main></FiltersContext.Provider>
      </SWRConfig></React.StrictMode>
    }createRoot(document.getElementById('root')).render(<Fixture/>);`;
  const result = await esbuild.build({
    stdin: { contents: entry, resolveDir: root, sourcefile: 'opponent-columns-fixture.tsx', loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    tsconfig: path.join(root, 'tsconfig.json'), alias: { '@': root },
    define: { 'process.env': '{}', 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_API_BASE': JSON.stringify(origin) },
    plugins: [{ name: 'synthetic-platform-only', setup(build) {
      build.onResolve({ filter: /.*/ }, args => boundaries[args.path] ? { path: args.path, namespace: 'fixture' } : undefined);
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'tsx', resolveDir: root, contents: boundaries[args.path] }));
    } }], logLevel: 'warning',
  });
  return result.outputFiles[0].text;
};
