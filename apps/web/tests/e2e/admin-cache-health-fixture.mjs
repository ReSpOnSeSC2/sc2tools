import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import loadConfig from "tailwindcss/loadConfig.js";

const ORIGIN = "https://admin-cache-health-fixture.local";
const SOURCE = `
import React from 'react';import{createRoot}from'react-dom/client';
import{PersonalChartCacheTile}from'@/app/admin/components/PersonalChartCacheTile';
const snapshots={
  old:undefined,
  malformed:{enabled:true,counters:{hit:3,miss:4,entries:513,bytes:1000,reserved_bytes:512,private:'must-not-render'}},
  off:{enabled:false,counters:null},
  zero:{enabled:true,counters:{hit:0,miss:0,entries:0,bytes:0,reserved_bytes:0}},
  enabled:{enabled:true,counters:{hit:3,miss:4,entries:2,bytes:1000,reserved_bytes:512}},
  maximum:{enabled:true,counters:{hit:Number.MAX_SAFE_INTEGER,miss:Number.MAX_SAFE_INTEGER,entries:512,bytes:67108863,reserved_bytes:1}},
};
const requested=new URLSearchParams(location.search).get('state')||'off';
if(!Object.hasOwn(snapshots,requested))throw new Error('Unknown explicit cache fixture state');
createRoot(document.getElementById('root')).render(
  <main className="mx-auto min-w-0 max-w-7xl space-y-6 p-4">
    <h1 className="text-h2 font-semibold text-text">Infrastructure</h1>
    <section aria-labelledby="operational-health-heading" className="space-y-3">
      <h2 id="operational-health-heading" className="text-h3 font-semibold text-text">Operational health</h2>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3"><PersonalChartCacheTile snapshot={snapshots[requested]}/></div>
    </section>
  </main>
);
`;

let assets;
function fixtureAssets() {
  return assets ??= (async () => {
    const cwd = process.cwd();
    const result = await build({
      stdin: { contents: SOURCE, loader: "tsx", resolveDir: cwd },
      bundle: true, write: false, minify: true, format: "iife", platform: "browser",
      jsx: "automatic", tsconfig: "tsconfig.json",
      define: { "process.env": "{}", "process.env.NODE_ENV": '"production"' },
      // Card exports an unrelated legacy EmptyState helper. Its Help dependency
      // is not part of the tile and must never mount in this specimen.
      plugins: [{ name: "cache-unused-help-boundary", setup(builder) {
        builder.onResolve({ filter: /^@\/components\/help\/LazyHelpLink$/ }, () => ({ path: "unused-help", namespace: "cache-fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "cache-fixture" }, () => ({
          contents: "export function LazyHelpLink(){throw new Error('Cache tile unexpectedly mounted Help UI')}", loader: "js",
        }));
      } }],
    });
    const config = loadConfig(path.join(cwd, "tailwind.config.ts")), globals = path.join(cwd, "app/globals.css");
    const css = await postcss([tailwindcss({ ...config, content: [
      { raw: SOURCE, extension: "tsx" }, path.join(cwd, "app/admin/components/PersonalChartCacheTile.tsx"),
      path.join(cwd, "components/ui/Card.tsx"),
    ] })]).process(await readFile(globals, "utf8"), { from: globals });
    const definitions = [
      ["CacheHanken", "hanken-grotesk-latin.woff2", "100 900"],
      ["CacheBricolage", "bricolage-grotesque-latin.woff2", "600 800"],
      ["CacheFraunces", "fraunces-latin-normal.woff2", "400 700"],
    ];
    const fonts = new Map(await Promise.all(definitions.map(async ([, file]) => [file, await readFile(path.join(cwd, "app/fonts", file))])));
    const fontCss = definitions.map(([family, file, weight]) => `@font-face{font-family:${family};src:url('/fonts/${file}') format('woff2');font-weight:${weight};font-style:normal;font-display:swap;}`).join("\n")
      + ":root{--font-sans:CacheHanken;--font-display:CacheBricolage;--font-serif:CacheFraunces;}";
    return { script: result.outputFiles[0].text, css: css.css + fontCss, fonts };
  })();
}

/** Actual tile, Card, formatting, current globals/tokens and local fonts.
 * Every specimen is a fresh explicit document state; no selector, store, API,
 * provider account, polling loop or listener stands in for the product.
 * @param {import('@playwright/test').Page} page
 * @param {{theme?: 'light'|'dark'}} options
 */
export async function openAdminCacheHealthFixture(page, { theme = "light" } = {}) {
  const { script, css, fonts } = await fixtureAssets();
  const errors = [], requests = [], unexpectedRequests = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    const entry = `${request.method()} ${url.origin}${url.pathname}`;
    requests.push(entry);
    if (url.origin !== ORIGIN || request.method() !== "GET") {
      unexpectedRequests.push(entry); return route.abort();
    }
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: script });
    if (url.pathname === "/fixture.css") return route.fulfill({ contentType: "text/css; charset=utf-8", body: css });
    if (url.pathname.startsWith("/fonts/") && fonts.has(url.pathname.slice(7))) return route.fulfill({ contentType: "font/woff2", body: fonts.get(url.pathname.slice(7)) });
    if (url.pathname === "/admin/health") return route.fulfill({ contentType: "text/html; charset=utf-8", body:
      `<!doctype html><html lang="en" data-theme="${theme}" data-theme-mode="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Personal chart cache layout proof</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>` });
    unexpectedRequests.push(entry); return route.fulfill({ status: 404, body: "Unknown fixture resource" });
  });
  const showState = async (state = "off") => {
    await page.goto(`${ORIGIN}/admin/health?state=${encodeURIComponent(state)}`);
    await page.getByRole("region", { name: "Personal chart cache", exact: true }).waitFor();
    await page.evaluate(async () => { await document.fonts.ready; });
  };
  await showState();
  return { errors, requests, unexpectedRequests, showState };
}
