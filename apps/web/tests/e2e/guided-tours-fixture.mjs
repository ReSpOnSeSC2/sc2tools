import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

let server, origin = "", active;
const connections = new Set(), serverRequests = [];
function parseBody(body) { try { return JSON.parse(body); } catch { return null; } }

// The target cards are explicitly synthetic layout frames, not replicas of the
// consumer pages. Actual target-owner rendering is a separate Vitest contract.
// Tour/controller/Help/Modal/check-in/authenticated request behavior is real source.
const SOURCE = `import React,{useSyncExternalStore}from'react';import{createRoot}from'react-dom/client';import{SWRConfig,useSWRConfig,unstable_serialize}from'swr';
import{GuidedTours}from'@/components/onboarding/GuidedTours';import{GameWorkspaceNav}from'@/components/analyzer/game/GameWorkspaceNav';import{LevelUpChecklist}from'@/components/onboarding/LevelUpChecklist';import{TakeATour}from'@/components/help/TakeATour';import{HelpArticleBody}from'@/components/help/HelpArticleBody';import{getArticle}from'@/lib/help';import{TOURS}from'@/lib/tours';import{ToastProvider}from'@/components/ui/Toast';import{Modal}from'@/components/ui/Modal';import{BuildCheckInProvider,useBuildCheckInRevision}from'@/components/build-checkin/BuildCheckInProvider';import{BuildCheckInCard}from'@/components/build-checkin/BuildCheckInCard';
if(!getArticle('take-a-tour')||!getArticle('your-first-game'))throw new Error('Generate the canonical Help index before guided tours proof');
let owner:string|null='owner-a',revision=0,ready=false,dialog=false,checkIn=false,checkInEpoch=0;let missing=new Set<string>();const pushes:string[]=[],tokenEvents:unknown[]=[],tokenReleases:(()=>void)[]=[],bodyHolds:string[]=[],bodyReleases:(()=>void)[]=[];let holdToken=false;
const subscribe=(listener:()=>void)=>{for(const event of ['tours-change','popstate','hashchange'])addEventListener(event,listener);return()=>{for(const event of ['tours-change','popstate','hashchange'])removeEventListener(event,listener)}};const change=()=>{revision++;dispatchEvent(new Event('tours-change'))};
Object.assign(window,{toursOwner:()=>owner,toursSetOwner:(value:string|null)=>{if(value!==null&&!['owner-a','owner-b'].includes(value))throw new Error('Unadmitted owner');owner=value;change()},toursSetReady:(value:boolean)=>{ready=value;change()},toursSetMissing:(value:string[])=>{missing=new Set(value);change()},toursSetDialog:(value:boolean)=>{dialog=value;change()},toursShowCheckIn:(value:boolean)=>{checkIn=value;checkInEpoch++;change()},toursNavigate:(href:string)=>{history.pushState({},'',href);change()},toursPush:(href:string)=>{pushes.push(href);history.pushState({},'',href);change()},toursPushes:()=>pushes.slice(),toursHoldNextToken:()=>{holdToken=true},toursTokenEvents:()=>tokenEvents.slice(),toursReleaseTokens:()=>tokenReleases.splice(0).forEach(release=>release()),toursHoldNextBody:(pathname:string)=>bodyHolds.push(pathname),toursReleaseBodies:()=>bodyReleases.splice(0).forEach(release=>release()),toursGetToken:async(issuingOwner:string)=>{const event={owner:issuingOwner,held:holdToken,released:!holdToken};tokenEvents.push(event);if(holdToken){holdToken=false;await new Promise<void>(resolve=>tokenReleases.push(()=>{event.released=true;resolve()}))}return'fixture-'+issuingOwner}});
const nativeFetch=window.fetch.bind(window);window.fetch=async(input,init)=>{const response=await nativeFetch(input,init),pathname=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.origin).pathname,index=bodyHolds.indexOf(pathname);if(index<0)return response;bodyHolds.splice(index,1);return new Proxy(response,{get(target,property){if(property==='json')return async()=>{const value=await target.json();const event={path:pathname,released:false};window.toursBodyEvents.push(event);await new Promise<void>(resolve=>bodyReleases.push(()=>{event.released=true;resolve()}));return value};const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value}})};
function Frame({id}:{id:'today'|'game'|'overlay'}){const{bump}=useBuildCheckInRevision(false);window.toursRefreshCheckIn=bump;const record=id==='game'?decodeURIComponent(location.pathname.split('/').pop()!):'surface';return <GuidedTours id={id} recordKey={record} ready={ready} className="space-y-6">{id==='game'&&!missing.has('game-navigation')?<GameWorkspaceNav/>:null}{checkIn?<BuildCheckInCard key={checkInEpoch} gameId="game-one" defaultExpanded={window.toursCheckInMode==='full'}/>:null}{TOURS[id].steps.map(step=>missing.has(step.target)||step.target==='game-navigation'?null:step.target==='today-next-steps'?<LevelUpChecklist key={step.target}/>:<section key={step.target} id={id==='game'?step.target.slice(5):undefined} data-tour={step.target} style={id==='game'?{scrollMarginTop:'var(--game-section-offset,0px)'}:undefined} className="min-h-36 rounded-xl border-2 border-line bg-bg-surface p-5 shadow-hard"><h2 className="font-display text-h3">{step.title}</h2><p className="mt-3 text-body-sm text-text-muted">Synthetic visible target card for tour placement. The actual component owner is checked separately.</p><button className="mt-3 min-h-11 rounded-full border border-border px-4 text-body-sm">Inspect this fixture card</button></section>)}<section aria-label="In-page tour replay actions" className="rounded-xl border border-border bg-bg-surface p-4"><h2 className="text-h4 font-semibold">Tour replay actions</h2><TakeATour/></section></GuidedTours>}
function App(){useSyncExternalStore(subscribe,()=>String(revision));const{cache}=useSWRConfig();window.toursSnapshot=(requestOwner:string)=>cache.get(unstable_serialize(['authenticated-api',requestOwner,'/v1/me/preferences/onboarding']))?.data??null;const id=location.pathname==='/app'?'today':location.pathname.startsWith('/app/game/')?'game':location.pathname==='/settings'?'overlay':null;return <ToastProvider><main data-game-workspace={id==='game'?'':undefined} className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6"><header className="space-y-3"><h1 className="font-display text-h2">Guided tours controls preview</h1><p className="text-caption text-text-muted">Synthetic layout frames around real tour controls. This is not a full page layout proof.</p><button id="reading-focus" className="min-h-11 rounded-full border border-border bg-bg-surface px-4">Reading focus</button></header>{id?<Frame id={id}/>:location.pathname==='/help/take-a-tour'?<section className="rounded-xl border-2 border-line bg-bg-surface p-5"><h2 className="font-display text-h3">Take a tour</h2><HelpArticleBody article={getArticle('take-a-tour')!}/></section>:<section><h2 className="text-h3">Guide destination</h2><p>{location.pathname}</p></section>}<Modal open={dialog} onClose={()=>{dialog=false;change()}} title="Existing dialog"><label className="grid gap-2">Keep typing<input aria-label="Existing dialog input" className="min-h-11 rounded border border-border bg-bg-surface p-2"/></label><button className="mt-3 min-h-11 rounded border border-border px-3" onClick={()=>{dialog=false;change()}}>Close existing dialog</button></Modal></main></ToastProvider>}
const root=createRoot(document.getElementById('root')!);let stopped=false;window.toursUnmount=()=>{if(!stopped){stopped=true;root.unmount()}};root.render(<SWRConfig value={{provider:()=>new Map(),revalidateOnFocus:false,revalidateOnReconnect:false,shouldRetryOnError:false}}><BuildCheckInProvider><App/></BuildCheckInProvider></SWRConfig>);`;

