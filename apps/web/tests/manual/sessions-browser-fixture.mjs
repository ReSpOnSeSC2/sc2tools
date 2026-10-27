import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

/**
 * Exported browser-fixture contract. This supplies types only; no runtime seam.
 * @typedef {"synthetic-a" | "synthetic-b"} SyntheticOwner
 * @typedef {{gapMinutes:number,source:"preference"|"auto-player"|"auto-overlay",storedGapMinutes:number|null}} SessionPolicy
 * @typedef {{battleTag:string,displayName:string,pulseIds:string[],region:string,preferredRace:string,sessionGapMinutes:number|null}} ProfileWrite
 * @typedef {ProfileWrite & {overlay:boolean}} ProfileRow
 * @typedef {{method:string,path:string,query:string,status:number,owner:SyntheticOwner|null,complete:boolean,at:number,finishedAt:number|null,body?:ProfileWrite,held?:boolean,aborted?:boolean,releaseAttempted?:boolean}} WireRequest
 * @typedef {{owner:SyntheticOwner,body:ProfileWrite,policy:SessionPolicy}} WireCommit
 * @typedef {{url:string,method:string,error:string,closing:boolean}} WireFailure
 * @typedef {{type:string,text:string,location:{url:string,lineNumber:number,columnNumber:number}}} WireConsole
 * @typedef {{kind:"request",url:string}} ExternalRequest
 * @typedef {{entry:WireRequest,response:import("node:http").ServerResponse,released:boolean,aborted:boolean,release:()=>void}} HeldReply
 * @typedef {{kind:"hold",value:SessionPolicy}|{kind:"fail"|"malformed",value?:undefined}|null} PolicyBoundary
 * @typedef {{theme:"light"|"dark",surface:"profile"|"policy"|"widget",initialPolicy?:"fail"|null}} SessionsFixtureOptions
 * @typedef {{rows:Map<SyntheticOwner,ProfileRow>,requests:WireRequest[],unexpected:string[],errors:string[],console:WireConsole[],failures:WireFailure[],external:ExternalRequest[],commits:WireCommit[],holds:Set<HeldReply>,holdHistory:HeldReply[],sockets:Set<import("node:net").Socket>,failPut:number,holdPut:boolean,nextPolicy:PolicyBoundary,origin:string,closing:boolean}} SessionsFixtureState
 * @typedef {Awaited<ReturnType<typeof prepareSessionsBrowserAssets>>["receipt"]} SessionsFixtureIdentity
 * @typedef {{listening:boolean,openSockets:number,heldResponses:number,requests:WireRequest[],commits:WireCommit[],unexpected:string[],errors:string[],external:ExternalRequest[],failures:WireFailure[],console:WireConsole[],identity:SessionsFixtureIdentity}} SessionsFixtureReceipt
 * @typedef {{state:SessionsFixtureState,identity:SessionsFixtureIdentity,failNextPut:()=>void,holdNextPut:()=>void,policy:(kind:"hold"|"fail"|"malformed",value?:SessionPolicy)=>void,seed:(owner:SyntheticOwner,gap:number|null)=>void,autoOverlay:(owner:SyntheticOwner,value:boolean)=>void,releaseBodies:()=>void,api:(method:string,endpoint:string)=>WireRequest[],close:()=>Promise<SessionsFixtureReceipt>}} SessionsBrowserFixture
 */

