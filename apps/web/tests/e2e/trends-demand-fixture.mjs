import { build } from "esbuild";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import { TRENDS_FIXTURE_FILTERS, trendsFixturePayload, trendsGetSummary } from "./trends-demand-fixture-data.mjs";

let server, origin = "", active;
const frozenSources = new Map([
  ["components/analyzer/TrendsTab.tsx", "73186719b8f3d6364306ed1ed2d6f60ceb5ec16e5af37c1fbf9e6ea17f1a8940"],
  ["components/analyzer/explorer/DeferredTrendsExplorer.tsx", "6b98260fa3104d120b02830cb7270d5e3b446130afebd11f6bfed3b0ec28fc41"],
]);
const SOURCE = `import React,{useMemo,useState,useSyncExternalStore}from'react';import{createRoot}from'react-dom/client';import{SWRConfig}from'swr';
import{FiltersContext}from'@/lib/filterContext';import{TrendsDataProvider}from'@/lib/trendsDataContext';import{TrendsTab}from'@/components/analyzer/TrendsTab';
let owner='owner-a',listeners=new Set(),heldTokens=false,tokenReleases=[];const cache=new Map();
const subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};window.trendsOwner=()=>owner;window.trendsSubscribe=subscribe;
window.trendsSetOwner=value=>{owner=value;[...listeners].forEach(fn=>fn())};window.trendsHoldTokens=()=>{heldTokens=true};window.trendsReleaseTokens=()=>{heldTokens=false;tokenReleases.splice(0).forEach(fn=>fn())};
window.trendsToken=async captured=>{if(heldTokens)await new Promise(resolve=>tokenReleases.push(resolve));return'fixture-'+captured};window.trendsNavigation=[];
function App(){const[filters,setFilters]=useState(${JSON.stringify(TRENDS_FIXTURE_FILTERS)}),[revision,setRevision]=useState(1),[cohort,setCohort]=useState({excluded_players:['synthetic-excluded']});
window.trendsSetFilters=patch=>setFilters(current=>({...current,...patch}));window.trendsBumpRevision=()=>setRevision(value=>value+1);window.trendsSetCohort=value=>setCohort(value);
const scope=window.trendsMode==='global'?'global':'personal';return <SWRConfig value={{provider:()=>cache,revalidateOnFocus:false,revalidateOnReconnect:false,shouldRetryOnError:false,dedupingInterval:60000}}><FiltersContext.Provider value={{filters,setFilters,dbRev:revision,bumpRev:()=>setRevision(value=>value+1),seasons:[]}}><TrendsDataProvider mode={scope} cohort={cohort}>
<main className="mx-auto min-w-0 max-w-6xl space-y-4 p-4 sm:p-6"><header className="space-y-2"><h1 className="text-h2 font-semibold text-text">Trends</h1><p className="text-caption text-text-muted">Synthetic local replay data · actual charts and request hooks</p><label className="block text-caption text-text">Unrelated fixture draft<input className="ml-2 max-w-40 rounded border border-border bg-bg-surface p-2" defaultValue="keep focus"/></label><output aria-label="Fixture filter state" className="block break-all text-micro text-text-muted">{JSON.stringify(filters)}</output></header><TrendsTab/></main>
</TrendsDataProvider></FiltersContext.Provider></SWRConfig>};createRoot(document.getElementById('root')).render(<App/>);`;

const adapters = {
  "@clerk/nextjs": `import{useMemo,useSyncExternalStore}from'react';export function useAuth(){const userId=useSyncExternalStore(window.trendsSubscribe,window.trendsOwner);const getToken=useMemo(()=>()=>window.trendsToken(userId),[userId]);return{userId,isLoaded:true,isSignedIn:true,getToken}};`,
  "next/link": `import React from'react';export default React.forwardRef(function Link({prefetch,replace,scroll,onNavigate,...props},ref){return <a {...props} ref={ref}/>});`,
  "next/image": `import React from'react';export default function Image({fill,priority,unoptimized,loader,quality,...props}){return <img {...props}/>};`,
  "next/navigation": `export const usePathname=()=>location.pathname;export const useSearchParams=()=>new URLSearchParams(location.search);export const useRouter=()=>({push:href=>window.trendsNavigation.push({method:'push',href}),replace:href=>window.trendsNavigation.push({method:'replace',href})});`,
  "@sentry/nextjs": `export const captureException=()=>{};export const captureMessage=()=>{};export const addBreadcrumb=()=>{};`,
  "@/components/help/LazyHelpLink": `import React from'react';export const LazyHelpLink=({slug,children,...props})=><a href={'/help/'+slug} {...props}>{children}</a>;`,
  "@/components/feedback/LazyReportIssueModal": `export const LazyReportIssueModal=()=>null;`,
};

