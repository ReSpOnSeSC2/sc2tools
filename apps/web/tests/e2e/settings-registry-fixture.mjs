import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

let origin = "", server, serverReady, activeTransport;
const serverLedger = [];
function fixtureServer() {
  return serverReady ??= new Promise((resolve, reject) => {
    const current = createServer(async (request, response) => {
      const state = activeTransport;
      if (!state) { response.writeHead(503); response.end(); return; }
      const method = request.method ?? "";
      try {
        const url = new URL(request.url ?? "/", origin);
        const entry = { method, path: url.pathname, search: url.search };
        state.serverRequests.push(entry); serverLedger.push(entry);
        if (request.headers.host !== new URL(origin).host
          || !["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")) {
          state.externalAttempts.push(`${method} invalid loopback Host or peer`);
          if (method !== "GET") state.rejectedWrites.push(`${method} ${url.pathname}${url.search}`);
          request.resume(); response.writeHead(403); response.end("Nonlocal fixture transport rejected"); return;
        }
        const reply = await state.respond(url, method);
        if (method !== "GET") request.resume();
        if (!response.destroyed) {
          response.writeHead(reply.status ?? 200, { "Content-Type": reply.contentType, "Cache-Control": "no-store" });
          response.end(reply.body);
        }
      } catch (error) {
        state.errors.push(String(error));
        if (!response.destroyed) { response.writeHead(500); response.end(); }
      }
    });
    server = current;
    const startupError = error => {
      if (server === current) { server = null; serverReady = null; origin = ""; }
      reject(error);
    };
    current.once("error", startupError);
    current.listen(0, "127.0.0.1", () => {
      current.removeListener("error", startupError);
      current.on("error", error => activeTransport?.errors.push(String(error)));
      origin = `http://127.0.0.1:${current.address().port}`;
      current.unref(); resolve(current);
    });
  });
}

/** Native no-opener Control-click may reach the network before Chrome
 * attaches context routing. Serve the identical strict GET classifier from
 * an ephemeral loopback listener, and close it in the spec's afterAll. */
export async function closeSettingsRegistryFixtureServer() {
  const current = server;
  if (!current) return { closed: true, listening: false, port: null, requests: serverLedger.splice(0) };
  const port = current.address()?.port ?? null;
  activeTransport = null;
  await new Promise(resolve => { current.close(resolve); current.closeAllConnections(); });
  if (current.listening) throw new Error("Settings fixture listener remained open");
  server = null; serverReady = null; assets = null; origin = "";
  return { closed: true, listening: current.listening, port, requests: serverLedger.splice(0) };
}
const SOURCE = `import React,{useEffect,useState,useSyncExternalStore}from'react';
import{createRoot}from'react-dom/client';
import{SettingsShell}from'@/components/analyzer/settings/SettingsShell';
import{usePublishDirty}from'@/components/analyzer/settings/SettingsContext';
import{settingsTabFromParam,type SettingsTabId}from'@/lib/settingsRegistry';
import{Button}from'@/components/ui/Button';import{Field}from'@/components/ui/Field';import{Input}from'@/components/ui/Input';
type PanelData={id:SettingsTabId;title:string};
function readPanel(value:unknown,id:SettingsTabId):PanelData{
 if(!value||typeof value!=='object'||!('id'in value)||!('title'in value)||value.id!==id||typeof value.title!=='string')throw Error('Invalid synthetic panel');
 return{id,title:value.title};
}
function SyntheticPanel({id}:{id:SettingsTabId}){
 const[data,setData]=useState<PanelData|null>(null);const[failed,setFailed]=useState(false);
 const[draft,setDraft]=useState('');usePublishDirty(id,draft!=='');
 useEffect(()=>{const controller=new AbortController();fetch('/synthetic/panels/'+id,{signal:controller.signal})
  .then(response=>{if(!response.ok)throw Error('Synthetic read failed');return response.json()})
  .then(value=>{if(!controller.signal.aborted)setData(readPanel(value,id))})
  .catch(()=>{if(!controller.signal.aborted)setFailed(true)});return()=>controller.abort()},[id]);
 if(failed)return <p role="alert">Synthetic panel unavailable</p>;
 if(!data)return <p role="status">Loading synthetic panel</p>;
 return <section id={id==='chat'?'platform-connections':'fixture-section'} className="space-y-4 rounded-xl border border-border bg-bg-surface p-5">
  <h2 className="font-display text-h3 text-text">{data.title} panel</h2>
  <p className="text-body text-text-muted">Synthetic panel data. This fixture cannot change an account.</p>
  <Field label="Local draft"><Input value={draft} onChange={event=>setDraft(event.target.value)}/></Field>
  <Button onClick={()=>setDraft('')}>Reset local draft</Button>
 </section>;
}
const subscribe=(listener:()=>void)=>{addEventListener('fixture-location',listener);addEventListener('popstate',listener);return()=>{removeEventListener('fixture-location',listener);removeEventListener('popstate',listener)}};
for(const method of ['pushState','replaceState'] as const){const native=history[method].bind(history);history[method]=(...args:Parameters<History[typeof method]>)=>{native(...args);dispatchEvent(new Event('fixture-location'))}}
function navigate(href:string){history.pushState({},'',href)}
declare global{interface Window{settingsFixtureNavigate:(href:string)=>void;settingsFixtureRouterPush:(href:string)=>void;settingsFixtureRouterPushes:()=>string[]}}
window.settingsFixtureNavigate=navigate;
const routerPushes:string[]=[];window.settingsFixtureRouterPushes=()=>routerPushes.slice();window.settingsFixtureRouterPush=href=>{routerPushes.push(href);navigate(href)};
function App(){const current=useSyncExternalStore(subscribe,()=>location.pathname+location.search+location.hash);if(current==='/devices')return <main className="p-6"><h1 className="font-display text-h2 text-text">Devices destination</h1><p className="text-body text-text-muted">Synthetic client navigation. No account transport is available.</p></main>;return <main className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6"><h1 className="font-display text-h2 text-text">Settings</h1><SettingsShell initialTab={settingsTabFromParam(new URLSearchParams(location.search).get('tab'))??undefined} requestedSearch={location.search.slice(1)} renderTab={id=><SyntheticPanel key={id} id={id}/>}/></main>}
createRoot(document.getElementById('root')!).render(<App/>);`;

