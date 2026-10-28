import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import loadConfig from "tailwindcss/loadConfig.js";

const ORIGIN = "https://today-stat-height-fixture.local";
const SOURCE = `import React from'react';import{createRoot}from'react-dom/client';
import{FiltersContext,DEFAULT_ANALYZER_FILTERS}from'@/lib/filterContext';
import{DashboardKpiStrip}from'@/components/analyzer/DashboardKpiStrip';
import{currentHistory}from'@/components/sessions/__tests__/sessionHistoryFixtures';
const state=new URLSearchParams(location.search).get('state')||'populated';
if(!['populated','empty','loading'].includes(state))throw new Error('Unknown explicit Today specimen');
const filters={...DEFAULT_ANALYZER_FILTERS,preset:'season:68',since:'2026-07-19T00:00:00.000Z',until:'2026-10-28T00:00:00.000Z',regions:'NA,EU',min_minutes:10,max_minutes:20};
window.todayFixtureRequests=[];window.todayFixtureFilterWrites=[];
window.todayFixtureSession=state==='loading'?undefined:state==='empty'?currentHistory({session:null,activity:'empty',manualAnchorAt:null}):currentHistory();
window.todayFixtureApi=key=>{
  window.todayFixtureRequests.push(key);
  if(state==='loading')return undefined;
  if(key.startsWith('/v1/me/mmr'))return{entries:state==='empty'?[]:[{pulseId:'fixture-na',region:'NA',mmr:5468},{pulseId:'fixture-eu',region:'EU',mmr:5224}],truncated:false};
  if(key.startsWith('/v1/streak'))return{kind:state==='empty'?null:'win',count:state==='empty'?0:2,lastGameAt:null};
  if(key.startsWith('/v1/timeseries')){const range=new URLSearchParams(key.split('?')[1]?.split('#')[0]).get('interval')==='month';
    return{interval:range?'month':'day',points:state==='empty'?[]:[{bucket:'2026-10-01T12:00:00Z',wins:range?200:161,losses:range?150:116,total:range?350:277}]};}
  throw new Error('Unexpected synthetic KPI request: '+key);
};
createRoot(document.getElementById('root')).render(<FiltersContext.Provider value={{filters,setFilters:value=>window.todayFixtureFilterWrites.push(value),dbRev:7,bumpRev:()=>{},seasons:[]}}>
  <main className="mx-auto min-w-0 max-w-7xl space-y-5 p-4"><h1 className="text-h2 font-semibold text-text">Today</h1><DashboardKpiStrip/></main>
</FiltersContext.Provider>);`;

// Keep every card and its loading/content renderer real. Only framework links,
// lazy mounting and the two declared request hooks are synthetic boundaries.
const adapters = {
  "next/link": `import React from'react';export default React.forwardRef(function Link({prefetch,replace,scroll,...props},ref){return <a {...props} ref={ref}/>});`,
  "next/dynamic": `import React,{lazy,Suspense}from'react';export default function dynamic(loader,options={}){const Loaded=lazy(async()=>{const value=await loader();return{default:value.default??value}});return function Dynamic(props){return <Suspense fallback={options.loading?React.createElement(options.loading):null}><Loaded {...props}/></Suspense>}};`,
  "@/lib/clientApi": `export function useApi(key){return{data:window.todayFixtureApi(key),error:undefined,isLoading:false,isPreviousData:false,mutate:()=>{throw new Error('Unexpected KPI retry')}}}`,
  "session-request": `export function useSessionRequest(key){window.todayFixtureRequests.push(key);return{data:window.todayFixtureSession,error:undefined,isPreviousData:false,mutate:()=>{throw new Error('Unexpected session retry')},current:()=>true,key}}`,
  "@/components/help/LazyHelpLink": `export function LazyHelpLink(){throw new Error('Unexpected Help mount in KPI specimen')}`,
};