const sha = value => createHash("sha256").update(value).digest("hex");
const OWNERS = new Set(["synthetic-a", "synthetic-b"]);
const POLICY = "/v1/me/session-policy";
const PROFILE = "/v1/me/profile";
const MAX_LEDGER = 512;
const ENTRY = String.raw`
import React,{useLayoutEffect,useState,useSyncExternalStore}from"react";
import{createRoot}from"react-dom/client";
import{SWRConfig,unstable_serialize,useSWRConfig}from"swr";
import{useAuth}from"@clerk/nextjs";
import{SettingsProfile}from"@/components/analyzer/settings/SettingsProfile";
import{SettingsContextProvider}from"@/components/analyzer/settings/SettingsContext";
import{ToastProvider}from"@/components/ui/Toast";
import{useSessionPolicy}from"@/lib/session-policy";
import{ModeRunner}from"@/components/analyzer/arcade/ModeRunner";
import{TodaySurface}from"@/components/analyzer/arcade/surfaces/Today";
import{firstGameOfDay}from"@/components/analyzer/arcade/modes/quizzes/firstGameOfDay";
import{useArcadeData}from"@/components/analyzer/arcade/hooks/useArcadeData";
import{AnalysisGamesProvider}from"@/components/analyzer/arcade/hooks/useAnalysisGames";
import{CustomBuildCatalogProvider}from"@/components/builds/useCustomBuildCatalog";
import{SessionWidget}from"@/components/overlay/widgets/SessionWidget";

const observations=[],faults=[];
function record(list,value){if(list.length>=300)throw Error("Fixture observation limit");list.push(value)}
class FaultCache extends Map{
 target=null;
 *keys(){for(const key of super.keys()){if(this.target===key){this.target=null;record(faults,{key,at:performance.now()});throw Error("Synthetic policy enumeration fault")}yield key}}
}
const cache=new FaultCache(),provider=()=>cache;
const swr={provider,revalidateOnFocus:false,revalidateOnReconnect:false,shouldRetryOnError:false};
let resolvedDedupingInterval=null;
function CachePolicy(){const config=useSWRConfig();useLayoutEffect(()=>{resolvedDedupingInterval=config.dedupingInterval});return null}
let uiState={policyVisible:true,epoch:0,widget:"cloud45"};const uiListeners=new Set();
const subscribe=fn=>{uiListeners.add(fn);return()=>uiListeners.delete(fn)};
function update(patch){uiState={...uiState,...patch};for(const fn of uiListeners)fn()}
function Diagnostic(){const auth=useAuth(),result=useSessionPolicy();
 useLayoutEffect(()=>{record(observations,{owner:auth.userId,epoch:uiState.epoch,gap:result.policy?.gapMinutes??null,source:result.policy?.source??null,loading:result.loading,error:result.error??null,at:performance.now()})});
 return <output aria-label="Observed session policy" data-testid="policy-observation" className="block break-words rounded border border-border p-3 text-caption text-text">
 {result.policy?String(result.policy.gapMinutes)+" minutes / "+result.policy.source:result.loading?"Current policy loading":"Current policy unavailable"}</output>
}
function PolicySurface(){const source=useArcadeData();return <>
 <section aria-label="Direct session quiz"><h2 className="font-display text-h3">Session quiz</h2><ModeRunner mode={firstGameOfDay} isDaily={false} dataSource={source}/></section>
 <section aria-label="Actual Today surface"><h2 className="font-display text-h3">Today</h2><TodaySurface/></section></>}
function WidgetPreview(){const state=useSyncExternalStore(subscribe,()=>uiState);const active={wins:2,losses:1,games:3,sessionStartedAt:"2026-10-27T12:00:00Z",sessionGapMinutes:240,sessionPolicySource:"auto-overlay",storedSessionGapMinutes:null};
 const cloud=state.widget==="cloud45"?{wins:0,losses:0,games:0,sessionGapMinutes:45,sessionPolicySource:"preference",storedSessionGapMinutes:45}:undefined;
 const live=state.widget==="none"?null:{session:state.widget==="legacy"?{wins:1,losses:0,games:1}:state.widget==="auto90"?{wins:0,losses:0,games:0,sessionGapMinutes:90,sessionPolicySource:"auto-player",storedSessionGapMinutes:null}:active};
 return <section aria-label="Actual broadcast widget preview"><div data-testid="widget-canvas" style={{position:"relative",minHeight:380,width:"100%"}} className="rounded border border-border bg-bg-surface"><SessionWidget live={live} session={cloud}/></div></section>}
function App(){const auth=useAuth(),state=useSyncExternalStore(subscribe,()=>uiState);const surface=window.sessionsConfig.surface;
 return <SWRConfig value={swr}><CachePolicy/><ToastProvider><SettingsContextProvider>
 <main className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 text-text">
 <h1 className="font-display text-h2">Sessions component verification</h1>
 <p className="text-caption text-text-muted">Synthetic loopback data. No real account or provider writes.</p>
 <aside aria-label="Fixture boundaries" className="flex flex-wrap gap-3">
 {["synthetic-a","synthetic-b"].map(owner=><button className="min-h-11 rounded border border-border px-3" type="button" key={owner} onClick={()=>window.sessionsAuth.set(owner)}>Owner {owner}</button>)}
 <output aria-label="Fixture owner">{auth.userId}</output>
 {surface!=="widget"?<><button className="min-h-11 rounded border border-border px-3" type="button" onClick={()=>update({policyVisible:false})}>Hide policy reader</button><button className="min-h-11 rounded border border-border px-3" type="button" onClick={()=>update({policyVisible:true,epoch:state.epoch+1})}>Remount policy reader</button></>:null}
 </aside>
 {surface!=="widget"&&state.policyVisible?<section key={state.epoch} data-testid="policy-lifetime" className="space-y-5"><Diagnostic/>{surface==="policy"?<AnalysisGamesProvider enabled><CustomBuildCatalogProvider><PolicySurface/></CustomBuildCatalogProvider></AnalysisGamesProvider>:null}</section>:null}
 {surface==="profile"?<section aria-label="Actual Profile settings"><SettingsProfile/></section>:surface==="widget"?<WidgetPreview/>:null}
 </main></SettingsContextProvider></ToastProvider></SWRConfig>
}
window.sessionsBrowser={observations,faults,cacheDedupingInterval:()=>resolvedDedupingInterval,cacheSnapshot:()=>Array.from(Map.prototype.entries.call(cache)).map(([key,value])=>({key,data:value?.data})),data:(owner,endpoint)=>cache.get(unstable_serialize(["authenticated-api",owner,endpoint]))?.data,
 armCacheFault:owner=>{const key=unstable_serialize(["authenticated-api",owner,"/v1/me/session-policy"]);if(!cache.has(key))throw Error("Policy key not established");cache.target=key},
 setWidget:value=>{if(!["cloud45","auto90","active240","legacy","none"].includes(value))throw Error("Unknown widget boundary");update({widget:value})},
 unmount:()=>root.unmount()};
const root=createRoot(document.getElementById("root"));root.render(<App/>);
`;

