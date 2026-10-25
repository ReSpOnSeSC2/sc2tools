/* Actual Try/report/dialog/guide/sample components. Boundaries: Next, Clerk,
 * local persistence/session and delivery APIs. No engine or account writes. */
const fs = require('node:fs'), path = require('node:path'), { build } = require('esbuild');
const root = process.cwd(), out = path.resolve('../../.cache/try-conversion-host');
fs.mkdirSync(out, { recursive: true });
const sample = JSON.parse(fs.readFileSync('public/try/sample-payloads.json', 'utf8'));
const games = sample.games.map((game, i) => {
  const payload = { ...game, gameId: `local-fixture-${i}`, opponent: { ...game.opponent, displayName: i === 0 ? 'PRIVATE_FIXTURE_OPPONENT' : null } };
  return { gameId: payload.gameId, date: payload.date, engineVersion: sample.engineVersion, json: JSON.stringify(payload) };
});
const mocks = {
  'next/link': `import React from'react';export default function Link({children,prefetch,scroll,replace,...p}){return <a {...p}>{children}</a>}`,
  'next/image': `import React from'react';export default function Image({src,fill,priority,unoptimized,...p}){return <img src={typeof src==='string'?src:src.src} {...p}/>}`,
  'next/navigation': `export function useRouter(){return{push:href=>location.assign(href),replace:href=>location.replace(href)}}export function usePathname(){return location.pathname}export function useSearchParams(){return new URLSearchParams(location.search)}`,
  '@clerk/nextjs': `export function useAuth(){return{isLoaded:true,isSignedIn:false,userId:null,getToken:async()=>null}}export function useUser(){return{isLoaded:true,isSignedIn:false,user:null}}export function useClerk(){return{openSignIn(){},openSignUp(){}}}`,
  '@sentry/nextjs': 'export function captureException(){}export function captureMessage(){}export function addBreadcrumb(){}',
  '@/lib/instant/flag': `export function getInstantImportMode(){return new URLSearchParams(location.search).get('mode')||'all'}`,
  '@/lib/instant/useInstantImport': `export function useInstantImport(){const q=new URLSearchParams(location.search);return{enabled:q.get('admin')==='yes',loading:false}}`,
  '@/lib/instant/localStore': `export const TRY_TTL_DAYS=7;export async function loadTryGames(){return new URLSearchParams(location.search).get('case')==='empty'?[]:${JSON.stringify(games)}}export async function saveTryGames(){throw Error('Local fixture forbids persistence')}export async function clearTryData(){}`,
  '@/lib/instant/useInstantSession': `const idle={phase:'idle',files:[],parsed:[],parsedWithFiles:[],failed:[],truncatedCount:0,expanding:false,lastIntake:null,busy:false,dateWindow:{kind:'all'},estimate:null,progress:null,candidates:[],meMode:null,chosenToon:null,error:null,engineInfo:null,prewarm(){window.__warm++},reset(){},cancel(){},choose(){},setDateWindow(){},async addFiles(){throw Error('No parsing in conversion fixture')},async start(){throw Error('No parsing in conversion fixture')}};export function useInstantSession(){return idle}`,
};
const plugin = { name: 'local-conversion-boundaries', setup(builder) {
  builder.onResolve({ filter: /.*/ }, args => mocks[args.path] ? { path: args.path, namespace: 'fixture' } : undefined);
  builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'tsx', resolveDir: root, contents: mocks[args.path] }));
} };
const source = `import React from'react';import{createRoot}from'react-dom/client';import{TryPage}from'@/components/instant/TryPage';import{ReplayDemo}from'@/components/landing/ReplayDemo';import{BuildTimingsSection}from'@/components/guides/build/BuildTimingsSection';import{FIXTURE_BUILD_PUBLISHED}from'@/lib/guides/__fixtures__';import{GetYourOwnCTA}from'@/components/public-profile/GetYourOwnCTA';
const fixtureRoot=createRoot(document.getElementById('root'));
const links=[{name:'PvZ - Adept Glaives (Robo)',matchup:'PvZ',kind:'build',href:'/guides/pvz/adept-glaives-robo?utm_source=instant&utm_medium=report&utm_campaign=guides',key:'pvz/adept-glaives-robo'}];
function renderFixture(){const q=new URLSearchParams(location.search),surface=q.get('surface');fixtureRoot.render(<main className="mx-auto min-w-0 max-w-5xl p-3 sm:p-6">{surface==='landing'?<ReplayDemo/>:surface==='guide'?<BuildTimingsSection payload={FIXTURE_BUILD_PUBLISHED} blurb={[]}/>:surface==='cta'?<GetYourOwnCTA/>:<TryPage mode={q.get('mode')==='admins'?'admins':'all'} guideLinks={links}/>}</main>)}
renderFixture();window.fixtureNavigate=query=>{history.pushState(null,'',query);renderFixture()};`;
build({ stdin: { contents: source, sourcefile: 'try-conversion-host.tsx', resolveDir: root, loader: 'tsx' }, bundle: true,
  outdir: out, entryNames: 'fixture', chunkNames: 'chunk-[hash]', splitting: true, format: 'esm', alias: { '@': root }, plugins: [plugin], jsx: 'automatic',
  define: { 'process.env': '{}', 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_GUIDES_ENABLED': '"on"' }, logLevel: 'warning' }).catch(error => { console.error(error); process.exitCode = 1; });
