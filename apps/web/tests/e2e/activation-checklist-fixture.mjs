import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

let server, origin = "", active;
const connections = new Set(), serverRequests = [];

function parseBody(body) { try { return JSON.parse(body); } catch { return null; } }
function isTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

// Only the host, authentication, framework and transport are synthetic. The
// checklist, marker hook, useApi, SWR, Help, Modal and Toast are actual source.
const SOURCE = `import React,{useSyncExternalStore}from'react';import{createRoot}from'react-dom/client';import{SWRConfig,useSWRConfig,unstable_serialize}from'swr';
import{LevelUpChecklist}from'@/components/onboarding/LevelUpChecklist';import{useFirstGameViewed}from'@/components/onboarding/useFirstGameViewed';import{useApi}from'@/lib/clientApi';import{ACTIVATION_PATH}from'@/lib/activation';import{ToastProvider}from'@/components/ui/Toast';import{getArticle}from'@/lib/help';
if(!getArticle('your-first-week'))throw new Error('Generate the canonical Help index before activation browser proof');
const subscribe=(listener:()=>void)=>{for(const event of ['activation-change','popstate','hashchange'])addEventListener(event,listener);return()=>{for(const event of ['activation-change','popstate','hashchange'])removeEventListener(event,listener)}};
let owner:string|null='owner-a',game:string|null=null,card=true,revision=0;const pushes:string[]=[],tokens:unknown[]=[],tokenReleases:(()=>void)[]=[],bodyReleases:(()=>void)[]=[],bodyHolds:string[]=[];let holdToken=false;
const change=()=>{revision++;dispatchEvent(new Event('activation-change'))};
Object.assign(window,{activationOwner:()=>owner,activationSetOwner:(value:string|null)=>{if(value!==null&&!['owner-a','owner-b'].includes(value))throw new Error('Unadmitted owner');owner=value;change()},activationShowGame:(value:string|null)=>{if(value!==null&&!['game-one','game-two'].includes(value))throw new Error('Unadmitted game');game=value;change()},activationShowCard:(value:boolean)=>{card=value;change()},activationNavigate:(href:string)=>{history.pushState({},'',href);change()},activationPush:(href:string)=>{pushes.push(href);history.pushState({},'',href);change()},activationPushes:()=>pushes.slice(),activationHoldNextToken:()=>{holdToken=true},activationTokenEvents:()=>tokens.slice(),activationReleaseTokens:()=>tokenReleases.splice(0).forEach(release=>release()),activationHoldNextBody:(pathname:string)=>bodyHolds.push(pathname),activationReleaseBodies:()=>bodyReleases.splice(0).forEach(release=>release()),activationGetToken:async(issuingOwner:string)=>{const event={owner:issuingOwner,held:holdToken,released:!holdToken};tokens.push(event);if(holdToken){holdToken=false;await new Promise<void>(resolve=>tokenReleases.push(()=>{event.released=true;resolve()}))}return'fixture-'+issuingOwner}});
const nativeFetch=window.fetch.bind(window);window.fetch=async(input,init)=>{const response=await nativeFetch(input,init),pathname=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.origin).pathname,index=bodyHolds.indexOf(pathname);if(index<0)return response;bodyHolds.splice(index,1);const event={path:pathname,released:false};window.activationBodyEvents.push(event);return new Proxy(response,{get(target,property){if(property==='json')return async()=>{await new Promise<void>(resolve=>bodyReleases.push(()=>{event.released=true;resolve()}));return target.json()};const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value}})};
function GameProbe({gameId}:{gameId:string}){const query=useApi<{gameId:string}>('/v1/games/'+encodeURIComponent(gameId),{keepPreviousData:false,revalidateOnFocus:false,shouldRetryOnError:false},{timeoutMs:15000});const phase=useFirstGameViewed(gameId,{data:query.data,error:query.error,isPreviousData:query.isPreviousData,isLoading:query.isLoading});return <section aria-label="Recorded game admission" className="rounded-xl border border-border p-4"><h2 className="text-h3">Recorded game</h2><p>Current record: {gameId}</p><output aria-label="View marker state">{phase}</output></section>}
function App(){useSyncExternalStore(subscribe,()=>String(revision));const{cache,mutate}=useSWRConfig();Object.assign(window,{activationRefresh:()=>owner?mutate(['authenticated-api',owner,ACTIVATION_PATH]):Promise.resolve(),activationSnapshot:(requestOwner:string)=>cache.get(unstable_serialize(['authenticated-api',requestOwner,ACTIVATION_PATH]))?.data??null});return <ToastProvider><main className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6"><h1 className="font-display text-h2">Today</h1><button id="reading-focus" className="min-h-11 rounded border border-border px-3">Reading focus</button>{location.pathname==='/app'?<>{card?<LevelUpChecklist/>:null}{game?<GameProbe gameId={game}/>:null}</>:<section aria-label="Selected destination"><h2 className="text-h3">Selected destination</h2><p>{location.pathname+location.search+location.hash}</p></section>}</main></ToastProvider>}
const root=createRoot(document.getElementById('root')!);let stopped=false;window.activationUnmount=()=>{if(!stopped){stopped=true;root.unmount()}};root.render(<SWRConfig value={{provider:()=>new Map(),revalidateOnFocus:false,revalidateOnReconnect:false,shouldRetryOnError:false}}><App/></SWRConfig>);`;

