import { build } from "esbuild";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { open, readFile, readdir } from "node:fs/promises";
import path from "node:path";

let server, origin = "", active;
const serverRequests = [];
const SOURCE = `import React,{useSyncExternalStore}from'react';import{createRoot}from'react-dom/client';import{SWRConfig}from'swr';
import{SettingsShell}from'@/components/analyzer/settings/SettingsShell';import{SettingsOverlay}from'@/components/analyzer/settings/SettingsOverlay';import{SettingsChat}from'@/components/analyzer/settings/SettingsChat';import{SettingsStreamingTokenOwner}from'@/components/analyzer/settings/SettingsStreamingTokenOwner';import{RealtimeProvider}from'@/components/realtime/RealtimeProvider';import{ToastProvider}from'@/components/ui/Toast';
import dynamic from'next/dynamic';import{SettingsFoundation}from'@/components/analyzer/settings/SettingsFoundation';import{SettingsProfile}from'@/components/analyzer/settings/SettingsProfile';import{SettingsMisc}from'@/components/analyzer/settings/SettingsMisc';import{SettingsRandomizer}from'@/components/analyzer/settings/SettingsRandomizer';import{SettingsImport}from'@/components/analyzer/settings/SettingsImport';import{SettingsVoice}from'@/components/analyzer/settings/SettingsVoice';import{SettingsHelp}from'@/components/analyzer/settings/SettingsHelp';import{BuildCheckInSettings}from'@/components/build-checkin/BuildCheckInSettings';
import{settingsTabFromParam}from'@/lib/settingsRegistry';
const SettingsBackups=dynamic(async()=>{await window.sectionWaitBackups();return import('@/components/analyzer/settings/SettingsBackups').then(mod=>mod.SettingsBackups)},{loading:()=> <p role="status">Loading Backups code…</p>});
const subscribe=(listener:()=>void)=>{for(const event of ['fixture-change','popstate','hashchange'])addEventListener(event,listener);return()=>{for(const event of ['fixture-change','popstate','hashchange'])removeEventListener(event,listener)}};
for(const method of ['pushState','replaceState']as const){const native=history[method].bind(history);history[method]=(...args:Parameters<History[typeof method]>)=>{native(...args);dispatchEvent(new Event('fixture-change'))}};
let owner='owner-a';const pushes:string[]=[];Object.assign(window,{sectionOwner:()=>owner,sectionSetOwner:(value:string)=>{owner=value;dispatchEvent(new Event('fixture-change'))},sectionNavigate:(href:string)=>history.pushState({},'',href),sectionPush:(href:string)=>{pushes.push(href);history.pushState({},'',href)},sectionPushes:()=>pushes.slice()});
function body(id:string){switch(id){case'account':return <SettingsFoundation/>;case'profile':return <SettingsProfile/>;case'backups':return <SettingsBackups/>;case'preferences':return <SettingsMisc/>;case'randomizer':return <SettingsRandomizer/>;case'import':return <SettingsImport/>;case'voice':return <SettingsVoice/>;case'checkin':return <BuildCheckInSettings/>;case'help':return <SettingsHelp/>;case'overlay':return <SettingsOverlay origin={location.origin}/>;case'chat':return <SettingsChat origin={location.origin}/>;default:throw new Error('Unknown actual settings tab')}}
function App(){useSyncExternalStore(subscribe,()=>location.pathname+location.search+location.hash+owner);if(location.pathname==='/devices')return <main><h1>Devices destination</h1></main>;return <ToastProvider><main className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6"><h1 className="font-display text-h2 text-text">Settings</h1><button id="fixture-focus" className="min-h-11 rounded border border-border px-3 text-text">Reading focus</button><SettingsShell initialTab={settingsTabFromParam(new URLSearchParams(location.search).get('tab'))??undefined} requestedSearch={location.search.slice(1)} ownerKey={owner} renderStreaming={(children,section)=><SettingsStreamingTokenOwner section={section}>{children}</SettingsStreamingTokenOwner>} renderTab={body}/></main></ToastProvider>};
const root=createRoot(document.getElementById('root')!);let stopped=false;Object.assign(window,{sectionUnmount:()=>{if(!stopped){stopped=true;root.unmount()}}});root.render(<SWRConfig value={{provider:()=>new Map(),revalidateOnFocus:false,revalidateOnReconnect:false,shouldRetryOnError:false}}><RealtimeProvider><App/></RealtimeProvider></SWRConfig>);`;

