import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const ORIGIN = "https://settings-registry-fixture.local";
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
 return <section id={id==='overlay'?'platform-connections':'fixture-section'} className="space-y-4 rounded-xl border border-border bg-bg-surface p-5">
  <h2 className="font-display text-h3 text-text">{data.title} panel</h2>
  <p className="text-body text-text-muted">Synthetic panel data. This fixture cannot change an account.</p>
  <Field label="Local draft"><Input value={draft} onChange={event=>setDraft(event.target.value)}/></Field>
  <Button onClick={()=>setDraft('')}>Reset local draft</Button>
 </section>;
}
const subscribe=(listener:()=>void)=>{addEventListener('fixture-location',listener);addEventListener('popstate',listener);return()=>{removeEventListener('fixture-location',listener);removeEventListener('popstate',listener)}};
function navigate(href:string){history.pushState({},'',href);dispatchEvent(new Event('fixture-location'))}
declare global{interface Window{settingsFixtureNavigate:(href:string)=>void;settingsFixtureRouterPush:(href:string)=>void;settingsFixtureRouterPushes:()=>string[]}}
window.settingsFixtureNavigate=navigate;
const routerPushes:string[]=[];window.settingsFixtureRouterPushes=()=>routerPushes.slice();window.settingsFixtureRouterPush=href=>{routerPushes.push(href);navigate(href)};
function App(){const current=useSyncExternalStore(subscribe,()=>location.pathname+location.search);if(current==='/devices')return <main className="p-6"><h1 className="font-display text-h2 text-text">Devices destination</h1><p className="text-body text-text-muted">Synthetic client navigation. No account transport is available.</p></main>;return <main className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6"><h1 className="font-display text-h2 text-text">Settings</h1><SettingsShell initialTab={settingsTabFromParam(new URLSearchParams(location.search).get('tab'))??undefined} renderTab={id=><SyntheticPanel key={id} id={id}/>}/></main>}
createRoot(document.getElementById('root')!).render(<App/>);`;

const adapters = {
  "next/link": `import React from'react';import{useRouter}from'next/navigation';export default React.forwardRef(function Link({href,children,prefetch,scroll,replace,onClick,onNavigate,...props},ref){const router=useRouter();return <a ref={ref} href={href} {...props} onClick={event=>{onClick?.(event);if(event.defaultPrevented||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||event.button!==0||(event.currentTarget.target&&event.currentTarget.target!=='_self')||event.currentTarget.hasAttribute('download'))return;event.preventDefault();let prevented=false;onNavigate?.({preventDefault(){prevented=true}});if(!prevented)router.push(href)}}>{children}</a>});`,
  "next/navigation": `const router={push:href=>window.settingsFixtureRouterPush(href)};export const useRouter=()=>router;`,
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
    const css = (await Promise.all(cssNames.map(file => readFile(path.join(cssRoot, file), "utf8")))).join("\n");
    const definitions = [["SettingsHanken", "hanken-grotesk-latin.woff2", "100 900"],
      ["SettingsBricolage", "bricolage-grotesque-latin.woff2", "600 800"], ["SettingsFraunces", "fraunces-latin-normal.woff2", "400 700"]];
    const fonts = new Map(await Promise.all(definitions.map(async ([, file]) => [file, await readFile(path.join(cwd, "app/fonts", file))])));
    const fontCss = definitions.map(([family, file, weight]) => `@font-face{font-family:${family};src:url('/fonts/${file}') format('woff2');font-weight:${weight};font-style:normal;font-display:swap;}`).join("\n")
      + ":root{--font-sans:SettingsHanken;--font-display:SettingsBricolage;--font-serif:SettingsFraunces;}";
    return { script: result.outputFiles[0].text, css: css + fontCss, cssNames, fonts };
  })();
}

/** Actual Shell, registry, dirty guard and Modal; typed synthetic panels/read
 * transport replace account data. All requests are intercepted; writes fail.
 * @param {import('@playwright/test').Page} page
 * @param {'light'|'dark'} theme
 */
export async function openSettingsRegistryFixture(page, theme) {
  const { script, css, cssNames, fonts } = await fixtureAssets();
  const errors = [], unexpectedRequests = [], panelReads = [], deviceLoads = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript(mode => {
    localStorage.setItem("sc2tools.theme", mode);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("Fixture clipboard unavailable"); } } });
  }, theme);
  // Context routing also intercepts native modified-click/new-tab documents.
  await page.context().route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== ORIGIN || request.method() !== "GET") {
      unexpectedRequests.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort();
    }
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: script });
    if (url.pathname === "/fixture.css") return route.fulfill({ contentType: "text/css", body: css });
    if (url.pathname.startsWith("/fonts/") && fonts.has(url.pathname.slice(7))) return route.fulfill({ contentType: "font/woff2", body: fonts.get(url.pathname.slice(7)) });
    if (url.pathname.startsWith("/synthetic/panels/")) {
      const id = url.pathname.slice("/synthetic/panels/".length);
      const titles = { account: "Account", profile: "Profile", backups: "Backups & data", checkin: "Build check-in", randomizer: "Randomizer", import: "Import", overlay: "Overlay", voice: "Voice", preferences: "Preferences", help: "Help" };
      if (Object.hasOwn(titles, id)) {
        panelReads.push(id);
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ id, title: titles[id] }) });
      }
    }
    if (url.pathname === "/settings") return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en" data-theme="${theme}" data-theme-mode="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local Settings registry proof</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>` });
    if (url.pathname === "/devices") {
      deviceLoads.push(request.method());
      return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Synthetic Devices</title><link rel="icon" href="data:,"></head><body><h1>Devices destination</h1><p>Native link boundary; no account transport.</p></body></html>' });
    }
    unexpectedRequests.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 404, body: "Unknown fixture resource" });
  });
  await page.goto(`${ORIGIN}/settings?tab=misc&ref=legacy`);
  await page.getByRole("heading", { name: "Preferences panel", exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { errors, unexpectedRequests, panelReads, deviceLoads, cssNames };
}