const adapters = {
  "next/link": `import React from'react';export default React.forwardRef(function Link({href,children,prefetch,scroll,replace,onClick,onNavigate,...props},ref){return <a ref={ref} href={href} {...props} onClick={event=>{onClick?.(event);if(event.defaultPrevented||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||event.button!==0||(event.currentTarget.target&&event.currentTarget.target!=='_self')||event.currentTarget.hasAttribute('download'))return;event.preventDefault();let prevented=false;onNavigate?.({preventDefault(){prevented=true}});if(!prevented)window.activationPush(href)}}>{children}</a>});`,
  "next/navigation": `import{useSyncExternalStore}from'react';const subscribe=listener=>{addEventListener('activation-change',listener);return()=>removeEventListener('activation-change',listener)};export const useSearchParams=()=>{useSyncExternalStore(subscribe,()=>location.search);return new URLSearchParams(location.search)};export const usePathname=()=>{useSyncExternalStore(subscribe,()=>location.pathname);return location.pathname};export const useRouter=()=>({push:href=>window.activationPush(href),replace:href=>window.activationNavigate(href)});`,
  "next/dynamic": `import React,{lazy,Suspense}from'react';export default function dynamic(loader,options={}){const Loaded=lazy(async()=>{const value=await loader();return{default:value.default??value}});return function Dynamic(props){return <Suspense fallback={options.loading?React.createElement(options.loading):null}><Loaded {...props}/></Suspense>}};`,
  "next/image": `import React from'react';export default function Image({src,alt,fill,priority,quality,unoptimized,placeholder,blurDataURL,...props}){return <img src={typeof src==='string'?src:src.src} alt={alt} {...props}/>}`,
  "@clerk/nextjs": `import{useSyncExternalStore}from'react';const subscribe=listener=>{addEventListener('activation-change',listener);return()=>removeEventListener('activation-change',listener)};export const useAuth=()=>{const userId=useSyncExternalStore(subscribe,()=>window.activationOwner());return{userId,isLoaded:true,isSignedIn:!!userId,sessionId:userId?'synthetic-'+userId:null,getToken:async()=>userId?window.activationGetToken(userId):null}};export const useClerk=()=>({signOut:async()=>{window.activationNativeAttempts.push('Clerk signOut');throw new Error('Synthetic signOut denied')}});`,
};

async function startServer() {
  if (server) throw new Error("Close the previous activation fixture first");
  const current = createServer(async (request, response) => {
    try {
      if (!active || request.headers.host !== new URL(origin).host || !["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")) {
        active?.externalAttempts.push("Invalid loopback Host or peer"); request.resume(); response.writeHead(403); response.end(); return;
      }
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const value = await active.respond(new URL(request.url ?? "/", origin), request.method ?? "", Buffer.concat(chunks).toString("utf8"), request.headers.authorization ?? "");
      serverRequests.push({ method: request.method, path: request.url });
      if (!response.destroyed) { response.writeHead(value.status ?? 200, { "content-type": value.contentType, "cache-control": "no-store" }); response.end(value.body); }
    } catch (error) { active?.errors.push(String(error)); if (!response.destroyed) { response.writeHead(500); response.end(); } }
  });
  current.on("connection", socket => { connections.add(socket); socket.once("close", () => connections.delete(socket)); });
  await new Promise((resolve, reject) => { current.once("error", reject); current.listen(0, "127.0.0.1", () => { current.removeListener("error", reject); resolve(); }); }).catch(error => { current.close(); throw error; });
  server = current; origin = `http://127.0.0.1:${current.address().port}`; current.unref();
}

export async function closeActivationChecklistFixtureServer() {
  const previous = active; await previous?.releaseAll(); active = null;
  const current = server; server = null;
  if (current) await new Promise(resolve => { current.close(resolve); current.closeAllConnections(); });
  origin = "";
  return { closed: true, listening: current?.listening ?? false, sockets: connections.size, requests: serverRequests.splice(0), http: previous?.ledger ?? null };
}