// Framework/auth and socket transport only. Actual Settings consumers, HTTP
// helper, SWR, realtime ownership, observers, forms and nav remain real.
const adapters = {
  "next/link": `import React from'react';export default React.forwardRef(function Link({href,children,prefetch,scroll,replace,onClick,onNavigate,...props},ref){return <a ref={ref} href={href} {...props} onClick={event=>{onClick?.(event);if(event.defaultPrevented||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||event.button!==0||(event.currentTarget.target&&event.currentTarget.target!=='_self')||event.currentTarget.hasAttribute('download'))return;event.preventDefault();let prevented=false;onNavigate?.({preventDefault(){prevented=true}});if(!prevented)window.sectionPush(href)}}>{children}</a>});`,
  "next/navigation": `import{useSyncExternalStore}from'react';const subscribe=listener=>{addEventListener('fixture-change',listener);return()=>removeEventListener('fixture-change',listener)};export const useSearchParams=()=>{useSyncExternalStore(subscribe,()=>location.search);return new URLSearchParams(location.search)};export const usePathname=()=>{useSyncExternalStore(subscribe,()=>location.pathname);return location.pathname};export const useRouter=()=>({push:href=>window.sectionPush(href),replace:href=>history.replaceState({},'',href)});`,
  "next/dynamic": `import React,{lazy,Suspense}from'react';export default function dynamic(loader,options={}){const Loaded=lazy(async()=>{if(options.ssr===false)await window.sectionWaitClientBoundary();const value=await loader();return{default:value.default??value}});return function Dynamic(props){return <Suspense fallback={options.loading?React.createElement(options.loading):null}><Loaded {...props}/></Suspense>}};`,
  "next/image": `import React from'react';export default function Image({src,alt,fill,priority,quality,unoptimized,placeholder,blurDataURL,...props}){return <img src={typeof src==='string'?src:src.src} alt={alt} {...props}/>}`,
  "@clerk/nextjs": `import{useSyncExternalStore}from'react';const subscribe=listener=>{addEventListener('fixture-change',listener);return()=>removeEventListener('fixture-change',listener)};export const useAuth=()=>{const userId=useSyncExternalStore(subscribe,()=>window.sectionOwner());return{userId,isLoaded:true,isSignedIn:true,sessionId:'synthetic-'+userId,getToken:async()=>'fixture-'+userId}};`,
  "socket.io-client": `let serial=0;export function io(url,options={}){const id=++serial,events=new Map(),outgoing=new Set();let stopped=false;const local=new URL(url,location.origin).origin===location.origin;const record=(kind,event)=>window.sectionSocketEvents.push({id,kind,event});const reject=reason=>{window.sectionSocketRejections.push(reason);throw new Error('Synthetic socket denied: '+reason)};if(!local){window.sectionNativeAttempts.push('socket '+url);reject('nonlocal origin')}record('create');const socket={connected:false,on(event,fn){const set=events.get(event)||new Set();set.add(fn);events.set(event,set);return socket},off(event,fn){if(!event)events.clear();else if(fn)events.get(event)?.delete(fn);else events.delete(event);return socket},onAnyOutgoing(fn){outgoing.add(fn);return socket},offAnyOutgoing(fn){outgoing.delete(fn);return socket},emit(event,...args){if(!['overlay:resync','overlay:heartbeat'].includes(event))reject('unapproved emit '+event);record('emit',event);for(const fn of outgoing)fn(event,...args);return socket},connect(){if(stopped||socket.connected)return socket;const admit=auth=>{if(stopped)return;const value=auth||options.auth;if(typeof options.auth==='function'?!/^fixture-owner-[ab]$/.test(value?.token||''):!/^owner-[ab]-(one|two)$/.test(value?.overlayToken||'')||value.presenceVersion!==1)reject('invalid synthetic handshake');socket.connected=true;record('connect');for(const fn of events.get('connect')||[])fn()};queueMicrotask(()=>typeof options.auth==='function'?options.auth(admit):admit(options.auth));return socket},disconnect(){if(!stopped){stopped=true;socket.connected=false;record('disconnect')}return socket},io:{on(){},off(){}}};if(options.autoConnect!==false)queueMicrotask(()=>socket.connect());return socket}export default io;`,
};