const adapters = {
  "next/link": `import React from'react';export default React.forwardRef(function Link({href,children,prefetch,scroll,replace,onClick,onNavigate,...props},ref){return <a ref={ref} href={href} {...props} onClick={event=>{onClick?.(event);if(event.defaultPrevented||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||event.button!==0||(event.currentTarget.target&&event.currentTarget.target!=='_self')||event.currentTarget.hasAttribute('download'))return;event.preventDefault();let prevented=false;onNavigate?.({preventDefault(){prevented=true}});if(!prevented)window.toursPush(href)}}>{children}</a>});`,
  "next/navigation": `import{useSyncExternalStore}from'react';const subscribe=listener=>{addEventListener('tours-change',listener);return()=>removeEventListener('tours-change',listener)};export const useSearchParams=()=>{useSyncExternalStore(subscribe,()=>location.search);return new URLSearchParams(location.search)};export const usePathname=()=>{useSyncExternalStore(subscribe,()=>location.pathname);return location.pathname};export const useRouter=()=>({push:href=>window.toursPush(href),replace:href=>{history.replaceState({},'',href);dispatchEvent(new Event('tours-change'))}});`,
  "next/dynamic": `import React,{lazy,Suspense}from'react';export default function dynamic(loader,options={}){const Loaded=lazy(async()=>{const value=await loader();return{default:value.default??value}});return function Dynamic(props){return <Suspense fallback={options.loading?React.createElement(options.loading):null}><Loaded {...props}/></Suspense>}};`,
  "next/image": `import React from'react';export default function Image({src,alt,fill,priority,quality,unoptimized,placeholder,blurDataURL,...props}){return <img src={typeof src==='string'?src:src.src} alt={alt} {...props}/>}`,
  "@clerk/nextjs": `import{useSyncExternalStore}from'react';const subscribe=listener=>{addEventListener('tours-change',listener);return()=>removeEventListener('tours-change',listener)};export const useAuth=()=>{const userId=useSyncExternalStore(subscribe,()=>window.toursOwner());return{userId,isLoaded:true,isSignedIn:!!userId,sessionId:userId?'synthetic-'+userId:null,getToken:async()=>userId?window.toursGetToken(userId):null}};`,
  "@/lib/useUserSocket": `export function useUserSocket(){}`,
};
async function startServer() {
  if (server) throw new Error("Close the previous guided tours fixture first");
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

export async function closeGuidedToursFixtureServer() {
  const previous = active; await previous?.releaseAll(); active = null;
  const current = server; server = null;
  if (current) {
    await new Promise(resolve => { current.close(resolve); current.closeAllConnections(); });
    // The server callback may precede socket close events. Set entries are
    // removed only by those events; wait for every remaining owned socket.
    await Promise.all([...connections].map(socket => new Promise(resolve => socket.once("close", resolve))));
  }
  origin = "";
  return { closed: true, listening: current?.listening ?? false, sockets: connections.size, requests: serverRequests.splice(0), http: previous?.ledger ?? null };
}

async function assets() {
  const cwd = process.cwd();
  const result = await build({ stdin: { contents: SOURCE, loader: "tsx", resolveDir: cwd }, bundle: true, write: false, minify: true, format: "iife", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
    define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_RUNTIME": '""', "process.env.NEXT_PUBLIC_API_BASE": JSON.stringify(origin), "process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID": '""', "process.env": JSON.stringify({ NODE_ENV: "production", NEXT_PUBLIC_API_BASE: origin }) },
    plugins: [{ name: "tours-local-boundaries", setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(adapters, args.path) ? { path: args.path, namespace: "tours-adapter" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "tours-adapter" }, args => ({ contents: adapters[args.path], loader: "tsx", resolveDir: cwd }));
    } }],
  });
  const cssRoot = path.join(cwd, ".next/static/css"), cssNames = (await readdir(cssRoot, { recursive: true })).filter(name => name.endsWith(".css")).sort();
  if (!cssNames.length) throw new Error("Build current production CSS before guided tours proof");
  const buildId = (await readFile(path.join(cwd, ".next/BUILD_ID"), "utf8")).trim();
  const definitions = [["ToursHanken", "hanken-grotesk-latin.woff2", "100 900"], ["ToursBricolage", "bricolage-grotesque-latin.woff2", "600 800"], ["ToursFraunces", "fraunces-latin-normal.woff2", "400 700"]];
  const fonts = new Map(await Promise.all(definitions.map(async ([, name]) => [name, await readFile(path.join(cwd, "app/fonts", name))])));
  const css = (await Promise.all(cssNames.map(name => readFile(path.join(cssRoot, name), "utf8")))).join("\n")
    + definitions.map(([family, name, weight]) => `@font-face{font-family:${family};src:url('/fonts/${name}') format('woff2');font-weight:${weight};font-style:normal;font-display:swap;}`).join("\n")
    + ":root{--font-sans:ToursHanken;--font-display:ToursBricolage;--font-serif:ToursFraunces;}";
  return { script: result.outputFiles[0].text, css, cssNames, fonts, buildId };
}