/** Only two exact raw, hashed pre-edit files can override the current bundle.
 * Normal CI calls never read the local snapshot or build a legacy component. */
async function legacyOverrides(cwd, legacy) {
  const overrides = new Map();
  if (!legacy) return overrides;
  const root = path.resolve(cwd, "../../.cache/trends-demand-prep-ed484b94/before/apps/web");
  for (const [relative, expected] of frozenSources) {
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) throw new Error("Legacy source escaped its frozen root");
    const bytes = await readFile(file);
    if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error(`Frozen legacy source changed: ${relative}`);
    overrides.set(path.resolve(cwd, relative), bytes.toString("utf8"));
  }
  return overrides;
}

async function assets(legacy) {
  const cwd = process.cwd(), overrides = await legacyOverrides(cwd, legacy);
  const result = await build({ stdin: { contents: SOURCE, loader: "tsx", resolveDir: cwd }, bundle: true, write: false, minify: true, format: "iife", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
    define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_BASE": JSON.stringify(origin), "process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID": '""' },
    plugins: [{ name: "trends-explicit-boundaries", setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(adapters, args.path) ? { path: args.path, namespace: "trends-adapter" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "trends-adapter" }, args => ({ contents: adapters[args.path], loader: "tsx", resolveDir: cwd }));
      builder.onLoad({ filter: /(?:TrendsTab|DeferredTrendsExplorer)\.tsx$/ }, args => overrides.has(path.resolve(args.path)) ? { contents: overrides.get(path.resolve(args.path)), loader: "tsx", resolveDir: path.dirname(args.path) } : undefined);
    } }],
  });
  const cssRoot = path.join(cwd, ".next/static/css"), cssNames = (await readdir(cssRoot, { recursive: true })).filter(file => file.endsWith(".css")).sort();
  if (!cssNames.length) throw new Error("Build production CSS before Trends proof");
  const buildId = (await readFile(path.join(cwd, ".next/BUILD_ID"), "utf8")).trim();
  const definitions = [["TrendsHanken", "hanken-grotesk-latin.woff2", "100 900"], ["TrendsBricolage", "bricolage-grotesque-latin.woff2", "600 800"], ["TrendsFraunces", "fraunces-latin-normal.woff2", "400 700"]];
  const fonts = new Map(await Promise.all(definitions.map(async ([, name]) => [name, await readFile(path.join(cwd, "app/fonts", name))])));
  const css = (await Promise.all(cssNames.map(name => readFile(path.join(cssRoot, name), "utf8")))).join("\n")
    + definitions.map(([family, name, weight]) => `@font-face{font-family:${family};src:url('/fonts/${name}') format('woff2');font-weight:${weight};font-style:normal;font-display:swap;}`).join("\n")
    + ":root{--font-sans:TrendsHanken;--font-display:TrendsBricolage;--font-serif:TrendsFraunces;}";
  return { script: result.outputFiles[0].text, css, cssNames, fonts, buildId, legacy, sourceHashes: Object.fromEntries(await Promise.all([...frozenSources.keys()].map(async relative => [relative, createHash("sha256").update(overrides.get(path.resolve(cwd, relative)) ?? await readFile(path.join(cwd, relative))).digest("hex")]))), mapArt: await readFile(path.join(cwd, "../replay-engine/data/map-images/alcyone_le.webp")) };
}