async function startServer() {
  if (server) return;
  const current = createServer(async (request, response) => {
    try {
      if (!active || request.headers.host !== new URL(origin).host || !["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")) {
        active?.externalAttempts.push(`${request.method} invalid loopback Host/peer`);
        request.resume(); response.writeHead(403); response.end(); return;
      }
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const value = await active.respond(new URL(request.url ?? "/", origin), request.method ?? "", Buffer.concat(chunks).toString("utf8"), request.headers.authorization);
      serverRequests.push({ method: request.method, path: request.url });
      if (!response.destroyed) { response.writeHead(value.status ?? 200, { "content-type": value.contentType, "cache-control": "no-store" }); response.end(value.body); }
    } catch (error) { active?.errors.push(String(error)); if (!response.destroyed) { response.writeHead(500); response.end(); } }
  });
  await new Promise((resolve, reject) => { current.once("error", reject); current.listen(0, "127.0.0.1", () => { current.removeListener("error", reject); resolve(); }); }).catch(error => { current.close(); throw error; });
  server = current; origin = `http://127.0.0.1:${current.address().port}`; current.unref();
}

export async function closeSettingsSearchFixtureServer() {
  const state = active;
  let drainError = null;
  try { await state?.releaseAll(); }
  catch (error) { drainError = String(error); state?.errors.push(`Cleanup drain: ${drainError}`); }
  // Context-routed requests do not hit the listener ledger. Retain their
  // complete immutable receipt after draining, including on an earlier RED.
  const http = state?.snapshot() ?? null;
  active = null;
  const current = server; server = null;
  if (current) await new Promise(resolve => { current.close(resolve); current.closeAllConnections(); });
  const receipt = { closed: true, listening: current?.listening ?? false, requests: serverRequests.splice(0), http, drainError }; origin = ""; return receipt;
}

const PUBLIC_MAP_IMAGE_BYTES = 44558;
const PUBLIC_MAP_IMAGE_SHA256 = "eec73e40ffb44867a3026f9c555bebd2dc942256723a5126f7ca1fa7feef9d51";

async function readPublicMapImage(cwd) {
  const file = await open(path.join(cwd, "../replay-engine/data/map-images/alcyone_le.webp"), "r");
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size !== PUBLIC_MAP_IMAGE_BYTES) throw new Error("Pinned public map image size changed");
    const buffer = Buffer.alloc(PUBLIC_MAP_IMAGE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const pixels = buffer.subarray(0, length);
    if (length !== PUBLIC_MAP_IMAGE_BYTES || createHash("sha256").update(pixels).digest("hex") !== PUBLIC_MAP_IMAGE_SHA256) throw new Error("Pinned public map image content changed");
    return pixels;
  } finally { await file.close(); }
}