async function assets() {
  const cwd = process.cwd();
  const result = await build({ stdin: { contents: SOURCE, loader: "tsx", resolveDir: cwd }, bundle: true, write: false, minify: true, format: "iife", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
    define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_RUNTIME": '""', "process.env.NEXT_PUBLIC_API_BASE": JSON.stringify(origin), "process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID": '""', "process.env": JSON.stringify({ NODE_ENV: "production", NEXT_PUBLIC_API_BASE: origin }) },
    plugins: [{ name: "activation-local-boundaries", setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(adapters, args.path) ? { path: args.path, namespace: "activation-adapter" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "activation-adapter" }, args => ({ contents: adapters[args.path], loader: "tsx", resolveDir: cwd }));
    } }],
  });
  const cssRoot = path.join(cwd, ".next/static/css"), cssNames = (await readdir(cssRoot, { recursive: true })).filter(name => name.endsWith(".css")).sort();
  if (!cssNames.length) throw new Error("Build current production CSS before activation proof");
  const buildId = (await readFile(path.join(cwd, ".next/BUILD_ID"), "utf8")).trim();
  const definitions = [["ActivationHanken", "hanken-grotesk-latin.woff2", "100 900"], ["ActivationBricolage", "bricolage-grotesque-latin.woff2", "600 800"], ["ActivationFraunces", "fraunces-latin-normal.woff2", "400 700"]];
  const fonts = new Map(await Promise.all(definitions.map(async ([, name]) => [name, await readFile(path.join(cwd, "app/fonts", name))])));
  const css = (await Promise.all(cssNames.map(name => readFile(path.join(cssRoot, name), "utf8")))).join("\n")
    + definitions.map(([family, name, weight]) => `@font-face{font-family:${family};src:url('/fonts/${name}') format('woff2');font-weight:${weight};font-style:normal;font-display:swap;}`).join("\n")
    + ":root{--font-sans:ActivationHanken;--font-display:ActivationBricolage;--font-serif:ActivationFraunces;}";
  return { script: result.outputFiles[0].text, css, cssNames, fonts, buildId };
}