async function startServer() {
  if (server) return;
  const current = createServer(async (request, response) => {
    try {
      if (!active || request.headers.host !== new URL(origin).host || !["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")) {
        active?.unexpectedRequests.push("Invalid loopback Host or peer"); request.resume(); response.writeHead(403); response.end(); return;
      }
      request.resume();
      const value = await active.respond(new URL(request.url ?? "/", origin), request.method ?? "", request.headers.authorization ?? "");
      response.writeHead(value.status ?? 200, { "content-type": value.contentType, "cache-control": "no-store" });
      response.flushHeaders();
      const body = await value.body;
      if (!response.destroyed) response.end(body);
      if (value.row) { value.row.settled = !response.destroyed; value.row.aborted = response.destroyed; }
    } catch (error) { active?.errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise((resolve, reject) => { current.once("error", reject); current.listen(0, "127.0.0.1", () => { current.removeListener("error", reject); resolve(); }); }).catch(error => { current.close(); throw error; });
  server = current; origin = `http://127.0.0.1:${current.address().port}`; current.unref();
}

export async function closeTrendsDemandFixtureServer() {
  await active?.releaseAll();
  const receipt = active ? { reads: active.reads, writes: active.rejectedWrites, unexpectedRequests: active.unexpectedRequests } : {};
  active = null;
  const current = server; server = null;
  if (current) await new Promise(resolve => { current.close(resolve); current.closeAllConnections(); });
  origin = "";
  return { closed: true, listening: current?.listening ?? false, ...receipt };
}

/** Real Trends/charts, contexts, SWR, clientApi, CSS/fonts. No real account,
 * provider, socket, clipboard or native operation can leave this GET-only host. */
export async function openTrendsDemandFixture(page, { theme = "dark", mode = "personal", legacy = false, observer = true, reducedMotion = true } = {}) {
  await startServer();
  let built;
  try { built = await assets(legacy); } catch (error) { await closeTrendsDemandFixtureServer(); throw error; }
  const reads = [], resources = [], rejectedWrites = [], unexpectedRequests = [], errors = [], releases = new Set();
  let phase = "cold", hold, fail;
  const json = value => ({ contentType: "application/json", body: JSON.stringify(value) });
  const respond = async (url, method, authorization = "") => {
    if (method !== "GET") { rejectedWrites.push(`${method} ${url.pathname}`); return { status: 405, contentType: "text/plain", body: "Fixture permits GET only" }; }
    if (url.pathname.startsWith("/v1/") && url.pathname !== "/v1/map-image") {
      const owner = /^Bearer fixture-(owner-[ab])$/.exec(authorization)?.[1];
      const payload = owner && trendsFixturePayload(url.pathname, url.search, owner);
      if (!payload) { unexpectedRequests.push(`${method} ${url.pathname}${url.search}`); return { status: 404, contentType: "text/plain", body: "Unknown fixture endpoint or owner" }; }
      const row = { owner, path: url.pathname, search: url.search, phase, settled: false, aborted: false }; reads.push(row);
      if (fail?.(row)) { fail = null; row.settled = true; return { ...json({ error: { code: "request_timeout", message: "Synthetic request took too long" } }), status: 504 }; }
      if (hold?.matches(row)) {
        const captured = hold;
        hold = null;
        const body = new Promise(resolve => { const release = () => { releases.delete(release); resolve(JSON.stringify(captured.transform(payload))); }; releases.add(release); });
        return { contentType: "application/json", body, row };
      }
      return { ...json(payload), row };
    }
    resources.push(url.pathname);
    if (url.pathname === "/fixture.js") return { contentType: "text/javascript", body: built.script };
    if (url.pathname === "/fixture.css") return { contentType: "text/css", body: built.css };
    if (url.pathname.startsWith("/fonts/") && built.fonts.has(url.pathname.slice(7))) return { contentType: "font/woff2", body: built.fonts.get(url.pathname.slice(7)) };
    if (url.pathname === "/v1/map-image" && url.searchParams.get("map") === "Alcyone LE") return { contentType: "image/webp", body: built.mapArt };
    if (url.pathname === "/app/trends" && !url.search) return { contentType: "text/html", body: `<!doctype html><html lang="en" data-theme="${theme}" data-theme-mode="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trends local proof</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script>window.trendsMode=${JSON.stringify(mode)}</script><script src="/fixture.js"></script></body></html>` };
    if (/^\/(icons|maps)\//.test(url.pathname) && !url.pathname.includes("..")) {
      const root = path.resolve(process.cwd(), "public"), file = path.resolve(root, url.pathname.slice(1));
      if (file.startsWith(root + path.sep)) try { return { contentType: file.endsWith(".svg") ? "image/svg+xml" : file.endsWith(".webp") ? "image/webp" : "image/png", body: await readFile(file) }; } catch { /* Unknown resources are rejected below. */ }
    }
    unexpectedRequests.push(`${method} ${url.pathname}${url.search}`); return { status: 404, contentType: "text/plain", body: "Unknown fixture resource" };
  };
  active = { respond, reads, rejectedWrites, unexpectedRequests, errors, releaseAll: async () => { releases.forEach(release => release()); } };
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ colorScheme: theme, reducedMotion: reducedMotion ? "reduce" : "no-preference" });
  await page.clock.setFixedTime(new Date("2026-10-26T12:00:00Z"));
  await page.addInitScript(({ observer }) => {
    localStorage.clear();
    if (!observer) Object.defineProperty(window, "IntersectionObserver", { configurable: true, value: undefined });
  }, { observer });
  await page.context().route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "GET") {
      unexpectedRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
      if (request.method() !== "GET") rejectedWrites.push(`${request.method()} ${url.pathname}`);
      return route.abort();
    }
    return route.continue();
  });
  await page.goto(`${origin}/app/trends`);
  await page.getByRole("heading", { name: "Trends", exact: true }).waitFor();
  await page.evaluate(async () => { await document.fonts.ready; });
  return { reads, resources, rejectedWrites, unexpectedRequests, errors, metadata: { buildId: built.buildId, cssNames: built.cssNames, sourceHashes: built.sourceHashes, legacy },
    phase: value => { phase = value; }, holdNext: (predicate, transform = value => value) => { hold = { matches: predicate, transform }; }, failNext: predicate => { fail = predicate; }, releaseAll: active.releaseAll,
    summary: () => trendsGetSummary(reads), origin,
  };
}