async function assets(mode) {
  const cwd = process.cwd();
  const result = await build({ stdin: { contents: SOURCE, loader: "tsx", resolveDir: cwd }, bundle: true, write: false, minify: true, format: "iife", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
    define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_BASE": JSON.stringify(origin), "process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID": JSON.stringify(""), "process.env": JSON.stringify({ NODE_ENV: "production", NEXT_PUBLIC_API_BASE: origin, NEXT_PUBLIC_INSTANT_IMPORT: mode }) },
    plugins: [{ name: "settings-search-local-boundaries", setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(adapters, args.path) ? { path: args.path, namespace: "sections-adapter" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "sections-adapter" }, args => ({ contents: adapters[args.path], loader: "tsx", resolveDir: cwd }));
    } }],
  });
  const cssRoot = path.join(cwd, ".next/static/css"), cssNames = (await readdir(cssRoot, { recursive: true })).filter(name => name.endsWith(".css")).sort();
  if (!cssNames.length) throw new Error("Build production CSS before Settings search proof");
  const buildId = (await readFile(path.join(cwd, ".next/BUILD_ID"), "utf8")).trim();
  const definitions = [["SettingsHanken", "hanken-grotesk-latin.woff2", "100 900"], ["SettingsBricolage", "bricolage-grotesque-latin.woff2", "600 800"], ["SettingsFraunces", "fraunces-latin-normal.woff2", "400 700"]];
  const fonts = new Map(await Promise.all(definitions.map(async ([, name]) => [name, await readFile(path.join(cwd, "app/fonts", name))])));
  const css = (await Promise.all(cssNames.map(name => readFile(path.join(cssRoot, name), "utf8")))).join("\n")
    + definitions.map(([family, name, weight]) => `@font-face{font-family:${family};src:url('/fonts/${name}') format('woff2');font-weight:${weight};font-style:normal;font-display:swap;}`).join("\n")
    + ":root{--font-sans:SettingsHanken;--font-display:SettingsBricolage;--font-serif:SettingsFraunces;}";
  return { script: result.outputFiles[0].text, css, cssNames, fonts, buildId, cwd };
}

/** Isolated actual-component proof. Every HTTP request, socket and iframe is
 * synthetic and ledgered. There is no accepted mutation or real provider path. */