/** Fresh loopback fixture; no account, provider, native or production transport. */
export async function openActivationChecklistFixture(page, theme) {
  await startServer();
  let built;
  try { built = await assets(); } catch (error) { await closeActivationChecklistFixtureServer(); throw error; }
  const { script, css, cssNames, fonts, buildId } = built;
  const errors = [], unexpectedRequests = [], rejectedWrites = [], externalAttempts = [], reads = [], writes = [], abortedResponses = [];
  const releases = [], flights = new Set(), controls = { failDismissal: false, holdActivation: null, holdGame: null };
  const blank = { identity: false, firstGameViewed: false, customBuild: false, checkIn: false, overlayLive: false, chatOn: false, goals: ["improve"], levelUpDismissedAt: null };
  const states = new Map([["owner-a", { ...blank }], ["owner-b", { ...blank, goals: ["stream"] }]]);
  const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  const denied = status => ({ status, contentType: "text/plain", body: "Unadmitted synthetic transport" });
  const hold = async () => { await new Promise(resolve => releases.push(resolve)); };
  const respond = async (url, method, body = "", authorization = "") => {
    if (url.origin !== origin) { externalAttempts.push(`${method} ${url.origin}${url.pathname}`); if (method !== "GET") rejectedWrites.push(`${method} ${url.pathname}`); return denied(403); }
    if (!url.search && !url.hash && method === "GET" && body === "" && authorization === "") {
      if (url.pathname === "/fixture.js") return { contentType: "text/javascript", body: script };
      if (url.pathname === "/fixture.css") return { contentType: "text/css", body: css };
      if (url.pathname.startsWith("/fonts/") && fonts.has(url.pathname.slice(7))) return { contentType: "font/woff2", body: fonts.get(url.pathname.slice(7)) };
      if (url.pathname === "/app") return { contentType: "text/html", body: `<!doctype html><html lang="en" data-theme="${theme}" data-theme-mode="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local activation proof</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>` };
    }
    const owner = authorization === "Bearer fixture-owner-a" ? "owner-a" : authorization === "Bearer fixture-owner-b" ? "owner-b" : null;
    if (owner && !url.search && !url.hash) {
      if (method === "GET" && body === "" && url.pathname === "/v1/me/activation") {
        reads.push({ owner, method, path: url.pathname }); const value = { ...states.get(owner) };
        if (controls.holdActivation === owner) { controls.holdActivation = null; await hold(); }
        return json(value);
      }
      if (method === "GET" && body === "" && ["/v1/games/game-one", "/v1/games/game-two"].includes(url.pathname)) {
        const gameId = url.pathname.slice("/v1/games/".length); reads.push({ owner, method, path: url.pathname });
        if (controls.holdGame === gameId) { controls.holdGame = null; await hold(); }
        return json({ gameId });
      }
      if (method === "PUT" && body.length <= 1200 && url.pathname === "/v1/me/preferences/onboarding") {
        const value = parseBody(body);
        if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && isTimestamp(value.levelUpDismissedAt)) {
          const status = controls.failDismissal ? 503 : 200; controls.failDismissal = false;
          writes.push({ owner, method, path: url.pathname, body: value, status });
          if (status === 503) return json({ error: { code: "fixture_retry", message: "Synthetic retry" } }, 503);
          states.set(owner, { ...states.get(owner), levelUpDismissedAt: value.levelUpDismissedAt }); return json(value);
        }
      }
      if (method === "PUT" && body.length <= 1200 && url.pathname === "/v1/me/activation/first-game") {
        const value = parseBody(body);
        if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && ["game-one", "game-two"].includes(value.gameId)) {
          writes.push({ owner, method, path: url.pathname, body: value, status: 200 });
          states.set(owner, { ...states.get(owner), firstGameViewed: true }); return json({ firstGameViewed: true });
        }
      }
    }
    if (method !== "GET") rejectedWrites.push(`${method} ${url.pathname}${url.search}`);
    unexpectedRequests.push(`${method} ${url.pathname}${url.search}`); return denied(405);
  };
  const releaseReads = () => releases.splice(0).forEach(resolve => resolve());
  const releaseAll = async () => {
    releaseReads();
    const results = await Promise.allSettled([...flights]);
    for (const result of results) if (result.status === "rejected") errors.push(String(result.reason));
  };
  active = { respond, errors, externalAttempts, releaseAll, ledger: { errors, unexpectedRequests, rejectedWrites, externalAttempts, reads, writes, abortedResponses } };
  const watch = candidate => candidate.on("pageerror", error => errors.push(error.message)); watch(page); page.context().on("page", watch);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript(value => {
    localStorage.setItem("sc2tools.theme", value); window.activationNativeAttempts = []; window.activationBodyEvents = [];
    const denied = name => { window.activationNativeAttempts.push(name); throw new Error(`Synthetic native action denied: ${name}`); };
    window.open = () => denied("window.open");
    window.WebSocket = class { constructor() { denied("WebSocket"); } };
    window.EventSource = class { constructor() { denied("EventSource"); } };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => denied("clipboard") } });
    Object.defineProperty(navigator, "share", { configurable: true, value: async () => denied("share") });
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: () => denied("sendBeacon") });
  }, theme);
  const routeHandler = async route => {
    const request = route.request();
    const flight = (async () => {
      const value = await respond(new URL(request.url()), request.method(), request.postData() ?? "", (await request.allHeaders()).authorization ?? "");
      if (value.status === 403 || value.status === 405) { await route.abort(); return; }
      await route.fulfill({ ...value, headers: { "cache-control": "no-store" } }).catch(error => {
        if (request.failure()?.errorText.includes("ERR_ABORTED")) abortedResponses.push({ method: request.method(), path: new URL(request.url()).pathname });
        else if (!page.isClosed() && !String(error).includes("Target closed")) errors.push(String(error));
      });
    })();
    flights.add(flight); try { await flight; } finally { flights.delete(flight); }
  };
  await page.context().route("**/*", routeHandler);
  await page.goto(`${origin}/app`); await page.getByRole("heading", { name: "Get more out of SC2 Tools", exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { errors, unexpectedRequests, rejectedWrites, externalAttempts, reads, writes, abortedResponses, cssNames, buildId,
    setActivation: (owner, patch) => { if (!states.has(owner)) throw new Error("Unadmitted synthetic owner"); states.set(owner, { ...states.get(owner), ...patch }); },
    failNextDismissal: () => { controls.failDismissal = true; },
    holdNextActivation: owner => { if (!states.has(owner)) throw new Error("Unadmitted synthetic owner"); controls.holdActivation = owner; },
    holdNextGame: gameId => { if (!["game-one", "game-two"].includes(gameId)) throw new Error("Unadmitted synthetic game"); controls.holdGame = gameId; },
    releaseReads,
    close: async () => {
      try {
        if (!page.isClosed()) await page.evaluate(() => { window.activationUnmount?.(); window.activationReleaseTokens?.(); window.activationReleaseBodies?.(); });
        await releaseAll();
        if (!page.isClosed()) await page.context().unroute("**/*", routeHandler);
      } catch (error) { errors.push(`Fixture closure: ${error}`); }
      page.context().off("page", watch);
      return closeActivationChecklistFixtureServer();
    },
  };
}