/** Local paired proof only. Both halves run the same action sequence in fresh
 * contexts; CI's normal current-source tests do not invoke the legacy reader. */
export async function compareTrendsDemand(browser, { viewport = { width: 1280, height: 800 }, theme = "dark", mode = "personal" } = {}) {
  const results = [];
  for (const legacy of [true, false]) {
    const context = await browser.newContext({ viewport, timezoneId: "UTC" });
    const page = await context.newPage();
    let evidence;
    try {
      evidence = await openTrendsDemandFixture(page, { theme, mode, legacy, reducedMotion: true });
      const settle = async () => {
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await expect.poll(() => evidence.reads.filter(row => !row.settled && !row.aborted).length).toBe(0);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      };
      await expect(page.getByText("320", { exact: true }).first()).toBeVisible();
      await settle();
      const cold = trendsGetSummary(evidence.reads.filter(row => row.phase === "cold"));
      evidence.phase("filter-before-lower-charts");
      await page.evaluate(() => window.trendsSetFilters({ map: "Changed map", build: "Synthetic opening" }));
      await expect.poll(() => evidence.reads.filter(row => row.phase === "filter-before-lower-charts" && row.path.endsWith("/timeseries")).length).toBe(2);
      await settle();
      const filter = trendsGetSummary(evidence.reads.filter(row => row.phase === "filter-before-lower-charts"));
      evidence.phase("explicit-performance");
      await page.getByRole("navigation", { name: "Trend sections" }).getByRole("button", { name: "Performance & MMR", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Performance & MMR", exact: true })).toBeFocused();
      await settle();
      evidence.phase("retained-inspect");
      await page.getByRole("navigation", { name: "Trend sections" }).getByRole("button", { name: "Overview", exact: true }).click();
      const inspect = page.getByRole("combobox", { name: "PvZ rating window" });
      await inspect.selectOption("7");
      await page.locator("#trends-performance").evaluate(element => scrollTo(0, scrollY + element.getBoundingClientRect().top - 100));
      await settle(); await page.evaluate(() => scrollTo(0, 0)); await settle();
      await expect(inspect).toHaveValue("7");
      expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]); expect(evidence.rejectedWrites).toEqual([]);
      results.push({ legacy, viewport, theme, mode, metadata: evidence.metadata, cold, filter, total: evidence.summary(), reads: evidence.reads.map(row => ({ ...row })) });
    } finally {
      await evidence?.releaseAll();
      await context.close();
      await closeTrendsDemandFixtureServer();
    }
  }
  return { baseline: results[0], current: results[1] };
}
