/* Real ChatCommandsCard + lazy editor, SWR, client API/deadline helpers, Toast
 * and on-stream command hook. Explicit synthetic Clerk/Next boundaries only.
 * Owner changes and held JWTs are fixture controls, never real account actions.
 * The bundle stays in memory; no production build/cache writes. */
const esbuild = require('esbuild');
module.exports = async function buildFixture() {
  const root = process.cwd();
  const boundaries = {
    '@clerk/nextjs': `import{useSyncExternalStore}from'react';let auth={userId:'A',isLoaded:true,isSignedIn:true};const sub=f=>{addEventListener('fixture-auth',f);return()=>removeEventListener('fixture-auth',f)};window.fixtureAuth=(userId,isLoaded=true)=>{auth={userId,isLoaded,isSignedIn:!!userId};dispatchEvent(new Event('fixture-auth'))};export function useAuth(){const value=useSyncExternalStore(sub,()=>auth);return{...value,getToken:async()=>window.fixtureHeldToken?await window.fixtureHeldToken:'synthetic-jwt-'+value.userId}}`,
    'next/link': `import React from'react';export default function Link({children,prefetch,scroll,replace,...props}){return <a {...props}>{children}</a>}`,
    '@sentry/nextjs': 'export function captureException(){}export function captureMessage(){}export function addBreadcrumb(){}',
  };
  const source = `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{SWRConfig}from'swr';import{useAuth}from'@clerk/nextjs';import{ChatCommandsCard}from'@/components/analyzer/settings/ChatCommandsCard';import{ToastProvider}from'@/components/ui/Toast';import{useCommandAnswers}from'@/lib/multichat/useCommandAnswers';const cache=new Map();function LiveAnswers({token}){const[messages,setMessages]=useState([]);window.fixtureMessage=text=>setMessages(current=>[...current,{id:String(Date.now()),text,user:'FixtureViewer',platform:'kick',badges:[],atMs:Date.now()}]);const answer=useCommandAnswers(messages,{apiBase:location.origin,token,enabled:true});return <output aria-label="Fixture live answer">{answer?answer.command+': '+answer.text:''}</output>}function App(){const auth=useAuth(),token='synthetic-overlay-'+auth.userId,publicGuide=location.pathname==='/help';return <SWRConfig value={{provider:()=>cache,revalidateOnFocus:false,shouldRetryOnError:false,dedupingInterval:0}}><ToastProvider><main className="mx-auto min-w-0 max-w-6xl space-y-5 p-3 sm:p-6"><header><p className="text-caption text-text-muted">Local browser proof</p><h1 className="text-h2 font-semibold">{publicGuide?'Viewer engagement':'Multi-platform chat'}</h1></header><ChatCommandsCard rankRace="protoss" editable={!publicGuide} token={publicGuide?undefined:token}/>{!publicGuide&&auth.isLoaded&&auth.isSignedIn?<LiveAnswers key={token} token={token}/>:null}</main></ToastProvider></SWRConfig>}createRoot(document.getElementById('root')).render(<App/>);`;
  const result = await esbuild.build({ stdin: { contents: source, loader: 'tsx', resolveDir: root }, bundle: true, write: false, alias: { '@': root }, jsx: 'automatic', minify: true,
    define: { 'process.env': '{}', 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_API_BASE': '"http://127.0.0.1:3269"' },
    plugins: [{ name: 'explicit-fixture-boundaries', setup(build) {
      build.onResolve({ filter: /.*/ }, args => boundaries[args.path] ? { path: args.path, namespace: 'fixture' } : undefined);
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'tsx', resolveDir: root, contents: boundaries[args.path] }));
    } }], logLevel: 'warning' });
  return result.outputFiles[0].text;
};
