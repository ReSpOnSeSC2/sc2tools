import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

let server, origin = "", active;
const ledger = [];
const SOURCE = `import React,{useSyncExternalStore,useState}from'react';import{createRoot}from'react-dom/client';import{SWRConfig}from'swr';
import{SettingsShell}from'@/components/analyzer/settings/SettingsShell';import{SettingsChat}from'@/components/analyzer/settings/SettingsChat';
import{SettingsStreamingTokenOwner,useSettingsStreamingToken}from'@/components/analyzer/settings/SettingsStreamingTokenOwner';
import{usePublishDirty}from'@/components/analyzer/settings/SettingsContext';import{ToastProvider}from'@/components/ui/Toast';
const subscribe=(listener:()=>void)=>{addEventListener('fixture-change',listener);addEventListener('popstate',listener);addEventListener('hashchange',listener);return()=>{removeEventListener('fixture-change',listener);removeEventListener('popstate',listener);removeEventListener('hashchange',listener)}};
for(const method of ['pushState','replaceState'] as const){const native=history[method].bind(history);history[method]=(...args:Parameters<History[typeof method]>)=>{native(...args);dispatchEvent(new Event('fixture-change'))}}
let owner='owner-a';const pushes:string[]=[];
declare global{interface Window{chatOwner:()=>string;chatSetOwner:(value:string)=>void;chatNavigate:(href:string)=>void;chatPush:(href:string)=>void;chatPushes:()=>string[]}}
window.chatOwner=()=>owner;window.chatSetOwner=value=>{owner=value;dispatchEvent(new Event('fixture-change'))};window.chatNavigate=href=>history.pushState({},'',href);window.chatPush=href=>{pushes.push(href);window.chatNavigate(href)};window.chatPushes=()=>pushes.slice();
function OverlayProbe(){const{token}=useSettingsStreamingToken();const[draft,setDraft]=useState('');usePublishDirty('overlay',!!draft);return <section className="space-y-3"><h2 className="text-h3 text-text">Synthetic Overlay body</h2><p className="text-body text-text-muted">Selected source: {token.label}. This isolated body has no OBS, socket or agent transport.</p><label className="block text-body text-text">Overlay profile draft<input className="block w-full rounded border border-border bg-bg-surface p-2" value={draft} onChange={event=>setDraft(event.target.value)}/></label></section>}
function App(){useSyncExternalStore(subscribe,()=>location.pathname+location.search+location.hash+owner);if(location.pathname==='/devices')return <main><h1>Devices destination</h1></main>;return <ToastProvider><main className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6"><h1 className="font-display text-h2 text-text">Settings</h1><SettingsShell requestedSearch={location.search.slice(1)} ownerKey={owner} renderStreaming={(children,section)=><SettingsStreamingTokenOwner section={section}>{children}</SettingsStreamingTokenOwner>} renderTab={id=>id==='chat'?<SettingsChat origin={location.origin}/>:id==='overlay'?<OverlayProbe/>:<section className="rounded-xl border border-border bg-bg-surface p-5"><h2 className="text-h3 text-text">{id} synthetic panel</h2><p className="text-body text-text-muted">No account or token transport on this panel.</p></section>}/></main></ToastProvider>}
createRoot(document.getElementById('root')!).render(<SWRConfig value={{provider:()=>new Map(),revalidateOnFocus:false,revalidateOnReconnect:false}}><App/></SWRConfig>);`;
const adapters = {
  "next/link": `import React from'react';export default React.forwardRef(function Link({href,children,prefetch,scroll,replace,onClick,onNavigate,...props},ref){return <a ref={ref} href={href} {...props} onClick={event=>{onClick?.(event);if(event.defaultPrevented||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||event.button!==0||(event.currentTarget.target&&event.currentTarget.target!=='_self')||event.currentTarget.hasAttribute('download'))return;event.preventDefault();let prevented=false;onNavigate?.({preventDefault(){prevented=true}});if(!prevented)window.chatPush(href)}}>{children}</a>});`,
  "next/navigation": `import{useSyncExternalStore}from'react';const subscribe=listener=>{addEventListener('fixture-change',listener);return()=>removeEventListener('fixture-change',listener)};export const useSearchParams=()=>{useSyncExternalStore(subscribe,()=>location.search);return new URLSearchParams(location.search)};export const useRouter=()=>({push:href=>window.chatPush(href)});`,
  "@clerk/nextjs": `import{useSyncExternalStore}from'react';const subscribe=listener=>{addEventListener('fixture-change',listener);return()=>removeEventListener('fixture-change',listener)};export const useAuth=()=>{const userId=useSyncExternalStore(subscribe,()=>window.chatOwner());return{userId,isLoaded:true,isSignedIn:true,getToken:async()=>'fixture-'+userId}};`,
  "@/components/pwa/InstallAppButton": "export const InstallAppButton=()=>null;",
};