/** Only synthetic loopback DTOs; production owner/target contracts are tested separately. */
export async function openGuidedToursFixture(page, theme, id) {
  if (!["today", "game", "overlay"].includes(id)) throw new Error("Unadmitted tour");
  await startServer();
  let built; try { built = await assets(); } catch (error) { await closeGuidedToursFixtureServer(); throw error; }
  const { script, css, cssNames, fonts, buildId } = built;
  const errors = [], unexpectedRequests = [], rejectedWrites = [], externalAttempts = [], reads = [], writes = [], abortedResponses = [];
  const flights = new Set(), pages = new Set(), controls = { failSave: false, malformedSave: false, checkIn: null, latestGame: "game-two" };
  const states = new Map([["owner-a", { toursDone: {} }], ["owner-b", { toursDone: {} }]]);
  const initialHref = id === "today" ? "/app" : id === "game" ? "/app/game/game-one" : "/settings?tab=overlay";
  const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  const denied = status => ({ status, contentType: "text/plain", body: "Unadmitted synthetic transport" });
  function checkInState(mode) {
    const build = { key: "fixture-build", name: "Fixture build", slug: null, source: "catalog" };
    return { gameId: "game-one", matchup: "PvZ", myRace: "Protoss", oppRace: "Zerg", result: "Victory", date: "2026-10-26T12:00:00.000Z", durationSec: 420, map: "Synthetic map", oppName: "Synthetic opponent", eligible: true, ineligibleReason: null,
      status: mode === "collapsed" ? "none" : mode === "confirmed" ? "confirmed" : "pending", applied: mode === "confirmed", build: mode === "confirmed" ? build : null,
      suggestion: mode === "full" ? { ...build, reason: "randomizer", passedRules: null, ruleCount: null } : null, randomizer: null, randomizerDeviated: false,
      detected: { name: "Fixture replay classification", slug: null, key: null }, executed: false, notes: "", origin: null, via: null, confirmedAt: mode === "confirmed" ? "2026-10-26T12:00:00.000Z" : null, updatedAt: null,
      prefs: { enabled: true, askAtLoading: true, askAfterGame: true }, options: [{ ...build, games: 0, wins: 0, losses: 0, checkins: 0, lastPlayedAt: null, inRandomizer: false, group: "yours" }], usualKey: null };
  }
  const respond = async (url, method, body = "", authorization = "") => {
    if (url.origin !== origin) { externalAttempts.push(method + " " + url.origin + url.pathname); if (method !== "GET") rejectedWrites.push(method + " " + url.pathname); return denied(403); }
    if (!url.search && !url.hash && method === "GET" && body === "" && authorization === "") {
      if (url.pathname === "/fixture.js") return { contentType: "text/javascript", body: script };
      if (url.pathname === "/fixture.css") return { contentType: "text/css", body: css };
      if (url.pathname.startsWith("/fonts/") && fonts.has(url.pathname.slice(7))) return { contentType: "font/woff2", body: fonts.get(url.pathname.slice(7)) };
    }
    if (method === "GET" && body === "" && authorization === "" && url.pathname + url.search === initialHref && !url.hash) return { contentType: "text/html", body: '<!doctype html><html lang="en" data-theme="' + theme + '" data-theme-mode="' + theme + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local guided tour controls proof</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>' };
    const owner = authorization === "Bearer fixture-owner-a" ? "owner-a" : authorization === "Bearer fixture-owner-b" ? "owner-b" : null;
    if (owner && method === "GET" && body === "" && !url.hash) {
      if (!url.search && url.pathname === "/v1/me/preferences/onboarding") { reads.push({ owner, method, path: url.pathname }); return json(states.get(owner)); }
      if (!url.search && url.pathname === "/v1/me/activation") { reads.push({ owner, method, path: url.pathname }); return json({ identity: false, firstGameViewed: false, customBuild: false, checkIn: false, overlayLive: false, chatOn: false, goals: ["improve"], levelUpDismissedAt: null }); }
      if (url.pathname === "/v1/games" && url.search === "?limit=1") { reads.push({ owner, method, path: url.pathname, query: url.search }); return json({ items: [{ gameId: controls.latestGame }] }); }
      if (url.pathname === "/v1/games/game-one/build-intent" && url.search === "?include=options") { reads.push({ owner, method, path: url.pathname, query: url.search }); return controls.checkIn ? json(checkInState(controls.checkIn)) : json({ error: { code: "build_intent_not_found" } }, 404); }
    }
    if (owner && method === "PUT" && !url.search && !url.hash && url.pathname === "/v1/me/preferences/onboarding" && body.length <= 1200) {
      const value = parseBody(body), tourMap = value?.toursDone;
      if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && tourMap && typeof tourMap === "object" && !Array.isArray(tourMap) && Object.keys(tourMap).length === 1) {
        const [tourId] = Object.keys(tourMap), version = tourMap[tourId];
        if (["today", "game", "overlay"].includes(tourId) && Number.isSafeInteger(version) && version > 0 && version <= 1000) {
          const status = controls.failSave ? 503 : 200, malformed = controls.malformedSave; controls.failSave = false; controls.malformedSave = false;
          writes.push({ owner, method, path: url.pathname, body: value, status, malformed });
          if (status === 503) return json({ error: { code: "fixture_retry", message: "Synthetic tour save retry" } }, 503);
          if (malformed) return json({});
          const previous = states.get(owner); const next = { ...previous, toursDone: { ...previous.toursDone, [tourId]: Math.max(previous.toursDone[tourId] ?? 0, version) } }; states.set(owner, next); return json(next);
        }
      }
    }
    if (method !== "GET") rejectedWrites.push(method + " " + url.pathname + url.search);
    unexpectedRequests.push(method + " " + url.pathname + url.search); return denied(405);
  };
  const releaseAll = async () => { const results = await Promise.allSettled([...flights]); for (const result of results) if (result.status === "rejected") errors.push(String(result.reason)); };
  active = { respond, errors, externalAttempts, releaseAll, ledger: { errors, unexpectedRequests, rejectedWrites, externalAttempts, reads, writes, abortedResponses } };
  const watch = candidate => { pages.add(candidate); candidate.on("pageerror", onPageError); }, onPageError = error => errors.push(error.message); watch(page); page.context().on("page", watch);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript(value => {
    localStorage.setItem("sc2tools.theme", value); window.toursNativeAttempts = []; window.toursBodyEvents = []; window.toursScrolls = []; window.toursCheckInMode = null;
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function(options) { window.toursScrolls.push({ target: this.getAttribute("data-tour"), options }); return original.call(this, options); };
    const deny = name => { window.toursNativeAttempts.push(name); throw new Error("Synthetic native action denied: " + name); };
    window.open = () => deny("window.open"); window.WebSocket = class { constructor() { deny("WebSocket"); } }; window.EventSource = class { constructor() { deny("EventSource"); } };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => deny("clipboard") } });
    Object.defineProperty(navigator, "share", { configurable: true, value: async () => deny("share") }); Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: () => deny("sendBeacon") });
  }, theme);
  const routeHandler = async route => {
    const request = route.request(); const flight = (async () => {
      const value = await respond(new URL(request.url()), request.method(), request.postData() ?? "", (await request.allHeaders()).authorization ?? "");
      if (value.status === 403 || value.status === 405) { await route.abort(); return; }
      await route.fulfill({ ...value, headers: { "cache-control": "no-store" } }).catch(error => { if (request.failure()?.errorText.includes("ERR_ABORTED")) abortedResponses.push({ method: request.method(), path: new URL(request.url()).pathname }); else if (!page.isClosed() && !String(error).includes("Target closed")) errors.push(String(error)); });
    })(); flights.add(flight); try { await flight; } finally { flights.delete(flight); }
  };
  await page.context().route("**/*", routeHandler); await page.goto(origin + initialHref); await page.getByRole("heading", { name: "Guided tours controls preview", exact: true }).waitFor(); await page.evaluate(() => document.fonts.ready);
  return { errors, unexpectedRequests, rejectedWrites, externalAttempts, reads, writes, abortedResponses, cssNames, buildId, initialHref,
    failNextSave: () => { controls.failSave = true; }, malformedNextSave: () => { controls.malformedSave = true; },
    setLatestGame: gameId => { if (!["game-one", "game-two"].includes(gameId)) throw new Error("Unadmitted game"); controls.latestGame = gameId; },
    showCheckIn: async mode => { if (mode !== null && !["full", "collapsed", "confirmed"].includes(mode)) throw new Error("Unadmitted check-in mode"); controls.checkIn = mode; await page.evaluate(value => { window.toursCheckInMode = value; window.toursShowCheckIn(value !== null); window.toursRefreshCheckIn?.(); }, mode); },
    close: async () => { try { if (!page.isClosed()) await page.evaluate(() => { window.toursUnmount?.(); window.toursReleaseTokens?.(); window.toursReleaseBodies?.(); }); await releaseAll(); if (!page.isClosed()) await page.context().unroute("**/*", routeHandler); } catch (error) { errors.push("Fixture closure: " + error); } page.context().off("page", watch); for (const candidate of pages) candidate.off("pageerror", onPageError); return closeGuidedToursFixtureServer(); },
  };
}