let assets;
function fixtureAssets() {
  return assets ??= (async () => {
    const cwd = process.cwd();
    const result = await build({ stdin: { contents: SOURCE, loader: "tsx", resolveDir: cwd }, bundle: true,
      write: false, minify: true, format: "iife", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
      define: { "process.env": "{}", "process.env.NODE_ENV": '"production"' },
      plugins: [{ name: "today-request-boundaries", setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => {
          if (Object.hasOwn(adapters, args.path)) return { path: args.path, namespace: "today-fixture" };
          if (/(?:^|\/)useSessionRequest$/.test(args.path)) return { path: "session-request", namespace: "today-fixture" };
        });
        builder.onLoad({ filter: /.*/, namespace: "today-fixture" }, args => ({ contents: adapters[args.path], loader: "tsx", resolveDir: cwd }));
      } }],
    });
    const config = loadConfig(path.join(cwd, "tailwind.config.ts")), globals = path.join(cwd, "app/globals.css");
    const css = await postcss([tailwindcss({ ...config, content: [{ raw: SOURCE, extension: "tsx" },
      path.join(cwd, "components/analyzer/DashboardKpiStrip.tsx"), path.join(cwd, "components/analyzer/WinRateTimeframeMenu.tsx"),
      path.join(cwd, "components/sessions/**/*.{ts,tsx}"), path.join(cwd, "components/ui/**/*.{ts,tsx}"),
    ] })]).process(await readFile(globals, "utf8"), { from: globals });
    const definitions = [["TodayHanken", "hanken-grotesk-latin.woff2", "100 900"],
      ["TodayBricolage", "bricolage-grotesque-latin.woff2", "600 800"], ["TodayFraunces", "fraunces-latin-normal.woff2", "400 700"]];
    const fonts = new Map(await Promise.all(definitions.map(async ([, file]) => [file, await readFile(path.join(cwd, "app/fonts", file))])));
    const fontCss = definitions.map(([family, file, weight]) => `@font-face{font-family:${family};src:url('/fonts/${file}') format('woff2');font-weight:${weight};font-style:normal;font-display:swap;}`).join("\n")
      + ":root{--font-sans:TodayHanken;--font-display:TodayBricolage;--font-serif:TodayFraunces;}";
    return { script: result.outputFiles[0].text, css: css.css + fontCss, fonts };
  })();
}

/** GET-only intercepted documents, no listener, live account or provider.
 * @param {import('@playwright/test').Page} page
 * @param {{theme?: 'light'|'dark'}} options
 */
export async function openTodayStatHeightFixture(page, { theme = "light" } = {}) {
  const { script, css, fonts } = await fixtureAssets();
  const errors = [], unexpectedRequests = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== ORIGIN || request.method() !== "GET") {
      unexpectedRequests.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort();
    }
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: script });
    if (url.pathname === "/fixture.css") return route.fulfill({ contentType: "text/css; charset=utf-8", body: css });
    if (url.pathname.startsWith("/fonts/") && fonts.has(url.pathname.slice(7))) return route.fulfill({ contentType: "font/woff2", body: fonts.get(url.pathname.slice(7)) });
    if (url.pathname === "/app") return route.fulfill({ contentType: "text/html; charset=utf-8", body:
      `<!doctype html><html lang="en" data-theme="${theme}" data-theme-mode="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Today statistic sizing proof</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>` });
    unexpectedRequests.push(`${request.method()} ${url.pathname}`); return route.fulfill({ status: 404, body: "Unknown fixture resource" });
  });
  const showState = async (state = "populated") => {
    await page.goto(`${ORIGIN}/app?state=${encodeURIComponent(state)}`);
    const session = page.getByTestId("kpi-today-session");
    if (state === "loading") await session.getByRole("status").waitFor();
    else await session.getByRole("link", { name: "Natural session history", exact: true }).waitFor();
    await page.evaluate(async () => { await document.fonts.ready; });
  };
  await showState();
  return { errors, unexpectedRequests, showState };
}