async function startServer() {
  if (server) return;
  const current = createServer(async (request, response) => {
    try {
      if (!active || request.headers.host !== new URL(origin).host || !["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")) {
        active?.externalAttempts.push("Invalid loopback Host or peer"); request.resume(); response.writeHead(403); response.end(); return;
      }
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const value = await active.respond(new URL(request.url ?? "/", origin), request.method ?? "", Buffer.concat(chunks).toString("utf8"), request.headers.authorization ?? "");
      ledger.push({ method: request.method, path: request.url });
      if (!response.destroyed) { response.writeHead(value.status ?? 200, { "content-type": value.contentType, "cache-control": "no-store" }); response.end(value.body); }
    } catch (error) { active?.errors.push(String(error)); if (!response.destroyed) { response.writeHead(500); response.end(); } }
  });
  await new Promise((resolve, reject) => {
    current.once("error", reject);
    current.listen(0, "127.0.0.1", () => { current.removeListener("error", reject); resolve(); });
  }).catch(error => { current.close(); throw error; });
  server = current; origin = `http://127.0.0.1:${current.address().port}`; current.unref();
}
export async function closeSettingsChatFixtureServer() {
  await active?.releaseAll(); active = null;
  const current = server; server = null;
  if (current) await new Promise(resolve => { current.close(resolve); current.closeAllConnections(); });
  const receipt = { closed: true, listening: current?.listening ?? false, requests: ledger.splice(0) };
  origin = ""; return receipt;
}

async function assets() {
  const cwd = process.cwd();
  const result = await build({ stdin: { contents: SOURCE, loader: "tsx", resolveDir: cwd }, bundle: true, write: false, minify: true, format: "iife", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
    define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_BASE": JSON.stringify(origin) },
    plugins: [{ name: "settings-chat-synthetic-auth", setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(adapters, args.path) ? { path: args.path, namespace: "chat-adapter" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "chat-adapter" }, args => ({ contents: adapters[args.path], loader: "tsx", resolveDir: cwd }));
    } }],
  });
  const cssRoot = path.join(cwd, ".next/static/css");
  const cssNames = (await readdir(cssRoot, { recursive: true })).filter(file => file.endsWith(".css")).sort();
  if (!cssNames.length) throw new Error("Build production CSS before Chat proof");
  const buildId = (await readFile(path.join(cwd, ".next/BUILD_ID"), "utf8")).trim();
  const definitions = [["SettingsHanken", "hanken-grotesk-latin.woff2", "100 900"], ["SettingsBricolage", "bricolage-grotesque-latin.woff2", "600 800"], ["SettingsFraunces", "fraunces-latin-normal.woff2", "400 700"]];
  const fonts = new Map(await Promise.all(definitions.map(async ([, name]) => [name, await readFile(path.join(cwd, "app/fonts", name))])));
  const css = (await Promise.all(cssNames.map(name => readFile(path.join(cssRoot, name), "utf8")))).join("\n")
    + definitions.map(([family, name, weight]) => `@font-face{font-family:${family};src:url('/fonts/${name}') format('woff2');font-weight:${weight};font-style:normal;font-display:swap;}`).join("\n")
    + ":root{--font-sans:SettingsHanken;--font-display:SettingsBricolage;--font-serif:SettingsFraunces;}";
  return { script: result.outputFiles[0].text, css, cssNames, fonts, buildId };
}

/** Actual Shell, shared authority, Chat and nested forms. Only auth/framework
 * and unrelated Overlay body are synthetic. Exact local DTOs/PUTs below can
 * never reach a real account, provider, clipboard, OBS source or socket. */
