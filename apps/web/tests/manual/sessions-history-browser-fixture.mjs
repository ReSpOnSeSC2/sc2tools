import { build } from "esbuild";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { localDayWindow } from "../../../api/src/services/sessionHistoryWindow.js";
import { historyFixtureData, applyCurrentIngest } from "./sessions-history-fixture-data.mjs";

/** @typedef {'hold'|'body'|'stale'|'busy'|'context_required'|'narrow_window'|'empty'|null} HistoryBoundary */
/** @typedef {{owner:string|null,path:string,query:string,complete:boolean,method:string,status:number|null,atMs:number,authSerial?:number,held?:boolean,aborted?:boolean,headersSent?:boolean,prefixBytes?:number,finalBytesQueued?:number,releaseAttempted?:boolean,serverEndQueued?:boolean}} HistoryRequest */
/** @typedef {{type:string,text:string,location:{url:string,lineNumber:number,columnNumber:number}}} ConsoleEntry */
/** @typedef {{url:string,method:string,error:string|undefined,closing:boolean,authSerial?:number}} FailureEntry */
/** @typedef {{entry:HistoryRequest,release:()=>void}} BodyHold */
/** @typedef {{index:number,owner:string|null,connected:boolean,disconnected:boolean}} RealtimeEntry */
/** @typedef {{theme:'light'|'dark',long:boolean,raw:boolean,origin:string,next:HistoryBoundary,currentViews:Record<string,string>,held:Array<()=>void>,bodyHolds:BodyHold[],requests:HistoryRequest[],errors:string[],console:ConsoleEntry[],failures:FailureEntry[],closing:boolean,unexpected:string[],external:string[],sockets:Set<import('node:net').Socket>,expectedRealtimeSockets:number}} HistoryState */
/** @typedef {{long?:boolean,raw?:boolean,initialMode?:HistoryBoundary,initialHref?:string}} HistoryOptions */
/** @returns {{promise:Promise<void>,resolve:()=>void}} */
function historyDeferred() {
  /** @type {()=>void} */ let complete = () => undefined;
  /** @type {Promise<void>} */ const promise = new Promise(resolve => { complete = () => resolve(undefined); });
  return { promise, resolve: () => complete() };
}
const sha = value => createHash("sha256").update(value).digest("hex");
function relativeFile(root, name) {
  const target = path.resolve(root, name);
  if (!name || path.isAbsolute(name) || !target.startsWith(root + path.sep)) throw new Error("Invalid admitted file path");
  return target;
}
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
const SOCKET = String.raw`
const sockets=[];
window.historyRealtime={snapshot:()=>sockets.map((socket,index)=>({index,connected:socket.connected,disconnected:socket.disconnected,owner:socket.owner})),
 fire:(index,event,payload)=>{const socket=sockets[index];if(!socket)throw Error("Unknown socket");socket.fire(event,payload)}};
export function io(url,options){const events=new Map();const socket={connected:false,disconnected:false,owner:null,
 on(event,callback){events.set(event,callback);return socket},off(event){if(event)events.delete(event);else events.clear();return socket},
 fire(event,payload){events.get(event)?.(payload)},
 connect(){options.auth(auth=>{socket.owner=/^fixture-(synthetic-[ab])-\d+$/.exec(auth.token??"")?.[1]??null;socket.connected=true;socket.fire("connect")});return socket},
 disconnect(){socket.disconnected=true;socket.connected=false;return socket}};sockets.push(socket);queueMicrotask(()=>socket.connect());return socket}
`;
const ADAPTERS = {
  "@clerk/nextjs": AUTH,
  "socket.io-client": SOCKET,
  "next/link": `import React from'react';export default React.forwardRef(function Link({href,children,prefetch,scroll,replace,onClick,onNavigate,...props},ref){return <a ref={ref} href={href} {...props} onClick={event=>{onClick?.(event);if(event.defaultPrevented||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||event.button!==0||(event.currentTarget.target&&event.currentTarget.target!=='_self')||event.currentTarget.hasAttribute('download'))return;event.preventDefault();let prevented=false;onNavigate?.({preventDefault(){prevented=true}});if(!prevented)window.sessionHistoryNavigation.navigate(href,replace)}}>{children}</a>});`,
  "next/navigation": `import{useSyncExternalStore}from'react';const subscribe=listener=>window.sessionHistoryNavigation.subscribe(listener);export const usePathname=()=>useSyncExternalStore(subscribe,()=>location.pathname);export const useSearchParams=()=>new URLSearchParams(useSyncExternalStore(subscribe,()=>location.search));export const useRouter=()=>({push:href=>window.sessionHistoryNavigation.navigate(href),replace:href=>window.sessionHistoryNavigation.navigate(href,true)});`,
  "next/dynamic": `import React,{lazy,Suspense}from'react';export default function dynamic(loader,options={}){const Loaded=lazy(async()=>{const value=await loader();return{default:value.default??value}});return function Dynamic(props){return <Suspense fallback={options.loading?React.createElement(options.loading):null}><Loaded {...props}/></Suspense>}}`,
  "next/image": `import React from'react';export default function Image({priority,fill,quality,placeholder,blurDataURL,unoptimized,loader,...props}){return <img {...props}/>}`,
};
async function historyAdmission() {
  const webRoot = process.cwd(), workspace = path.resolve(webRoot, "../.."), file = process.env.SESSIONS_HISTORY_BROWSER_FINGERPRINT;
  if (!file) throw new Error("Root must supply a fresh Sessions history source/build fingerprint");
  const fingerprint = JSON.parse(await readFile(file, "utf8"));
  if (fingerprint.kind !== "sessions-history" || path.resolve(fingerprint.workspace) !== workspace || !fingerprint.sourceId || !Array.isArray(fingerprint.files)) throw new Error("Invalid history source admission");
  const pinned = new Map(fingerprint.files.map(row => [row.path.replaceAll("\\", "/"), row.sha256]));
  if (pinned.size !== fingerprint.files.length) throw new Error("Duplicate history source admission");
  await admitHistoryFiles(workspace, pinned); await admitHistoryDependencies(webRoot, fingerprint);
  return { webRoot, workspace, fingerprint, pinned };
}
async function admitHistoryFiles(workspace, pinned) {
  for (const name of ["sessions-history-entry.tsx", "sessions-history-browser-fixture.mjs", "sessions-history-fixture-data.mjs", "sessions-history-browser.spec.ts", "sessions-history-browser-playwright.config.ts"]) if (!pinned.has(`apps/web/tests/manual/${name}`)) throw new Error(`Unadmitted history fixture source ${name}`);
  const backend = ["config/accountFilter.json", "services/sessionHistoryDescriptor.js", "services/sessionHistoryWindow.js", "services/sessions.js", "services/trendsRequests.js", "util/accountFilter.js", "util/exactMapFilter.js", "util/gameVisibility.js", "util/parseQuery.js", "util/patchEra.js", "util/regionFromToonHandle.js"];
  for (const name of backend) if (!pinned.has(`apps/api/src/${name}`)) throw new Error(`Unadmitted server-side day-window import ${name}`);
  for (const file of ["apps/web/tests/e2e/accessibility-check.ts", "apps/web/tests/e2e/accessibility-allowlist.json"]) if (!pinned.has(file)) throw new Error(`Unadmitted AA gate ${file}`);
  for (const [file, expected] of pinned) if (sha(await readFile(relativeFile(workspace, file))) !== expected) throw new Error(`Admitted source changed: ${file}`);
}
async function admitHistoryDependencies(webRoot, fingerprint) {
  if (!Array.isArray(fingerprint.dependencies) || fingerprint.dependencies.length < 3) throw new Error("Pin installed dependency metadata");
  for (const row of fingerprint.dependencies) if (sha(await readFile(relativeFile(webRoot, row.path))) !== row.sha256) throw new Error(`Installed dependency changed: ${row.path}`);
  const buildId = (await readFile(path.join(webRoot, ".next/BUILD_ID"), "utf8")).trim();
  if (buildId !== fingerprint.buildId) throw new Error("History CSS must belong to the admitted integrated build");
}
async function historyAsset(webRoot, row, assets) {
  if (!/^\/[A-Za-z0-9_./-]+$/.test(row.url) || row.url.includes("..") || assets.has(row.url)) throw new Error("Invalid finite asset URL");
  const bytes = await readFile(relativeFile(webRoot, row.path));
  if (sha(bytes) !== row.sha256 || bytes.length > 8 * 1024 * 1024) throw new Error(`Asset fingerprint changed: ${row.path}`);
  return bytes;
}
async function historyAssets(webRoot, fingerprint) {
  if (!Array.isArray(fingerprint.assets) || fingerprint.assets.length > 512) throw new Error("Invalid finite asset manifest");
  const assets = new Map(), evidence = []; let total = 0;
  for (const row of fingerprint.assets) {
    const bytes = await historyAsset(webRoot, row, assets); total += bytes.length;
    if (total > 32 * 1024 * 1024) throw new Error("History fixture asset bound exceeded");
    assets.set(row.url, { body: bytes, contentType: row.contentType }); evidence.push({ ...row, bytes: bytes.length });
  }
  const css = fingerprint.assets.filter(row => row.kind === "production-css");
  if (!css.length || !assets.has("/fixture-hanken.woff2") || !assets.has("/fixture-bricolage.woff2")) throw new Error("Own production CSS and both committed fonts are required");
  return { assets, evidence, css };
}
async function historyBundle(webRoot) {
  const ENTRY = await readFile(new URL("./sessions-history-entry.tsx", import.meta.url), "utf8");
  return build({ stdin: { contents: ENTRY, loader: "tsx", resolveDir: webRoot }, bundle: true, write: false, minify: true, metafile: true,
    format: "iife", platform: "browser", jsx: "automatic", tsconfig: path.join(webRoot, "tsconfig.json"),
    // Model build02 public values/defaults explicitly; no browser process shim.
    define: {
      "process.env.NODE_ENV": '"production"',
      "process.env.NEXT_PUBLIC_API_BASE": "window.location.origin",
      "process.env.NEXT_PUBLIC_GUIDES_ENABLED": '"on"',
      "process.env.NEXT_PUBLIC_REVIEWS_ENABLED": '"on"',
      "process.env.NEXT_PUBLIC_INSTANT_IMPORT": '"all"',
      "process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY": '"pk_live_Y2xlcmsuZXhhbXBsZS5jb20k"',
      "process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID": "undefined",
      "process.env.NEXT_PUBLIC_AUDIO_BASE": "undefined",
      "process.env.NEXT_PUBLIC_SPRITE_BASE": "undefined",
      "process.env.NEXT_PUBLIC_BUILD_SHA": "undefined",
      "process.env.NEXT_PUBLIC_SENTRY_DSN": "undefined",
      "process.env.NEXT_PUBLIC_SC2TOOLS_ENV": "undefined",
    },
    plugins: [{ name: "history-framework-boundaries-only", setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(ADAPTERS, args.path) ? { path: args.path, namespace: "history-boundary" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "history-boundary" }, args => ({ contents: ADAPTERS[args.path], loader: "tsx", resolveDir: webRoot }));
    } }],
  });
}
async function historyInputs(result, admission) {
  const inputs = [];
  for (const name of Object.keys(result.metafile.inputs)) {
    if (name === "<stdin>" || name.startsWith("history-boundary:")) continue;
    const absolute = path.resolve(admission.webRoot, name), bytes = await readFile(absolute);
    const relative = path.relative(admission.workspace, absolute).replaceAll("\\", "/"), digest = sha(bytes);
    if (!absolute.includes(path.sep + "node_modules" + path.sep) && admission.pinned.get(relative) !== digest) throw new Error(`Unadmitted product import: ${relative}`);
    inputs.push({ path: relative, sha256: digest, bytes: bytes.length });
  }
  return inputs;
}
export async function prepareSessionsHistoryBrowserAssets({ prepareOnly = false } = {}) {
  const admission = await historyAdmission(), { assets, evidence, css } = await historyAssets(admission.webRoot, admission.fingerprint);
  const result = await historyBundle(admission.webRoot), bundle = Buffer.from(result.outputFiles[0].contents), bundleSha256 = sha(bundle);
  if (bundle.length > 8 * 1024 * 1024) throw new Error("Unexpected history fixture import expansion");
  if (!prepareOnly && (!admission.fingerprint.bundleSha256 || bundleSha256 !== admission.fingerprint.bundleSha256)) throw new Error("Root must review and pin the fresh history bundle before browser admission");
  const inputs = await historyInputs(result, admission);
  return { assets, css, bundle, receipt: { sourceId: admission.fingerprint.sourceId, buildId: admission.fingerprint.buildId, bundleSha256, adapters: Object.keys(ADAPTERS), inputs, assets: evidence } };
}
const json = (value, status = 200) => ({ status, contentType: "application/json", body: Buffer.from(JSON.stringify(value)) });
function record(state, entry) {
  if (state.requests.length >= 512) throw new Error("History fixture request ledger exceeded");
  state.requests.push(entry);
}
function responseFor(state, url, owner) {
  const current = url.pathname === "/v1/sessions/current" || url.pathname.includes("/current-");
  const older = url.searchParams.has("before") || url.pathname.includes("-older");
  let value = historyFixtureData(owner, { current, older, tz: url.searchParams.get("tz") ?? "UTC", long: state.long, raw: state.raw });
  if (current && state.currentViews[owner] === "ingested") value = applyCurrentIngest(value);
  if (!current) { applyOutputWindow(value, url); applyMembership(value, url); }
  applyContext(value, url);
  if (url.pathname === "/v1/sessions/current") return currentResponse(value, state.currentViews[owner]);
  if (url.pathname === "/v1/sessions") return fixtureList(value, url, owner, older);
  if (url.pathname.endsWith(`/${value.session.id}`)) return fixtureDetail(value, url);
  state.unexpected.push(`Unrecognized locator ${url.pathname}`); return null;
}
function currentResponse(value, stage) {
  const response = { ...value.base, kind: "current", session: value.session, activity: value.session.active ? "active" : "last", manualAnchorAt: "2026-10-27T03:30:00.000Z" };
  if (stage !== "reset") return response;
  const anchor = "2026-10-27T06:00:00.000Z";
  return { ...emptyState(response), manualAnchorAt: anchor, window: { ...response.window, from: anchor, scanFrom: anchor } };
}
function fixtureList(value, url, owner, older) {
  const included = overlapsOutput(value), end = Date.parse(value.base.window.from);
  return { ...value.base, kind: "history", items: included ? [value.session] : [], nextBefore: included && !older ? fixtureCursor(owner, url) : null,
    nextWindow: { from: new Date(end - 30 * 86_400_000).toISOString(), to: value.base.window.from } };
}
function fixtureCursor(owner, url) { return `fixture-cursor-${owner}-${url.searchParams.get("race") ?? "all"}`; }
function applyMembership(value, url) {
  const race = url.searchParams.get("race");
  if (!["P", "T", "Z"].includes(race)) return;
  value.games = value.games.map(game => ({ ...game, myRace: race, ladderRace: value.mmr[0].comparable ? race : null, matchup: `${race}vT` }));
  value.mmr = value.mmr.map(track => ({ ...track, ladderRace: track.comparable ? race : null }));
  value.session.mmr = value.session.mmr.map(track => ({ ...track, ladderRace: track.comparable ? race : null }));
  value.session.matchups = value.session.matchups.map(row => ({ ...row, matchup: `${race}vT` }));
  value.base.definition.scopeHash += `-${race}`;
}
function applyOutputWindow(value, url) {
  if (url.searchParams.has("windowFrom")) { value.base.window.from = url.searchParams.get("windowFrom"); value.base.window.to = url.searchParams.get("windowTo"); }
  if (url.searchParams.has("day")) {
    const bounds = localDayWindow(url.searchParams.get("day"), value.base.window.tz);
    value.base.window.from = new Date(bounds.from).toISOString(); value.base.window.to = new Date(bounds.to).toISOString();
  }
}
function overlapsOutput(value) {
  return value.games.some(game => game.date >= value.base.window.from && game.date < value.base.window.to);
}
function applyContext(value, url) {
  const days = Number(url.searchParams.get("contextDays") ?? 0), window = value.base.window;
  window.contextDays = days;
  if (value.base.definition.mode === "current") return;
  const padding = Math.max(90 * 60_000, days * 86_400_000);
  window.scanFrom = new Date(Date.parse(window.from) - padding).toISOString();
  window.scanTo = new Date(Math.min(Date.parse(window.asOf), Date.parse(window.to) - 1 + padding)).toISOString();
}
function fixtureDetail(value, url) {
  const cursor = url.searchParams.get("gamesBefore"), offset = cursor === "games-50" ? 50 : cursor === "games-100" ? 100 : 0;
  const games = value.games.slice(offset, offset + 50), next = offset + games.length;
  if (value.base.definition.mode === "natural") {
    value.base.window.from = new Date(Date.parse(value.session.start) - 90 * 60_000).toISOString();
    value.base.window.to = new Date(Date.parse(value.session.end) + 90 * 60_000 + 1).toISOString();
  }
  applyContext(value, url);
  return { ...value.base, kind: "detail", session: value.session, games, gamePage: { limit: 50, count: games.length, total: value.games.length }, nextGamesBefore: next < value.games.length ? `games-${next}` : null, mmr: value.mmr };
}
function emptyState(value) {
  if (value.kind === "history") return { ...value, items: [], nextBefore: null };
  return { ...value, session: null, activity: "empty", games: [], mmr: [], nextGamesBefore: null, gamePage: { limit: 50, count: 0, total: 0 } };
}
function boundedState(value, kind) {
  const response = { ...value, status: kind, issue: { code: kind, message: kind === "context_required" ? "Complete boundaries need more context." : "This component exceeds the supported bound.", suggestedContextDays: kind === "context_required" ? 3 : null } };
  if (response.kind === "history") return { ...response, items: [], nextBefore: null, nextWindow: null };
  return { ...response, session: null, activity: "empty", games: [], mmr: [], nextGamesBefore: null, gamePage: { limit: 50, count: 0, total: 0 } };
}
function syntheticOwner(authorization) { return /^Bearer fixture-(synthetic-[ab])-\d+$/.exec(authorization ?? "")?.[1] ?? null; }
function currentQueryAllowed(url) {
  if (url.pathname !== "/v1/sessions/current" && !url.pathname.includes("/current-")) return true;
  return [...url.searchParams.keys()].every(key => ["tz", "contextDays", "gamesLimit", "gamesBefore"].includes(key));
}
function boundaryFailure(mode) {
  if (mode === "stale") return json({ error: "This session view changed", code: "session_view_changed" }, 409);
  if (mode === "busy") return json({ error: "Session history is temporarily unavailable", code: "session_history_unavailable" }, 503);
  return null;
}
function boundaryValue(value, mode) {
  if (mode === "empty") return emptyState(value);
  if (mode === "context_required" || mode === "narrow_window") return boundedState(value, mode);
  return value;
}
function cursorChanged(owner, url) { return url.searchParams.has("before") && url.searchParams.get("before") !== fixtureCursor(owner, url); }
async function apiResponse(state, url, authorization, response) {
  const owner = syntheticOwner(authorization);
  if (!owner) return json({ error: "Synthetic authorization required" }, 401);
  if (!currentQueryAllowed(url)) { state.unexpected.push("Current query contained a history filter"); return json({ error: "Unexpected current scope" }, 400); }
  /** @type {HistoryRequest} */
  const entry = { owner, authSerial: Number(/-(\d+)$/.exec(authorization)?.[1]), atMs: Date.now(), path: url.pathname, query: url.search, complete: false, method: "GET", status: null, held: false, aborted: false };
  record(state, entry); response.once("close", () => { if (!response.writableEnded) entry.aborted = true; });
  const mode = state.next; state.next = null;
  if (cursorChanged(owner, url)) { entry.complete = true; entry.status = 409; return boundaryFailure("stale"); }
  if (mode === "hold") { entry.held = true; const held = historyDeferred(); state.held.push(held.resolve); await held.promise; }
  entry.complete = true;
  const failure = boundaryFailure(mode);
  if (failure) { entry.status = failure.status; return failure; }
  const value = responseFor(state, url, owner);
  if (!value) return json({ error: "Unexpected fixture request" }, 405);
  entry.status = 200;
  if (mode === "body") { entry.held = true; return { ...json(heldBodyValue(value)), holdBody: entry }; }
  return json(boundaryValue(value, mode));
}
function heldBodyValue(value) {
  if (value.kind === "history") return { ...value, items: value.items.map(item => ({ ...item, id: `${item.id}-body-held` })) };
  return value;
}
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";
async function sendBodyHold(state, response, value) {
  const entry = value.holdBody, split = Math.min(64, value.body.length - 1);
  response.writeHead(value.status, { "content-type": value.contentType, "content-length": value.body.length, "cache-control": "no-store", "content-security-policy": CSP });
  response.flushHeaders(); entry.headersSent = response.headersSent; entry.prefixBytes = split; entry.finalBytesQueued = 0;
  response.write(value.body.subarray(0, split));
  const held = historyDeferred(); state.bodyHolds.push({ entry, release: () => { entry.releaseAttempted = true; held.resolve(); } }); await held.promise;
  if (response.destroyed) return;
  entry.finalBytesQueued = value.body.length - split; entry.serverEndQueued = true; response.end(value.body.subarray(split));
}
function fixtureHtml(prepared, theme) {
  return Buffer.from(`<!doctype html><html lang="en" data-theme="${theme}" data-theme-mode="${theme}" style="--font-sans:HistoryHanken;--font-display:HistoryBricolage"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Session history verification</title><link rel="icon" href="data:,">${prepared.css.map(row => `<link rel="stylesheet" href="${row.url}">`).join("")}<style>@font-face{font-family:HistoryHanken;src:url('/fixture-hanken.woff2')}@font-face{font-family:HistoryBricolage;src:url('/fixture-bricolage.woff2')}</style></head><body class="bg-bg font-sans text-text"><div id="root"></div><script>window.sessionsConfig={owner:'synthetic-a',surface:'history'};</script><script src="/history-fixture.js"></script></body></html>`);
}
function admittedRequest(state, request) {
  return request.method === "GET" && request.headers.host === new URL(state.origin).host && ["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "");
}
async function fixtureResponse(state, prepared, url, authorization, response) {
  if (url.pathname === "/v1/seasons") { record(state, { path: url.pathname, query: url.search, owner: null, atMs: Date.now(), complete: true, method: "GET", status: 200 }); return json({ items: [], current: null, source: "fallback", fetchedAt: null }); }
  if (url.pathname.startsWith("/v1/sessions")) return apiResponse(state, url, authorization, response);
  if (url.pathname === "/history-fixture.js") return { status: 200, contentType: "text/javascript", body: prepared.bundle };
  const asset = prepared.assets.get(url.pathname);
  if (asset) return { status: 200, ...asset };
  if (url.pathname === "/app" || url.pathname === "/app/sessions" || url.pathname.startsWith("/app/sessions/")) return { status: 200, contentType: "text/html", body: fixtureHtml(prepared, state.theme) };
  state.unexpected.push(url.pathname); return json({ error: "Unexpected request" }, 405);
}
async function handle(state, prepared, request, response) {
  try {
    if (!admittedRequest(state, request)) { state.unexpected.push(`${request.method} invalid loopback request`); request.resume(); response.writeHead(405); response.end(); return; }
    const url = new URL(request.url, state.origin), value = await fixtureResponse(state, prepared, url, request.headers.authorization, response);
    if (value.body.length > 8 * 1024 * 1024) throw new Error("History fixture response bound exceeded");
    if (value.holdBody) { await sendBodyHold(state, response, value); return; }
    if (!response.destroyed) { response.writeHead(value.status, { "content-type": value.contentType, "cache-control": "no-store", "content-security-policy": CSP }); response.end(value.body); }
  } catch (error) { state.errors.push(String(error)); if (!response.destroyed) { response.writeHead(500); response.end(); } }
}
/** New source/import/build/bundle admission is mandatory; the old core receipt is not proof.
 * @param {import("@playwright/test").Page} page
 * @param {"light"|"dark"} theme
 * @param {HistoryOptions} [options] */
export async function openSessionsHistoryBrowserFixture(page, theme, { long = false, raw = false, initialMode = null, initialHref = "/app/sessions?filters=1&preset=all&map_pool=all&game_size=all&exclude_too_short=false&tz=America%2FNew_York&contextDays=1&windowFrom=2026-10-01T00%3A00%3A00.000Z&windowTo=2026-10-28T00%3A00%3A00.000Z" } = {}) {
  if (!["light", "dark"].includes(theme)) throw new Error("Unknown theme");
  if (!/^\/app(?:\?|$|\/sessions(?:\?|\/|$))/.test(initialHref)) throw new Error("Use a local Sessions fixture route");
  const prepared = await prepareSessionsHistoryBrowserAssets();
  /** @type {HistoryState} */
  const state = { theme, long, raw, origin: "", next: initialMode, currentViews: { "synthetic-a": "base", "synthetic-b": "base" }, held: [], bodyHolds: [], expectedRealtimeSockets: initialHref.split("?")[0] === "/app" ? 1 : 0, requests: [], errors: [], console: [], failures: [], closing: false, unexpected: [], external: [], sockets: new Set() };
  const server = createServer((request, response) => { void handle(state, prepared, request, response); });
  server.on("connection", socket => { state.sockets.add(socket); socket.on("close", () => state.sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  state.origin = `http://127.0.0.1:${server.address().port}`; server.unref();
  page.on("pageerror", error => state.errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" || message.type() === "warning") state.console.push({ type: message.type(), text: message.text(), location: message.location() }); });
  page.on("requestfailed", request => state.failures.push({ url: request.url(), method: request.method(), error: request.failure()?.errorText, authSerial: Number(/-(\d+)$/.exec(request.headers().authorization ?? "")?.[1]), closing: state.closing }));

  const close = async () => {
    state.closing = true;
    /** @type {RealtimeEntry[]} */ let realtime = [];
    try { realtime = await page.evaluate(async () => { window.sessionHistoryUnmount?.(); await new Promise(resolve => setTimeout(resolve, 0)); return window.historyRealtime?.snapshot() ?? []; }); }
    catch (error) { state.errors.push(`Unmount/snapshot failed: ${String(error)}`); }
    state.held.splice(0).forEach(resolve => resolve()); state.bodyHolds.splice(0).forEach(hold => hold.release());
    const socketsClosed = Promise.all([...state.sockets].map(socket => new Promise(resolve => socket.once("close", resolve))));
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await socketsClosed;
    return { listening: server.listening, openSockets: state.sockets.size, heldResponses: state.held.length, heldBodies: state.bodyHolds.length, expectedRealtimeSockets: state.expectedRealtimeSockets, requests: state.requests, realtime, errors: state.errors, console: state.console, failures: state.failures, unexpected: state.unexpected, external: state.external, identity: prepared.receipt };
  };
  try {
    page.on("request", request => { if (new URL(request.url()).origin !== state.origin) state.external.push(request.url()); });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "no-preference" });
    await page.goto(state.origin + initialHref);
    await page.evaluate(() => document.fonts.ready);
    return { state, identity: prepared.receipt, next: /** @param {Exclude<HistoryBoundary,null>} mode */ mode => { if (!["hold", "body", "stale", "busy", "context_required", "narrow_window", "empty"].includes(mode)) throw new Error("Unknown boundary"); state.next = mode; },
      release: () => { state.held.splice(0).forEach(resolve => resolve()); }, releaseBodies: () => { state.bodyHolds.splice(0).forEach(hold => hold.release()); }, current: /** @param {"base"|"ingested"|"reset"} stage @param {string} [owner] */ (stage, owner = "synthetic-a") => { if (!["base", "ingested", "reset"].includes(stage) || !Object.hasOwn(state.currentViews, owner)) throw new Error("Unknown current fixture state"); state.currentViews[owner] = stage; }, close };
  } catch (error) { const closure = await close(); if (error && typeof error === "object") error.historySetupAndClosure = closure; throw error; }
}