const AUTH = String.raw`
import{useSyncExternalStore}from"react";
let owner=window.sessionsConfig.owner,held=null,armed=false,serial=0;const listeners=new Set(),events=[];
const subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
const getToken=async()=>{const issuingOwner=owner,token="fixture-"+issuingOwner+"-"+(++serial);events.push({kind:"token",owner:issuingOwner,serial});
 if(armed){armed=false;await new Promise(resolve=>{held={resolve,owner:issuingOwner,token};events.push({kind:"held",owner:issuingOwner,token})})}return token};
window.sessionsAuth={events,set:next=>{if(!["synthetic-a","synthetic-b"].includes(next))throw Error("Unknown owner");owner=next;events.push({kind:"owner",owner});for(const fn of listeners)fn()},
 arm:()=>{if(armed||held)throw Error("Auth hold already active");armed=true},release:()=>{if(!held)throw Error("No auth hold");const value=held;held=null;events.push({kind:"release",owner:value.owner,token:value.token});value.resolve()},
 snapshot:()=>({owner,armed,held:held?{owner:held.owner,token:held.token}:null})};
export function useAuth(){const userId=useSyncExternalStore(subscribe,()=>owner);return{userId,isLoaded:true,isSignedIn:true,getToken}}
export function useUser(){const{userId}=useAuth();return{isLoaded:true,isSignedIn:true,user:{id:userId,username:userId,firstName:"Synthetic",primaryEmailAddress:null}}}
`;
const ADAPTERS = {
  "@clerk/nextjs": AUTH,
  "next/link": `import React from"react";export default React.forwardRef(function Link({href,prefetch,scroll,replace,onNavigate,...props},ref){return <a {...props} ref={ref} href={typeof href==="string"?href:"#"}/>})`,
  "next/navigation": `export const useRouter=()=>({push(){throw Error("Unexpected fixture navigation")},replace(){throw Error("Unexpected fixture navigation")},refresh(){throw Error("Unexpected fixture navigation")}});export const usePathname=()=>location.pathname;export const useSearchParams=()=>new URLSearchParams(location.search);`,
  "next/image": `import React from"react";export default function Image({priority,fill,quality,placeholder,blurDataURL,unoptimized,loader,...props}){return <img {...props}/>}`,
};