export async function openSettingsChatFixture(page, theme, mode = "stable") {
  await startServer();
  let built;
  try { built = await assets(); } catch (error) { await closeSettingsChatFixtureServer(); throw error; }
  const { script, css, cssNames, fonts, buildId } = built;
  const errors = [], unexpectedRequests = [], rejectedWrites = [], externalAttempts = [], reads = [], writes = [], deviceLoads = [], abortedResponses = [];
  const releases = [];
  const flights = new Set();
  const row = (owner, id) => ({ token: `${owner}-${id}`, label: `${owner} ${id}`, createdAt: "2026-10-26" });
  const configs = new Map(), bots = new Map();
  const bot = { enabled: false, username: "", channel: "", replyCommands: true, announceOracle: true, announceLevelUps: true, hasToken: false, status: { state: "off", channel: null, lastError: null, lastConnectedAt: null } };
  const json = value => ({ contentType: "application/json", body: JSON.stringify(value) });
  const denied = (status, message) => ({ status, contentType: "text/plain", body: message });
  const respond = async (url, method, body = "", authorization = "") => {
    if (url.origin !== origin) { externalAttempts.push(`${method} ${url.origin}${url.pathname}`); if (method !== "GET") rejectedWrites.push(`${method} ${url.pathname}`); return denied(403, "Nonlocal request denied"); }
    if (method === "GET" && !url.search && !url.hash) {
      if (url.pathname === "/fixture.js") return { contentType: "text/javascript", body: script };
      if (url.pathname === "/fixture.css") return { contentType: "text/css", body: css };
      if (url.pathname.startsWith("/fonts/") && fonts.has(url.pathname.slice(7))) return { contentType: "font/woff2", body: fonts.get(url.pathname.slice(7)) };
      if (url.pathname === "/devices") { deviceLoads.push("GET"); return { contentType: "text/html", body: '<!doctype html><html lang="en"><title>Synthetic Devices</title><h1>Devices destination</h1><p>No account transport.</p></html>' }; }
    }
    if (method === "GET" && url.pathname === "/settings" && url.search === "?tab=account" && !url.hash) return { contentType: "text/html", body: `<!doctype html><html lang="en" data-theme="${theme}" data-theme-mode="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local Chat Settings proof</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>` };
    const owner = authorization === "Bearer fixture-owner-a" ? "owner-a" : authorization === "Bearer fixture-owner-b" ? "owner-b" : null;
    if (owner && !url.search && !url.hash) {
      const allowedReads = new Set(["/v1/overlay-tokens", "/v1/me/preferences/multichat", "/v1/me/chatbot", "/v1/me/integrations", "/v1/me", "/v1/me/preferences/chatCommands", "/v1/me/twitch-automation"]);
      if (method === "GET" && allowedReads.has(url.pathname)) {
        reads.push({ owner, path: url.pathname });
        if (url.pathname === "/v1/overlay-tokens") return json({ items: mode === "unknown" ? [] : [row(owner, "one"), row(owner, "two")] });
        if (url.pathname === "/v1/me/preferences/multichat") return json(configs.get(owner) ?? {});
        if (url.pathname === "/v1/me/chatbot") return json(bots.get(owner) ?? bot);
        if (url.pathname === "/v1/me/integrations") return json({ platforms: ["twitch", "kick", "youtube"].map(platform => ({ platform, configured: false, connected: false, ready: false, platformUserName: "", scopes: [], connectedAt: null, lastSyncedAt: null, lastError: null })) });
        if (url.pathname === "/v1/me") return json({ isAdmin: false });
        if (url.pathname === "/v1/me/twitch-automation") return json({ serverEnabled: false, configured: false, connected: false, preferences: {} });
        return json({ v: 1, builtins: {}, custom: [] });
      }
      if (method === "PUT" && ["/v1/me/preferences/multichat", "/v1/me/chatbot"].includes(url.pathname)) {
        const value = JSON.parse(body);
        if (!value || typeof value !== "object" || body.length > 100_000) throw new Error("Invalid synthetic draft");
        writes.push({ owner, method, path: url.pathname });
        if (url.pathname.endsWith("multichat")) { configs.set(owner, value); return json(value); }
        const saved = { ...bot, ...value, hasToken: !!value.token }; delete saved.token; bots.set(owner, saved); return json(saved);
      }
      if (mode === "unknown" && method === "POST" && url.pathname === "/v1/overlay-tokens" && body === JSON.stringify({ label: "Default" })) {
        writes.push({ owner, method, path: url.pathname });
        await new Promise(resolve => releases.push(resolve)); return json({ token: `${owner}-late-created` });
      }
    }
    if (method !== "GET") rejectedWrites.push(`${method} ${url.pathname}`);
    unexpectedRequests.push(`${method} ${url.pathname}${url.search}`); return denied(405, "Unknown fixture transport denied");
  };
  active = { respond, errors, externalAttempts, releaseAll: async () => { releases.splice(0).forEach(resolve => resolve()); await Promise.all([...flights]); } };
  const watch = candidate => candidate.on("pageerror", error => errors.push(error.message)); watch(page); page.context().on("page", watch);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript(value => { localStorage.setItem("sc2tools.theme", value); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("No host clipboard in fixture"); } } }); }, theme);
  await page.context().route("**/*", async route => {
    const request = route.request();
    const flight = (async () => {
      const value = await respond(new URL(request.url()), request.method(), request.postData() ?? "", (await request.allHeaders()).authorization ?? "");
      if (value.status === 403 || value.status === 405) return route.abort();
      await route.fulfill({ ...value, headers: { "cache-control": "no-store" } }).catch(error => {
        if (request.failure()?.errorText.includes("ERR_ABORTED")) abortedResponses.push({ method: request.method(), path: new URL(request.url()).pathname });
        else if (!page.isClosed() && !String(error).includes("Target closed")) errors.push(String(error));
      });
    })();
    flights.add(flight);
    try { await flight; } finally { flights.delete(flight); }
  });
  await page.goto(`${origin}/settings?tab=account`); await page.getByRole("heading", { name: "account synthetic panel" }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { errors, unexpectedRequests, rejectedWrites, externalAttempts, reads, writes, deviceLoads, abortedResponses, cssNames, buildId, releaseAll: active.releaseAll };
}