export async function openSettingsSearchFixture(page, theme, options = {}) {
  const mode = options.mode ?? "off";
  if (!["off", "all", "admins"].includes(mode)) throw new Error("Unknown explicit import rollout mode");
  await startServer();
  let built;
  try { built = await assets(mode); } catch (error) { await closeSettingsSearchFixtureServer(); throw error; }
  const { script, css, cssNames, fonts, buildId, cwd } = built;
  const initialHref = options.initialHref ?? "/settings?tab=account";
  if (!["/settings?tab=account", "/settings?tab=profile#public-profile", "/settings?tab=backups", "/settings?tab=import", "/settings?tab=overlay&section=look#theme"].includes(initialHref)) throw new Error("Unknown fixture entry");
  const errors = [], unexpectedRequests = [], rejectedWrites = [], externalAttempts = [], reads = [], writes = [], images = [], publicImages = [], iframes = [], popupLoads = [], abortedResponses = [];
  const flights = new Set(), releases = [];
  let holdTokenRead = !!options.holdTokenRead;
  let holdProfileRead = !!options.holdProfileRead, holdMeRead = !!options.holdMeRead;
  const row = (owner, id) => ({ token: `${owner}-${id}`, label: `${owner} ${id}`, createdAt: "2026-10-26T00:00:00Z", enabledWidgets: [], profile: { v: 1, theme: {}, widgetOptions: {} }, profileRevision: 0 });
  const json = value => ({ contentType: "application/json", body: JSON.stringify(value) });
  const denied = status => ({ status, contentType: "text/plain", body: "Unadmitted synthetic request" });
  const html = body => ({ contentType: "text/html", body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local scene</title></head><body>${body}</body></html>` });
  const respond = async (url, method, body = "", authorization) => {
    if (url.origin !== origin) { externalAttempts.push(`${method} ${url.origin}${url.pathname}${url.search}`); if (method !== "GET") rejectedWrites.push(`${method} ${url.pathname}${url.search}`); return denied(403); }
    if (method !== "GET") { rejectedWrites.push(`${method} ${url.pathname}${url.search}`); unexpectedRequests.push(`${method} ${url.pathname}${url.search}`); return denied(405); }
    if (url.pathname === "/v1/map-image") {
      if (url.search !== "?map=Alcyone%20LE" || url.hash || authorization !== undefined || body !== "") { unexpectedRequests.push(`${method} ${url.pathname}${url.search}`); return denied(405); }
      const pixels = await readPublicMapImage(cwd);
      publicImages.push({ method, path: url.pathname, query: url.search, anonymous: true, bytes: pixels.length, sha256: PUBLIC_MAP_IMAGE_SHA256 });
      return { contentType: "image/webp", body: pixels };
    }
    if (!url.search && !url.hash) {
      if (url.pathname === "/fixture.js") return { contentType: "text/javascript", body: script };
      if (url.pathname === "/fixture.css") return { contentType: "text/css", body: css };
      if (url.pathname.startsWith("/fonts/") && fonts.has(url.pathname.slice(7))) return { contentType: "font/woff2", body: fonts.get(url.pathname.slice(7)) };
      if (url.pathname === "/devices") { popupLoads.push("GET /devices"); return html("<h1>Devices destination</h1><p>No account or provider transport.</p>"); }
      if (/^\/(?:icons|images\/widget-examples)\/[a-zA-Z0-9_./-]+\.(?:png|webp|svg)$/.test(url.pathname) && !url.pathname.includes("..")) {
        const target = path.resolve(cwd, "public", `.${url.pathname}`), root = path.resolve(cwd, "public") + path.sep;
        if (target.startsWith(root)) { const pixels = await readFile(target); if (pixels.length > 2_000_000) throw new Error("Synthetic image exceeds bound"); images.push(url.pathname); return { contentType: url.pathname.endsWith(".svg") ? "image/svg+xml" : url.pathname.endsWith(".png") ? "image/png" : "image/webp", body: pixels }; }
      }
    }
    if (url.pathname === "/api/agent/version" && url.search === "?channel=stable&platform=windows&current=0.0.0" && !url.hash) {
      reads.push({ owner: "public", path: url.pathname, query: url.search });
      return json({ ok: true, channel: "stable", platform: "windows", update_available: false, latest: "0.24.7" });
    }
    if (url.pathname === "/settings" && url.search === new URL(initialHref, origin).search && !url.hash) return { contentType: "text/html", body: `<!doctype html><html lang="en" data-theme="${theme}" data-theme-mode="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Settings search proof</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>` };
    if (/^\/overlay\/owner-[ab]-(?:one|two)\/scene\/between-games$/.test(url.pathname) && url.search === "?demo=1") { iframes.push(url.pathname + url.search); return html("<main><h1>Local scene preview</h1><p>Static synthetic preview. No stream content or connection.</p></main>"); }
    const owner = authorization === "Bearer fixture-owner-a" ? "owner-a" : authorization === "Bearer fixture-owner-b" ? "owner-b" : null;
    if (owner && url.pathname === "/v1/custom-builds" && !url.hash && url.searchParams.size === 4
      && /^(?:P|T|Z)v(?:P|T|Z)$/.test(url.searchParams.get("matchup") ?? "") && url.searchParams.get("sort") === "name"
      && url.searchParams.get("view") === "summary" && url.searchParams.get("includeGeneric") === "true") {
      reads.push({ owner, path: url.pathname, query: url.search }); return json({ items: [], total: 0, nextCursor: null });
    }
    if (owner && !url.search && !url.hash) {
      const fixed = new Map([
        ["/v1/me", { userId: owner, email: "fixture@example.invalid", isAdmin: !!options.admin, agentPaired: true, agentLastSeenAt: null, agentVersion: "0.24.7", games: { total: 0, latest: null }, onboarding: { goals: ["play"] } }],
        ["/v1/me/doctor", { warnings: [] }],
        ["/v1/me/profile", { displayName: "Synthetic player", battleTag: "Fixture#1234", pulseIds: [] }],
        ["/v1/me/player-channels", { identities: [], entries: [] }],
        ["/v1/me/public-profile", { publicDisplayName: "Synthetic player", enabled: false, legacyPublic: false, slug: "fixture-0123456789", updatedAt: null, renameAvailableAt: null, replaySharingEnabled: false, revision: 0, showReplays: false, showChannels: false, showRecentForm: false, showMmrHistory: false, showSeasons: false, showMaps: false }],
        ["/v1/me/backups", { items: [] }],
        ["/v1/me/replay-archive-status", { enabled: false, totalGames: 0, archivedGames: 0, missingGames: 0, archiveComplete: true, backfillVersion: 0, resyncRequestedAt: null, requiresResync: false }],
        ["/v1/games/hidden", { items: [], nextCursor: null }],
        ["/v1/me/preferences/randomizer", {}], ["/v1/me/preferences/voice", {}], ["/v1/me/preferences/misc", {}],
        ["/v1/me/preferences/notifications", { muted: [] }], ["/v1/me/preferences/buildCheckin", {}],
        ["/v1/import/status", { status: "idle" }], ["/v1/import/jobs", { ok: true, items: [] }], ["/v1/messages/mine", { items: [] }],
        ["/v1/me/preferences/ghost", { v: 2, slots: {}, revision: 0 }],
        ["/v1/devices/obs", { devices: [] }],
        ["/v1/me/preferences/multichat", {}],
        ["/v1/me/preferences/chatCommands", { v: 1, builtins: {}, custom: [] }],
        ["/v1/me/chatbot", { enabled: false, username: "", channel: "", replyCommands: true, announceOracle: true, announceLevelUps: true, hasToken: false, status: { state: "off", channel: null, lastError: null, lastConnectedAt: null } }],
        ["/v1/me/integrations", { platforms: ["twitch", "kick", "youtube"].map(platform => ({ platform, configured: false, connected: false, ready: false, platformUserName: "", scopes: [], connectedAt: null, lastSyncedAt: null, lastError: null })) }],
        ["/v1/me/twitch-automation", { serverEnabled: false, configured: false, connected: false, eligible: false, predictionPermission: false, markerPermission: false, preferences: { predictionsEnabled: false, markersEnabled: false, windowSec: 90, titleTemplate: "{me} vs {opp}" } }],
      ]);
      if (url.pathname === "/v1/overlay-tokens") {
        reads.push({ owner, path: url.pathname });
        if (holdTokenRead) { holdTokenRead = false; await new Promise(resolve => releases.push(resolve)); }
        return json({ items: [row(owner, "one"), row(owner, "two")] });
      }
      if (fixed.has(url.pathname)) {
        reads.push({ owner, path: url.pathname });
        if (url.pathname === "/v1/me/profile" && holdProfileRead) { holdProfileRead = false; await new Promise(resolve => releases.push(resolve)); }
        if (url.pathname === "/v1/me" && holdMeRead) { holdMeRead = false; await new Promise(resolve => releases.push(resolve)); }
        return json(fixed.get(url.pathname));
      }
      if (url.pathname === "/v1/me/live") { reads.push({ owner, path: url.pathname }); return { contentType: "text/event-stream", body: ': synthetic\n\ndata: {"type":"liveGameState","phase":"menu","isReplay":false}\n\n' }; }
      if (new RegExp(`^/v1/overlay-tokens/${owner}-(?:one|two)/presence$`).test(url.pathname)) { reads.push({ owner, path: url.pathname }); return json({ surfaces: {}, widgets: {}, scenes: {}, totalSources: 0, agent: { online: false }, lastLiveAt: null, sampledAt: "2026-10-26T12:00:00.000Z" }); }
      if (new RegExp(`^/v1/multichat/${owner}-(?:one|two)/studio$`).test(url.pathname)) { reads.push({ owner, path: url.pathname }); return json({ updatedAt: "2026-10-26T12:00:00.000Z", buildProfile: {} }); }
    }
    unexpectedRequests.push(`${method} ${url.pathname}${url.search}`); return denied(405);
  };
  const releaseAll = async () => { releases.splice(0).forEach(resolve => resolve()); await Promise.all([...flights]); };
  const snapshot = () => JSON.parse(JSON.stringify({ errors, unexpectedRequests, rejectedWrites, externalAttempts, reads, writes, images, publicImages, iframes, popupLoads, abortedResponses, cssNames, buildId, mode, admin: !!options.admin }));
  active = { respond, errors, externalAttempts, releaseAll, snapshot };
  const watch = candidate => candidate.on("pageerror", error => errors.push(error.message)); watch(page); page.context().on("page", watch);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript(value => {
    localStorage.setItem("sc2tools.theme", value.theme);
    const state = window;
    state.sectionSocketEvents = []; state.sectionSocketRejections = []; state.sectionNativeAttempts = []; state.sectionScrolls = [];
    const gates = { backups: !!value.holdBackupsModule, client: !!value.holdClientBoundaries };
    const waiting = { backups: [], client: [] };
    state.sectionBoundaryEvents = [];
    state.sectionWaitBackups = () => { state.sectionBoundaryEvents.push("backups"); return gates.backups ? new Promise(resolve => waiting.backups.push(resolve)) : Promise.resolve(); };
    state.sectionWaitClientBoundary = () => { state.sectionBoundaryEvents.push("client"); return gates.client ? new Promise(resolve => waiting.client.push(resolve)) : Promise.resolve(); };
    state.sectionReleaseBoundary = kind => { if (!(kind in gates)) throw new Error("Unknown synthetic boundary"); gates[kind] = false; waiting[kind].splice(0).forEach(resolve => resolve()); };
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (options) { state.sectionScrolls.push({ id: this.id, label: this.getAttribute("aria-label"), options }); return original.call(this, options); };
    state.WebSocket = class { constructor(url) { state.sectionNativeAttempts.push(`WebSocket ${url}`); throw new Error("Native socket denied by isolated fixture"); } };
    const denyNative = operation => { state.sectionNativeAttempts.push(operation); throw new Error(`Native operation denied by isolated fixture: ${operation}`); };
    if (typeof state.Worker === "function") {
      const NativeWorker = state.Worker;
      state.Worker = class extends NativeWorker { constructor(url) {
        const operation = `Worker ${String(url)}`; state.sectionNativeAttempts.push(operation);
        throw new Error(`Native operation denied by isolated fixture: ${operation}`);
      } };
    }
    for (const picker of ["showDirectoryPicker", "showOpenFilePicker", "showSaveFilePicker"]) {
      if (typeof state[picker] === "function") Object.defineProperty(state, picker, {
        configurable: true, writable: true, value: async () => denyNative(picker),
      });
    }
    const clipboard = navigator.clipboard;
    if (clipboard) for (const operation of ["writeText", "readText", "write", "read"]) {
      if (typeof clipboard[operation] === "function") Object.defineProperty(clipboard, operation, {
        configurable: true, writable: true, value: async () => denyNative(`clipboard.${operation}`),
      });
    }
  }, { theme, holdBackupsModule: !!options.holdBackupsModule, holdClientBoundaries: !!options.holdClientBoundaries });
  await page.context().route("**/*", async route => {
    const request = route.request();
    const flight = (async () => {
      const value = await respond(new URL(request.url()), request.method(), request.postData() ?? "", (await request.allHeaders()).authorization);
      if (value.status === 403 || value.status === 405) return route.abort();
      await route.fulfill({ ...value, headers: { "cache-control": "no-store" } }).catch(error => {
        if (request.failure()?.errorText.includes("ERR_ABORTED")) abortedResponses.push({ method: request.method(), path: new URL(request.url()).pathname });
        else if (!page.isClosed() && !String(error).includes("Target closed")) errors.push(String(error));
      });
    })();
    flights.add(flight); try { await flight; } finally { flights.delete(flight); }
  });
  await page.goto(origin + initialHref); await page.getByRole("heading", { level: 1, name: "Settings", exact: true }).waitFor(); await page.evaluate(() => document.fonts.ready);
  return { errors, unexpectedRequests, rejectedWrites, externalAttempts, reads, writes, images, publicImages, iframes, popupLoads, abortedResponses, cssNames, buildId, releaseAll,
    holdNextTokenRead: () => { holdTokenRead = true; },
    releaseTokenReads: () => { releases.splice(0).forEach(resolve => resolve()); },
    releaseReads: () => { releases.splice(0).forEach(resolve => resolve()); },
  };
}
