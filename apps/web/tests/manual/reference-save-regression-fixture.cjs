/* Synthetic auth/Next boundaries only. Editor, SWR, clientApi, saved-build
 * launcher and API validators are the shipping modules. All storage is local. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const esbuild = require('esbuild');
const { validateReferenceBuildOrder } = require('../../../api/src/validation/referenceBuildOrder');
const { validateCustomBuild } = require('../../../api/src/validation/customBuild');

const GAME_ID = "2026-10-25T22:51:33|Tester Ω|Eternity's Edge / LE|492";
const OWNER = 'synthetic-a';
const sha = value => createHash('sha256').update(value).digest('hex');
const ENTRY = String.raw`
import React,{useState}from'react';
import{createRoot}from'react-dom/client';
import{SWRConfig}from'swr';
import{ToastProvider}from'@/components/ui/Toast';
import{Button}from'@/components/ui/Button';
import{BuildEditorModal}from'@/components/builds/editor/BuildEditorModal';
import{EditCustomBuildLauncher}from'@/components/builds/EditCustomBuildLauncher';
const gameId=${JSON.stringify(GAME_ID)};
const rules=[{type:'before',name:'BuildPylon',time_lt:175,proxy:true},{type:'count_min',name:'TrainStalker',count:8,time_lt:205},{type:'count_exact',name:'BuildWarpGate',count:2,time_lt:220}];
const events=[{time:0,name:'Nexus',is_building:true,supply:12},{time:18,name:'Pylon',is_building:true,supply:14,supplyApprox:true},{time:66,name:'Gateway',is_building:true,supply:16},{time:118,name:'Stalker',category:'unit',supply:20}];
const cache=new Map(),provider=()=>cache;
function App(){const[open,setOpen]=useState(false),[edit,setEdit]=useState(false),[saved,setSaved]=useState(null),[serial,setSerial]=useState(0);
 return <SWRConfig value={{provider,shouldRetryOnError:false,revalidateOnFocus:false,revalidateOnReconnect:false}}><ToastProvider>
 <main className="mx-auto min-w-0 max-w-6xl space-y-4 p-4 text-text"><h1 className="font-display text-h2">Reference build save verification</h1>
 <p className="text-caption text-text-muted">Synthetic replay and disposable loopback storage.</p>
 <div className="flex flex-wrap gap-3"><Button onClick={()=>{setSerial(value=>value+1);setOpen(true)}}>Create source build</Button>{saved?<Button onClick={()=>setEdit(true)}>Edit saved build</Button>:null}</div>
 {saved?<section aria-label="Saved build" className="space-y-3 rounded-lg border border-border p-4"><h2 className="text-h3">{saved.name}</h2><p>Saved reference steps: {saved.buildOrder.steps.length}</p></section>:null}
 {open?<BuildEditorModal key={serial} open onClose={()=>setOpen(false)} events={events} gameId={gameId} race="Protoss" vsRace="Protoss" defaultName={'PvP — 8 gate Stalker Pressure '+window.referenceCase+' '+serial} initialDraft={{rules}} createOnly onSaved={(slug,draft)=>{setSaved({...draft,slug});setOpen(false)}}/>:null}
 {edit&&saved?<EditCustomBuildLauncher build={saved} onClose={()=>setEdit(false)} onSaved={build=>{setSaved(current=>({...current,...build}));setEdit(false)}}/>:null}
 </main></ToastProvider></SWRConfig>}
createRoot(document.getElementById('root')).render(<App/>);
`;

const BOUNDARIES = {
  'next/link': "import React from'react';export default function Link({children,prefetch,scroll,replace,...props}){return <a {...props}>{children}</a>}",
  'next/image': "import React from'react';export default function Image({fill,priority,unoptimized,...props}){return <img {...props}/>}",
  'next/navigation': "export function useRouter(){return{push:href=>location.assign(href),replace:href=>location.replace(href)}}export function usePathname(){return location.pathname}export function useSearchParams(){return new URLSearchParams(location.search)}",
  '@clerk/nextjs': `const getToken=async()=>${JSON.stringify(OWNER)};export function useAuth(){return{isLoaded:true,isSignedIn:true,userId:${JSON.stringify(OWNER)},getToken}}`,
  '@sentry/nextjs': 'export function captureException(){}export function captureMessage(){}export function addBreadcrumb(){}',
};

function readOwnAppearance(root) {
  if (!fs.existsSync(path.join(root, '.next', 'BUILD_ID'))) throw new Error('Own production build required');
  const cssRoot = path.join(root, '.next', 'static', 'css');
  const cssFiles = fs.readdirSync(cssRoot, { recursive: true }).filter(name => name.endsWith('.css')).sort();
  if (!cssFiles.length) throw new Error('Own production CSS required');
  const css = cssFiles.map(name => fs.readFileSync(path.join(cssRoot, name), 'utf8')).join('\n');
  const fonts = "@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay}";
  return { root, cssRoot, cssFiles, css, fonts, bundle: undefined };
}
const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
async function readApiRequest(req) {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 128000) throw new Error('Fixture request bound exceeded'); chunks.push(chunk); }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      const owner = String(req.headers.authorization || '').replace(/^Bearer /, '');
      return { body, owner };
}
function recordApiRequest(req, url, state, { body, owner }) {
      const call = { method: req.method, path: url.pathname, query: url.search, owner, body, status: null };
      if (state.calls.length >= 256) throw new Error('Fixture request ledger bound exceeded');
      state.calls.push(call);
      return call;
}
function storeCustomBuild(call, state, { slug, key }, reply) {
          const { body } = call;
          const reference = validateReferenceBuildOrder(body?.buildOrder);
          const validated = validateCustomBuild({ ...body, slug });
          call.referenceValid = reference.valid; call.customBuildValid = validated.valid;
          if (!reference.valid || !validated.valid) return reply(400, { error: 'validation_error', details: reference.errors || validated.errors });
          if (body.createOnly && state.saved.has(key)) return reply(409, { error: 'slug_taken' });
          state.saved.set(key, validated.value);
          return reply(200, { saved: true, reclassify: body.reclassify ? { status: 'queued', generation: 'synthetic-local-only' } : null });
}
function serveCustomBuild(call, state, reply) {
        const { path: endpoint, owner } = call;
        const slug = decodeURIComponent(endpoint.slice('/v1/custom-builds/'.length)), key = `${owner}:${slug}`;
        if (call.method === 'PUT') return storeCustomBuild(call, state, { slug, key }, reply);
        if (call.method === 'GET') return reply(state.saved.has(key) ? 200 : 404, state.saved.get(key) || { error: 'not_found' });
        state.unexpected.push({ method: call.method, endpoint }); return reply(404, { error: 'unhandled_fixture_route' });
}
async function serveApi(req, res, url, state) {
      const endpoint = url.pathname, parsed = await readApiRequest(req);
      const call = recordApiRequest(req, url, state, parsed), { owner } = parsed;
      const reply = (status, value) => { call.status = status; send(res, status, value); };
      if (![OWNER, 'synthetic-b'].includes(owner)) return reply(401, { error: 'unauthorized' });
      if (endpoint === '/v1/me/profile') return reply(200, { displayName: 'Synthetic owner' });
      if (endpoint === '/v1/custom-builds/preview-matches') return reply(200, { matches: [], almost_matches: [], scanned_games: 157, truncated: false });
      if (endpoint.startsWith('/v1/community/my-build-publication/')) return reply(200, { published: false, authorName: 'Synthetic owner', publishAnonymously: false, mirrorPending: false });
      if (endpoint.startsWith('/v1/custom-builds/')) return serveCustomBuild(call, state, reply);
      state.unexpected.push({ method: req.method, endpoint }); return reply(404, { error: 'unhandled_fixture_route' });
}
function serveStatic(res, url, appearance) {
    const endpoint = url.pathname, { root, css, fonts, bundle } = appearance;
    if (endpoint === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(bundle); }
    if (endpoint === '/fixture') {
      const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
      const caseName = String(url.searchParams.get('case') || 'case').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(`<!doctype html><html lang="en" data-theme="${theme}"><head><title>Reference save verification</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${fonts}</style></head><body><div id="root"></div><script>window.referenceCase=${JSON.stringify(caseName)}</script><script src="/fixture.js"></script></body></html>`);
    }
    if (endpoint === '/favicon.ico') { res.statusCode = 204; return res.end(); }
    const base = endpoint.startsWith('/fonts/') ? path.join(root, 'app', 'fonts') : path.join(root, 'public');
    const file = path.resolve(base, endpoint.startsWith('/fonts/') ? endpoint.slice(7) : endpoint.slice(1));
    if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', ({ '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' })[path.extname(file)] || 'application/octet-stream');
    return res.end(fs.readFileSync(file));
}
function createFixtureServer(state, appearance) {
  const server = http.createServer((req, res) => { void (async () => {
    const url = new URL(req.url, state.origin || 'http://127.0.0.1');
    return url.pathname.startsWith('/v1/') ? serveApi(req, res, url, state) : serveStatic(res, url, appearance);
  })().catch(error => { state.serverErrors.push(String(error.stack || error)); if (!res.headersSent) send(res, 500, { error: 'fixture_failure' }); else res.destroy(error); }); });
  server.on('connection', socket => { state.sockets.add(socket); socket.on('close', () => state.sockets.delete(socket)); });
  return server;
}
async function closeFixtureServer(server, state) {
    if (state.closed) return;
    state.closed = true;
    const closed = Array.from(state.sockets, socket => new Promise(resolve => {
      if (socket.closed) return resolve();
      socket.once('close', resolve);
      socket.destroy();
    }));
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await Promise.all(closed);
}
async function bundleReferenceEditor(root, origin, artifacts) {
    const define = { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_API_BASE': JSON.stringify(origin),
      'process.env.NEXT_PUBLIC_GUIDES_ENABLED': '"on"', 'process.env.NEXT_PUBLIC_REVIEWS_ENABLED': '"on"', 'process.env.NEXT_PUBLIC_INSTANT_IMPORT': '"all"',
      'process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID': 'undefined', 'process.env.NEXT_PUBLIC_BUILD_SHA': 'undefined', 'process.env.NEXT_PUBLIC_SENTRY_DSN': 'undefined',
      'process.env.NEXT_PUBLIC_SC2TOOLS_ENV': 'undefined', 'process.env.NEXT_PUBLIC_SPRITE_BASE': 'undefined', 'process.env.NEXT_PUBLIC_AUDIO_BASE': 'undefined' };
    const plugin = { name: 'explicit-auth-next-boundaries', setup(build) {
      build.onResolve({ filter: /.*/ }, args => BOUNDARIES[args.path] ? { path: args.path, namespace: 'reference-fixture' } : undefined);
      build.onLoad({ filter: /.*/, namespace: 'reference-fixture' }, args => ({ contents: BOUNDARIES[args.path], loader: 'tsx', resolveDir: root }));
    } };
    const built = await esbuild.build({ stdin: { contents: ENTRY, resolveDir: root, sourcefile: 'reference-save-regression-entry.tsx', loader: 'tsx' }, bundle: true, write: false,
      outfile: path.join(artifacts, 'fixture.js'), alias: { '@': root }, plugins: [plugin], jsx: 'automatic', define, metafile: true, logLevel: 'warning' });
    const bundle = built.outputFiles[0].contents;
    fs.writeFileSync(path.join(artifacts, 'fixture.js'), bundle, { flag: 'wx' });
    fs.writeFileSync(path.join(artifacts, 'fixture-metafile.json'), JSON.stringify(built.metafile, null, 2), { flag: 'wx' });
    return { bundle, define };
}
function writeFixtureReceipt(appearance, define, artifacts) {
    const { root, bundle, cssRoot, cssFiles } = appearance;
    const receipt = { gameId: GAME_ID, buildId: fs.readFileSync(path.join(root, '.next', 'BUILD_ID'), 'utf8').trim(), bundleSha256: sha(bundle),
      css: cssFiles.map(name => ({ name, sha256: sha(fs.readFileSync(path.join(cssRoot, name))) })), boundaries: Object.keys(BOUNDARIES), defines: define,
      limitations: ['Loopback storage and synthetic auth/Next/Sentry boundaries; not production HTTP/auth acceptance.', 'Actual API field validators run; the Express service, MongoDB and background replay-matching worker do not run.'] };
    fs.writeFileSync(path.join(artifacts, 'fixture-receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
    return receipt;
}
async function prepareReferenceSaveFixture(artifacts) {
  const root = process.cwd(), appearance = readOwnAppearance(root);
  const state = { calls: [], unexpected: [], serverErrors: [], saved: new Map(), sockets: new Set(), origin: '', closed: false };
  const server = createFixtureServer(state, appearance), close = () => closeFixtureServer(server, state);
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    state.origin = `http://127.0.0.1:${server.address().port}`;
    const { bundle, define } = await bundleReferenceEditor(root, state.origin, artifacts);
    appearance.bundle = bundle;
    const receipt = writeFixtureReceipt(appearance, define, artifacts);
    return { state, receipt, close, listening: () => server.listening };
  } catch (error) { await close(); throw error; }
}
module.exports = { prepareReferenceSaveFixture, GAME_ID, OWNER };