const adapters = {
  "next/link": `import React from'react';import{useRouter}from'next/navigation';export default React.forwardRef(function Link({href,children,prefetch,scroll,replace,onClick,onNavigate,...props},ref){const router=useRouter();return <a ref={ref} href={href} {...props} onClick={event=>{onClick?.(event);if(event.defaultPrevented||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||event.button!==0||(event.currentTarget.target&&event.currentTarget.target!=='_self')||event.currentTarget.hasAttribute('download'))return;event.preventDefault();let prevented=false;onNavigate?.({preventDefault(){prevented=true}});if(!prevented)router.push(href)}}>{children}</a>});`,
  "next/navigation": `import{useSyncExternalStore}from'react';const subscribe=listener=>{addEventListener('fixture-location',listener);addEventListener('popstate',listener);return()=>{removeEventListener('fixture-location',listener);removeEventListener('popstate',listener)}};const router={push:href=>window.settingsFixtureRouterPush(href)};export const useRouter=()=>router;export const useSearchParams=()=>new URLSearchParams(useSyncExternalStore(subscribe,()=>location.search));`,
  // Installation is unrelated to Settings grouping; no browser install prompt.
  "@/components/pwa/InstallAppButton": "export const InstallAppButton=()=>null;",
};
let assets;
function fixtureAssets() {
  return assets ??= (async () => {
    const cwd = process.cwd();
    const result = await build({
      stdin: { contents: SOURCE, loader: "tsx", resolveDir: cwd }, bundle: true, write: false,
      minify: true, format: "iife", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [{ name: "settings-synthetic-boundaries", setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => adapters[args.path] ? { path: args.path, namespace: "settings-adapter" } : undefined);
        builder.onLoad({ filter: /.*/, namespace: "settings-adapter" }, args => ({ contents: adapters[args.path], loader: "tsx", resolveDir: cwd }));
      } }],
    });
    const cssRoot = path.join(cwd, ".next/static/css");
    const cssNames = (await readdir(cssRoot, { recursive: true })).filter(file => file.endsWith(".css")).sort();
    if (!cssNames.length) throw new Error("Build production CSS before running the Settings fixture");
    const buildId = (await readFile(path.join(cwd, ".next/BUILD_ID"), "utf8")).trim();
    const css = (await Promise.all(cssNames.map(file => readFile(path.join(cssRoot, file), "utf8")))).join("\n");
    const definitions = [["SettingsHanken", "hanken-grotesk-latin.woff2", "100 900"],
      ["SettingsBricolage", "bricolage-grotesque-latin.woff2", "600 800"], ["SettingsFraunces", "fraunces-latin-normal.woff2", "400 700"]];
    const fonts = new Map(await Promise.all(definitions.map(async ([, file]) => [file, await readFile(path.join(cwd, "app/fonts", file))])));
    const fontCss = definitions.map(([family, file, weight]) => `@font-face{font-family:${family};src:url('/fonts/${file}') format('woff2');font-weight:${weight};font-style:normal;font-display:swap;}`).join("\n")
      + ":root{--font-sans:SettingsHanken;--font-display:SettingsBricolage;--font-serif:SettingsFraunces;}";
    return { script: result.outputFiles[0].text, css: css + fontCss, cssNames, fonts, buildId };
  })();
}