function bounded(list, value) {
  if (list.length >= MAX_LEDGER) throw new Error("Fixture ledger limit exceeded");
  list.push(value);
}
function relativeFile(root, name) {
  const target = path.resolve(root, name);
  if (!name || path.isAbsolute(name) || !target.startsWith(root + path.sep)) throw new Error(`Invalid pinned path ${name}`);
  return target;
}

/** Future root-only preparation. Requires the integrated shipping fingerprint.
 * prepareOnly permits bundle fingerprint discovery, never starts a listener. */
export async function prepareSessionsBrowserAssets({ prepareOnly = false } = {}) {
  const webRoot = process.cwd(), workspace = path.resolve(webRoot, "../..");
  const fingerprintPath = process.env.SESSIONS_BROWSER_FINGERPRINT;
  if (!fingerprintPath) throw new Error("Root must provide SESSIONS_BROWSER_FINGERPRINT after final source integration");
  const fingerprint = JSON.parse(await readFile(fingerprintPath, "utf8"));
  if (path.resolve(fingerprint.workspace) !== workspace || !fingerprint.sourceId || !Array.isArray(fingerprint.files)) throw new Error("Invalid source admission fingerprint");
  const pinned = new Map(fingerprint.files.map(row => [row.path.replaceAll("\\", "/"), row.sha256]));
  for (const [file, expected] of pinned) if (sha(await readFile(relativeFile(workspace, file))) !== expected) throw new Error(`Source fingerprint changed: ${file}`);
  if (!Array.isArray(fingerprint.dependencies) || fingerprint.dependencies.length < 3) throw new Error("Root must pin installed package metadata");
  for (const row of fingerprint.dependencies) if (sha(await readFile(relativeFile(webRoot, row.path))) !== row.sha256) throw new Error(`Installed dependency changed: ${row.path}`);
  const buildId = (await readFile(path.join(webRoot, ".next/BUILD_ID"), "utf8")).trim();
  if (buildId !== fingerprint.buildId) throw new Error("Fixture CSS must belong to the root-admitted own build");
  if (!Array.isArray(fingerprint.assets) || fingerprint.assets.length > 512) throw new Error("Invalid finite asset manifest");
  const assets = new Map(), evidence = []; let assetBytes = 0;
  for (const row of fingerprint.assets) {
    if (!/^\/[A-Za-z0-9_./-]+$/.test(row.url) || row.url.includes("..") || assets.has(row.url)) throw new Error("Invalid exact asset URL");
    const bytes = await readFile(relativeFile(webRoot, row.path));
    if (sha(bytes) !== row.sha256 || bytes.length > 8 * 1024 * 1024) throw new Error(`Asset fingerprint changed: ${row.path}`);
    assetBytes += bytes.length; if (assetBytes > 32 * 1024 * 1024) throw new Error("Fixture asset bound exceeded");
    assets.set(row.url, { body: bytes, contentType: row.contentType }); evidence.push({ ...row, bytes: bytes.length });
  }
  const css = fingerprint.assets.filter(row => row.kind === "production-css");
  if (!css.length || !assets.has("/fixture-hanken.woff2") || !assets.has("/fixture-bricolage.woff2")) throw new Error("Own production CSS and both committed fonts are required");
  const result = await build({
    stdin: { contents: ENTRY, loader: "tsx", resolveDir: webRoot }, bundle: true, write: false, minify: true, metafile: true,
    format: "iife", platform: "browser", jsx: "automatic", tsconfig: path.join(webRoot, "tsconfig.json"),
    define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_BASE": "window.location.origin" },
    plugins: [{ name: "sessions-external-framework-boundaries-only", setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(ADAPTERS, args.path) ? { path: args.path, namespace: "sessions-boundary" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "sessions-boundary" }, args => ({ contents: ADAPTERS[args.path], loader: "tsx", resolveDir: webRoot }));
    } }],
  });
  const bundle = Buffer.from(result.outputFiles[0].contents);
  if (bundle.length > 8 * 1024 * 1024) throw new Error("Unexpected fixture import expansion");
  const inputs = [];
  for (const name of Object.keys(result.metafile.inputs)) {
    if (name === "<stdin>" || name.startsWith("sessions-boundary:")) continue;
    const absolute = path.resolve(webRoot, name), bytes = await readFile(absolute);
    const relative = path.relative(workspace, absolute).replaceAll("\\", "/");
    const digest = sha(bytes);
    if (!absolute.includes(path.sep + "node_modules" + path.sep) && pinned.get(relative) !== digest) throw new Error(`Unadmitted product import: ${relative}`);
    inputs.push({ path: relative, sha256: digest, bytes: bytes.length });
  }
  const bundleSha256 = sha(bundle);
  if (!prepareOnly && (!fingerprint.bundleSha256 || bundleSha256 !== fingerprint.bundleSha256)) throw new Error("Root must review/pin the actual fixture bundle before browser admission");
  const receipt = { sourceId: fingerprint.sourceId, buildId, bundleSha256, adapters: Object.keys(ADAPTERS), inputs, assets: evidence };
  return { assets, css, bundle, receipt };
}

