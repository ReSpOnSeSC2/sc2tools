import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import loadConfig from "tailwindcss/loadConfig.js";

const ORIGIN = "https://filter-overlays-fixture.local";
const SOURCE = `import React,{useState} from "react";import {createRoot} from "react-dom/client";
import {FilterBar} from "@/components/analyzer/FilterBar";
import {FiltersContext,defaultAnalyzerFilters,filtersToQuery} from "@/lib/filterContext";
function Fixture(){const[filters,setFilters]=useState(defaultAnalyzerFilters());
return <main className="mx-auto max-w-5xl space-y-4 p-4">
  <h1 className="text-h2">Analyzer filter fixture</h1>
  <FiltersContext.Provider value={{filters,setFilters,dbRev:0,bumpRev:()=>{},seasons:[]}}><FilterBar/></FiltersContext.Provider>
  <button className="min-h-11 rounded border border-border p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Outside filter action</button>
  <output aria-label="Wire filters" className="block break-all">{filtersToQuery(filters)}</output>
  <div style={{height:1300}} aria-hidden="true"/>
</main>;}createRoot(document.getElementById("root")).render(<Fixture/>);`;

const adapters = {
  "@clerk/nextjs": 'export const useAuth=()=>({isLoaded:true,isSignedIn:true,userId:"filter-fixture-owner"});',
  "@/lib/clientApi": 'const response={data:undefined,isLoading:false,error:null};export const useApi=()=>response;',
  "@/components/help/LazyHelpLink": 'import React from "react";export const LazyHelpLink=({children,slug})=><a href={"/help/"+slug}>{children}</a>;',
  "./AnalyzerViewsButton": 'import React from "react";export const AnalyzerViewsButton=()=> <button className="min-h-11 px-3">Views</button>;',
};
let assets;
function fixtureAssets() {
  return assets ??= (async () => {
    const cwd = process.cwd();
    const result = await build({ stdin: { contents: SOURCE, loader: "tsx", resolveDir: cwd }, bundle: true,
      write: false, minify: true, format: "iife", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
      define: { "process.env": "{}", "process.env.NODE_ENV": '"production"' },
      plugins: [{ name: "explicit-filter-fixture-boundaries", setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => adapters[args.path] ? { path: args.path, namespace: "filter-adapter" } : undefined);
        builder.onLoad({ filter: /.*/, namespace: "filter-adapter" }, args => ({ contents: adapters[args.path], loader: "tsx", resolveDir: cwd }));
      } }],
    });
    const config = loadConfig(path.join(cwd, "tailwind.config.ts"));
    const globals = path.join(cwd, "app/globals.css");
    const css = await postcss([tailwindcss({ ...config, content: [{ raw: SOURCE, extension: "tsx" },
      path.join(cwd, "components/analyzer/*.tsx"), path.join(cwd, "components/ui/**/*.{ts,tsx}")],
    })]).process(await readFile(globals, "utf8"), { from: globals });
    const definitions = [["FilterHanken", "hanken-grotesk-latin.woff2", "100 900"],
      ["FilterBricolage", "bricolage-grotesque-latin.woff2", "600 800"], ["FilterFraunces", "fraunces-latin-normal.woff2", "400 700"]];
    const fonts = new Map(await Promise.all(definitions.map(async ([, file]) => [file, await readFile(path.join(cwd, "app/fonts", file))])));
    const fontCss = definitions.map(([family, file, weight]) => `@font-face{font-family:${family};src:url('/fonts/${file}') format('woff2');font-weight:${weight};font-style:normal;font-display:swap;}`).join("\n")
      + ':root{--font-sans:FilterHanken;--font-display:FilterBricolage;--font-serif:FilterFraunces;}';
    return { script: result.outputFiles[0].text, css: css.css + fontCss, fonts };
  })();
}

/** Real filter consumers, primitives, Tailwind tokens and committed fonts.
 * Clerk, empty API responses, Help links and the unrelated saved-view launcher
 * are explicit adapters. No account, storage, clipboard or server is used.
 * @param {import('@playwright/test').Page} page
 * @param {'light'|'dark'} theme
 */
export async function openFilterOverlaysFixture(page, theme) {
  const { script, css, fonts } = await fixtureAssets();
  const errors = [], unexpectedRequests = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== ORIGIN || request.method() !== "GET") {
      unexpectedRequests.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort();
    }
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: script });
    if (url.pathname === "/fixture.css") return route.fulfill({ contentType: "text/css", body: css });
    if (url.pathname.startsWith("/fonts/") && fonts.has(url.pathname.slice(7))) return route.fulfill({ contentType: "font/woff2", body: fonts.get(url.pathname.slice(7)) });
    if (url.pathname === "/filters") return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en" data-theme="${theme}" data-theme-mode="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Analyzer filter fixture</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>` });
    unexpectedRequests.push(`${request.method()} ${url.pathname}`); return route.fulfill({ status: 404, body: "Unknown fixture resource" });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${ORIGIN}/filters`);
  await page.getByRole("heading", { name: "Analyzer filter fixture", exact: true }).waitFor();
  await page.evaluate(async () => { await document.fonts.ready; });
  return { errors, unexpectedRequests };
}