/** Actual Shell, registry, dirty guard and Modal; typed synthetic panels/read
 * transport replace account data. Context routing and a loopback-only server
 * share one exact GET allowlist; writes, unknown and nonlocal requests fail.
 * @param {import('@playwright/test').Page} page
 * @param {'light'|'dark'} theme
 */
export async function openSettingsRegistryFixture(page, theme) {
  const { script, css, cssNames, fonts, buildId } = await fixtureAssets();
  // Assets load before the listener starts, so failed bundling/CSS/font reads
  // cannot leave a startup listener behind.
  await fixtureServer();
  const errors = [], unexpectedRequests = [], rejectedWrites = [], externalAttempts = [], panelReads = [], deviceLoads = [], serverRequests = [];
  const watchErrors = candidate => candidate.on("pageerror", error => errors.push(error.message));
  watchErrors(page); page.context().on("page", watchErrors);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript(mode => {
    localStorage.setItem("sc2tools.theme", mode);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("Fixture clipboard unavailable"); } } });
  }, theme);
  const denied = (status, message) => ({ status, contentType: "text/plain", body: message });
  const respond = async (url, method) => {
    if (method !== "GET") rejectedWrites.push(`${method} ${url.origin}${url.pathname}${url.search}`);
    if (url.origin !== origin) {
      externalAttempts.push(`${method} ${url.origin}${url.pathname}${url.search}`);
      return denied(403, "Nonlocal Settings fixture request rejected");
    }
    if (method !== "GET") return denied(405, "Settings fixture writes rejected");
    if (url.pathname === "/fixture.js" && !url.search && !url.hash) return { contentType: "text/javascript", body: script };
    if (url.pathname === "/fixture.css" && !url.search && !url.hash) return { contentType: "text/css", body: css };
    if (url.pathname.startsWith("/fonts/") && !url.search && !url.hash && fonts.has(url.pathname.slice(7))) return { contentType: "font/woff2", body: fonts.get(url.pathname.slice(7)) };
    if (url.pathname.startsWith("/synthetic/panels/") && !url.search && !url.hash) {
      const id = url.pathname.slice("/synthetic/panels/".length);
      const titles = { account: "Account", profile: "Profile", backups: "Backups & data", checkin: "Build check-in", randomizer: "Randomizer", import: "Import", overlay: "Overlay", chat: "Chat & alerts", voice: "Voice", preferences: "Preferences", help: "Help" };
      if (Object.hasOwn(titles, id)) {
        panelReads.push(id);
        return { contentType: "application/json", body: JSON.stringify({ id, title: titles[id] }) };
      }
    }
    if (url.pathname === "/settings" && url.search === "?tab=misc&ref=legacy" && !url.hash) return { contentType: "text/html", body: `<!doctype html><html lang="en" data-theme="${theme}" data-theme-mode="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local Settings registry proof</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>` };
    if (url.pathname === "/devices" && !url.search && !url.hash) {
      deviceLoads.push(method);
      return { contentType: "text/html", body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Synthetic Devices</title><link rel="icon" href="data:,"></head><body><h1>Devices destination</h1><p>Native link boundary; no account transport.</p></body></html>' };
    }
    unexpectedRequests.push(`${method} ${url.pathname}${url.search}${url.hash}`);
    return denied(404, "Unknown Settings fixture GET");
  };
  activeTransport = { respond, errors, serverRequests, rejectedWrites, externalAttempts };
  await page.context().route("**/*", async route => {
    const request = route.request(), reply = await respond(new URL(request.url()), request.method());
    if (reply.status === 403 || reply.status === 405) return route.abort();
    return route.fulfill({ ...reply, headers: { "cache-control": "no-store" } });
  });
  await page.goto(`${origin}/settings?tab=misc&ref=legacy`);
  await page.getByRole("heading", { name: "Preferences panel", exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { errors, unexpectedRequests, rejectedWrites, externalAttempts, panelReads, deviceLoads, serverRequests, cssNames, buildId };
}