/**
 * @param {ProfileRow} row
 * @returns {SessionPolicy}
 */
function effective(row) {
  return row.sessionGapMinutes === null
    ? { gapMinutes: row.overlay ? 240 : 90, source: row.overlay ? "auto-overlay" : "auto-player", storedGapMinutes: null }
    : { gapMinutes: row.sessionGapMinutes, source: "preference", storedGapMinutes: row.sessionGapMinutes };
}
function profile(row) {
  const { overlay, ...fields } = row;
  return { ...fields, detectedPulseIds: [], sessionPolicy: effective(row) };
}
const OFF_PUBLIC_PROFILE = Object.freeze({ publicDisplayName: "Synthetic player", enabled: false, legacyPublic: false, slug: null, updatedAt: null, renameAvailableAt: null,
  replaySharingEnabled: false, revision: 0, showReplays: false, showChannels: false, showRecentForm: false, showMmrHistory: false, showSeasons: false, showMaps: false });

/** Real local HTTP, synthetic records, no interception or fetch replacement.
 * @param {import("@playwright/test").Page} page
 * @param {SessionsFixtureOptions} options
 * @returns {Promise<SessionsBrowserFixture>}
 */
export async function openSessionsBrowserFixture(page, { theme, surface, initialPolicy = null }) {
  if (!["light", "dark"].includes(theme) || !["profile", "policy", "widget"].includes(surface)) throw new Error("Unknown fixture surface");
  if (initialPolicy !== null && initialPolicy !== "fail") throw new Error("Unknown initial policy boundary");
  const prepared = await prepareSessionsBrowserAssets();
  /** @type {SessionsFixtureState} */
  const state = { rows: new Map([
    ["synthetic-a", { battleTag: "SyntheticA#1234", displayName: "Synthetic A", pulseIds: [], region: "us", preferredRace: "Protoss", sessionGapMinutes: null, overlay: false }],
    ["synthetic-b", { battleTag: "SyntheticB#1234", displayName: "Synthetic B", pulseIds: [], region: "eu", preferredRace: "Protoss", sessionGapMinutes: 45, overlay: true }],
  ]), requests: [], unexpected: [], errors: [], console: [], failures: [], external: [], commits: [], holds: new Set(), holdHistory: [], sockets: new Set(),
    failPut: 0, holdPut: false, nextPolicy: initialPolicy ? { kind: initialPolicy } : null, origin: "", closing: false };
  const assetMap = new Map(prepared.assets);
  assetMap.set("/fixture.js", { body: prepared.bundle, contentType: "text/javascript; charset=utf-8" });
  const fontCss = '@font-face{font-family:SessionsHanken;src:url("/fixture-hanken.woff2") format("woff2");font-weight:100 900;font-display:swap}@font-face{font-family:SessionsBricolage;src:url("/fixture-bricolage.woff2") format("woff2");font-weight:600 800;font-display:swap}:root{--font-sans:SessionsHanken;--font-display:SessionsBricolage}';
  assetMap.set("/fixture-fonts.css", { body: fontCss, contentType: "text/css; charset=utf-8" });
  const send = (response, status, body, type = "application/json; charset=utf-8") => {
    const bytes = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    response.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(bytes), "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(bytes);
  };
  const heldReply = (response, value, entry) => {
    if (state.holds.size >= 2) throw new Error("Held response limit");
    const body = JSON.stringify(value);
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
    response.write(body.slice(0, 1));
    const hold = { entry, response, released: false, aborted: false, release() { this.released = true; entry.releaseAttempted = true; state.holds.delete(this); if (!response.destroyed) response.end(body.slice(1)); } };
    state.holds.add(hold); bounded(state.holdHistory, hold); entry.held = true;
    response.once("close", () => { if (!response.writableEnded) { hold.aborted = true; entry.aborted = true; } state.holds.delete(hold); });
  };
  const current = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", state.origin || "http://127.0.0.1");
      const method = request.method ?? "";
      if (url.origin !== state.origin || request.headers.host !== new URL(state.origin).host || !["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "") || request.url?.includes("..")) throw new Error("Invalid loopback host/peer/path");
      if ([...url.searchParams.keys()].length !== new Set(url.searchParams.keys()).size) throw new Error("Duplicate query field");
      if (method === "GET" && (request.headers["transfer-encoding"] || Number(request.headers["content-length"] ?? 0) !== 0)) throw new Error("GET body is not permitted");
      const entry = { method, path: url.pathname, query: url.search, status: 0, owner: null, complete: false, at: Date.now(), finishedAt: null };
      bounded(state.requests, entry); response.once("finish", () => { entry.complete = true; entry.finishedAt = Date.now(); });
      if (method === "GET" && !url.search && assetMap.has(url.pathname)) { entry.status = 200; const item = assetMap.get(url.pathname); send(response, 200, item.body, item.contentType); return; }
      if (method === "GET" && url.pathname === "/fixture-config.js" && !url.search) { entry.status = 200; send(response, 200, "window.sessionsConfig=" + JSON.stringify({ owner: "synthetic-a", surface }) + ";", "text/javascript"); return; }
      if (method === "GET" && url.pathname === "/" && !url.search) {
        entry.status = 200; response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
        send(response, 200, '<!doctype html><html lang="en" class="' + theme + '" data-theme="' + theme + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>Sessions verification</title>' + prepared.css.map(row => '<link rel="stylesheet" href="' + row.url + '">').join("") + '<link rel="stylesheet" href="/fixture-fonts.css"></head><body class="bg-bg font-sans text-text"><div id="root"></div><script src="/fixture-config.js"></script><script src="/fixture.js"></script></body></html>', "text/html; charset=utf-8"); return;
      }
      const match = /^Bearer fixture-(synthetic-[ab])-\d+$/.exec(request.headers.authorization ?? "");
      const owner = match?.[1]; entry.owner = owner ?? null;
      if (!OWNERS.has(owner)) throw new Error("Unknown synthetic owner/token");
      const row = state.rows.get(owner), query = Object.fromEntries(url.searchParams);
      if (url.pathname === PROFILE && !url.search) {
        if (surface !== "profile") throw new Error("Policy/widget surface cannot fetch Profile");
        if (method === "GET") { entry.status = 200; send(response, 200, profile(row)); return; }
        if (method === "PUT") {
          if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) throw new Error("Profile JSON content type required");
          let body = ""; for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 16_384) throw new Error("Profile body limit"); }
          const value = JSON.parse(body), allowed = ["battleTag", "pulseIds", "region", "preferredRace", "displayName", "sessionGapMinutes"];
          if (!value || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)) || !Object.hasOwn(value, "sessionGapMinutes") || !(value.sessionGapMinutes === null || Number.isInteger(value.sessionGapMinutes) && value.sessionGapMinutes >= 15 && value.sessionGapMinutes <= 480)) throw new Error("Invalid synthetic Profile write");
          if (["battleTag", "region", "preferredRace", "displayName"].some(key => Object.hasOwn(value, key) && (typeof value[key] !== "string" || value[key].length > 256)) || !Array.isArray(value.pulseIds) || value.pulseIds.length > 20 || value.pulseIds.some(id => typeof id !== "string" || id.length > 64)) throw new Error("Invalid synthetic Profile field shape");
          entry.body = value;
          if (state.failPut) { state.failPut--; entry.status = 503; send(response, 503, { error: { code: "fixture_unavailable", message: "Synthetic save unavailable. Try again." } }); return; }
          Object.assign(row, value); bounded(state.commits, { owner, body: structuredClone(value), policy: effective(row) }); entry.status = 200;
          if (state.holdPut) { state.holdPut = false; heldReply(response, profile(row), entry); return; }
          send(response, 200, profile(row)); return;
        }
      }
      if (method !== "GET") throw new Error("Only the planned Profile PUT is permitted");
      if (url.pathname === POLICY && !url.search) {
        const boundary = state.nextPolicy; state.nextPolicy = null;
        if (boundary?.kind === "fail") { entry.status = 503; send(response, 503, { error: { code: "fixture_policy_unavailable", message: "Synthetic policy unavailable" } }); return; }
        entry.status = 200;
        if (boundary?.kind === "hold") { heldReply(response, boundary.value, entry); return; }
        send(response, 200, boundary?.kind === "malformed" ? { gapMinutes: "90", source: "auto-player", storedGapMinutes: null } : effective(row)); return;
      }
      if (surface === "profile" && !url.search && url.pathname === "/v1/me/player-channels") { entry.status = 200; send(response, 200, { entries: [], identities: [], canConnect: false }); return; }
      if (surface === "profile" && !url.search && url.pathname === "/v1/me/public-profile") { entry.status = 200; send(response, 200, OFF_PUBLIC_PROFILE); return; }
      if (surface === "policy") {
        const empty = !url.search && ["/v1/builds", "/v1/matchups", "/v1/maps"].includes(url.pathname) ? []
          : url.pathname === "/v1/opponents" && Object.keys(query).length === 1 && query.limit === "500" ? { items: [], nextBefore: null }
          : url.pathname === "/v1/games/analysis-corpus" && Object.keys(query).length === 1 && query.limit === "2000" ? { items: [], nextCursor: null }
          : url.pathname === "/v1/custom-builds" && Object.keys(query).length === 2 && query.view === "summary" && query.limit === "100" ? { items: [], nextCursor: null }
          : url.pathname === "/v1/community/arcade-universe" && Object.keys(query).length === 1 && query.perMatchup === "12" ? { items: [] }
          : !url.search && url.pathname === "/v1/summary" ? { totals: { total: 0, wins: 0, losses: 0, winRate: 0 } }
          : !url.search && url.pathname === "/v1/seasons" ? { mapPool: [] }
          : !url.search && url.pathname === "/v1/arcade/unit-stats" ? { scannedGames: 0, builtByUnit: {}, totalUnitsLost: 0, lostGames: 0 }
          : !url.search && url.pathname === "/v1/me/preferences/arcade" ? {} : undefined;
        if (empty !== undefined) { entry.status = 200; send(response, 200, empty); return; }
      }
      throw new Error(`Unclassified transport ${method} ${url.pathname}${url.search}`);
    } catch (error) {
      bounded(state.unexpected, String(error)); request.resume(); if (!response.headersSent) send(response, 400, { error: { code: "fixture_contract_failure" } }); else response.destroy();
    }
  });
  current.maxConnections = 24; current.maxRequestsPerSocket = 64; current.headersTimeout = 5000; current.requestTimeout = 20_000; current.keepAliveTimeout = 1000;
  current.on("connection", socket => { state.sockets.add(socket); socket.setTimeout(20_000, () => socket.destroy()); socket.once("close", () => state.sockets.delete(socket)); });
  current.on("error", error => bounded(state.errors, String(error)));
  current.on("clientError", (error, socket) => { bounded(state.errors, String(error)); socket.destroy(); });
  const onRequest = request => { const url = new URL(request.url()); if (["http:", "https:"].includes(url.protocol) && url.origin !== state.origin) bounded(state.external, { kind: "request", url: url.href }); };
  const onFailed = request => bounded(state.failures, { url: request.url(), method: request.method(), error: request.failure()?.errorText ?? "unknown", closing: state.closing });
  const onConsole = message => { if (["error", "warning"].includes(message.type())) bounded(state.console, { type: message.type(), text: message.text(), location: message.location() }); };
  const onError = error => bounded(state.errors, error.message);
  page.on("request", onRequest); page.on("requestfailed", onFailed); page.on("console", onConsole); page.on("pageerror", onError);
  const snapshot = () => ({ listening: current.listening, openSockets: state.sockets.size, heldResponses: state.holds.size, requests: state.requests, commits: state.commits,
    unexpected: state.unexpected, errors: state.errors, external: state.external, failures: state.failures, console: state.console, identity: prepared.receipt });
  const closeOwned = async () => {
    state.closing = true;
    if (!page.isClosed()) { await page.evaluate(() => window.sessionsBrowser?.unmount()).catch(error => bounded(state.errors, String(error))); await page.close(); }
    for (const hold of state.holdHistory) if (!hold.released) hold.release();
    const socketClosures = [...state.sockets].map(socket => new Promise(resolve => { socket.once("close", resolve); socket.destroy(); }));
    await Promise.all([new Promise(resolve => { current.close(resolve); current.closeAllConnections(); }), ...socketClosures]);
    page.removeListener("request", onRequest); page.removeListener("requestfailed", onFailed); page.removeListener("console", onConsole); page.removeListener("pageerror", onError);
    return snapshot();
  };
  try {
    await new Promise((resolve, reject) => { current.once("error", reject); current.listen(0, "127.0.0.1", () => { current.removeListener("error", reject); resolve(); }); });
    state.origin = `http://127.0.0.1:${current.address().port}`;
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.goto(state.origin, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
  } catch (error) { error.sessionsWireAndClosure = await closeOwned(); throw error; }
  return {
    state, identity: prepared.receipt,
    failNextPut() { state.failPut = 1; }, holdNextPut() { state.holdPut = true; },
    policy(kind, value) {
      if (state.nextPolicy || !["hold", "malformed", "fail"].includes(kind)) throw new Error("Invalid or already armed policy boundary");
      if (kind === "hold" && (!value || Object.keys(value).sort().join(",") !== "gapMinutes,source,storedGapMinutes" || value.source !== "preference" || value.gapMinutes !== value.storedGapMinutes || !Number.isInteger(value.gapMinutes) || value.gapMinutes < 15 || value.gapMinutes > 480)) throw new Error("Invalid held policy DTO");
      state.nextPolicy = { kind, value };
    },
    seed(owner, gap) { if (!OWNERS.has(owner) || !(gap === null || Number.isInteger(gap) && gap >= 15 && gap <= 480)) throw new Error("Invalid synthetic seed"); state.rows.get(owner).sessionGapMinutes = gap; },
    autoOverlay(owner, value) { if (!OWNERS.has(owner) || typeof value !== "boolean") throw new Error("Invalid synthetic overlay context"); state.rows.get(owner).overlay = value; },
    releaseBodies() { for (const hold of state.holdHistory) if (!hold.released) hold.release(); },
    api(method, endpoint) { return state.requests.filter(row => row.method === method && row.path === endpoint); },
    close: closeOwned,
  };
}
