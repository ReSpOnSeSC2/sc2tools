import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import loadConfig from "tailwindcss/loadConfig.js";

const ORIGIN = "https://public-player-settings-fixture.local";
const SOURCE = `import React from "react";import {createRoot} from "react-dom/client";
import {SWRConfig} from "swr";import {setFixtureOwner,useAuth} from "@clerk/nextjs";
import {SettingsPublicProfile} from "@/components/analyzer/settings/SettingsPublicProfile";
import {Button} from "@/components/ui/Button";import {ToastProvider} from "@/components/ui/Toast";
function Fixture(){const auth=useAuth();return <main className="mx-auto max-w-5xl space-y-5 p-4">
<h1 className="text-h2">Public profile settings fixture</h1><div className="flex flex-wrap gap-2">
<Button onClick={()=>setFixtureOwner("owner-a")}>Use fixture account A</Button>
<Button onClick={()=>setFixtureOwner("owner-b")}>Use fixture account B</Button>
<output aria-label="Fixture owner">{auth.userId}</output></div><SettingsPublicProfile/></main>;}
const cache=new Map();createRoot(document.getElementById("root")).render(<SWRConfig value={{provider:()=>cache,dedupingInterval:0,shouldRetryOnError:false}}><ToastProvider><Fixture/></ToastProvider></SWRConfig>);`;
const adapters = {
  "next/link": 'import React from "react";export default React.forwardRef(function Link({prefetch,replace,scroll,...props},ref){return <a {...props} ref={ref}/>;});',
  "@clerk/nextjs": `import {useSyncExternalStore,useCallback} from "react";let owner="owner-a";const listeners=new Set();const subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn);};
export const setFixtureOwner=next=>{owner=next;listeners.forEach(fn=>fn());};export function useAuth(){const value=useSyncExternalStore(subscribe,()=>owner);const getToken=useCallback(async()=>"fixture-token-"+value,[value]);return {isLoaded:true,isSignedIn:true,userId:value,getToken};}`,
  "@/components/help/LazyHelpLink": 'import React from "react";export const LazyHelpLink=({children})=><span>{children}</span>;',
};
let assets;
function fixtureAssets() {
  return assets ??= (async () => {
    const cwd = process.cwd();
    const result = await build({ stdin: { contents: SOURCE, loader: "tsx", resolveDir: cwd }, bundle: true,
      write: false, minify: true, format: "iife", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
      define: { "process.env": JSON.stringify({ NEXT_PUBLIC_API_BASE: ORIGIN, NODE_ENV: "production" }) },
      plugins: [{ name: "public-settings-fixture-boundaries", setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => adapters[args.path] ? { path: args.path, namespace: "player-fixture" } : undefined);
        builder.onLoad({ filter: /.*/, namespace: "player-fixture" }, args => ({ contents: adapters[args.path], loader: "tsx", resolveDir: cwd }));
      } }],
    });
    const config = loadConfig(path.join(cwd, "tailwind.config.ts")), globals = path.join(cwd, "app/globals.css");
    const css = await postcss([tailwindcss({ ...config, content: [{ raw: SOURCE, extension: "tsx" },
      path.join(cwd, "components/analyzer/settings/*.{ts,tsx}"), path.join(cwd, "components/public-profile/*.{ts,tsx}"), path.join(cwd, "components/ui/**/*.{ts,tsx}")],
    })]).process(await readFile(globals, "utf8"), { from: globals });
    const definitions = [["PlayerHanken", "hanken-grotesk-latin.woff2", "100 900"],
      ["PlayerBricolage", "bricolage-grotesque-latin.woff2", "600 800"], ["PlayerFraunces", "fraunces-latin-normal.woff2", "400 700"]];
    const fonts = new Map(await Promise.all(definitions.map(async ([, file]) => [file, await readFile(path.join(cwd, "app/fonts", file))])));
    const fontCss = definitions.map(([family, file, weight]) => `@font-face{font-family:${family};src:url('/fonts/${file}') format('woff2');font-weight:${weight};font-style:normal;font-display:swap;}`).join("\n")
      + ':root{--font-sans:PlayerHanken;--font-display:PlayerBricolage;--font-serif:PlayerFraunces;}';
    return { script: result.outputFiles[0].text, css: css.css + fontCss, fonts };
  })();
}
const settings = owner => ({ enabled: true, legacyPublic: false, slug: owner === "owner-b" ? "beta-abcdef0123" : "frontier-0123456789",
  revision: 0, updatedAt: null, renameAvailableAt: null, replaySharingEnabled: false, publicDisplayName: "Synthetic Public Player",
  showReplays: false, showChannels: false, showRecentForm: false, showMmrHistory: false, showSeasons: false, showMaps: false });

/** Actual settings, API ownership, copy controls, global CSS and local fonts.
 * Clerk and all HTTP requests are isolated synthetic adapters; no live account
 * or publication preference can be reached by this fixture. */
export async function openPublicPlayerSettingsFixture(page) {
  const { script, css, fonts } = await fixtureAssets();
  const errors = [], unexpectedRequests = [], writes = [], held = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { configurable: true,
    value: { writeText: async () => { throw new DOMException("Fixture permission denied", "NotAllowedError"); } },
  }));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== ORIGIN) { unexpectedRequests.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort(); }
    const json = data => route.fulfill({ contentType: "application/json", body: JSON.stringify(data), headers: { "cache-control": "no-store" } });
    if (url.pathname === "/v1/me/public-profile") {
      const owner = request.headers().authorization?.endsWith("owner-b") ? "owner-b" : "owner-a";
      if (request.method() === "GET") return json(settings(owner));
      if (request.method() === "PUT") { const body = request.postDataJSON(); writes.push({ owner, body }); held.push({ route, owner, body }); return; }
    }
    if (request.method() === "GET") {
      if (url.pathname === "/v1/me/public-profile/slug") return json({ slug: url.searchParams.get("slug"), available: true, reason: null });
      if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: script });
      if (url.pathname === "/fixture.css") return route.fulfill({ contentType: "text/css", body: css });
      if (url.pathname.startsWith("/fonts/") && fonts.has(url.pathname.slice(7))) return route.fulfill({ contentType: "font/woff2", body: fonts.get(url.pathname.slice(7)) });
      if (url.pathname === "/settings") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en" data-theme="dark" data-theme-mode="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
    }
    unexpectedRequests.push(`${request.method()} ${url.pathname}`); return route.fulfill({ status: 404, body: "Unknown fixture resource" });
  });
  await page.goto(`${ORIGIN}/settings`);
  await page.getByRole("textbox", { name: "Player link prefix" }).waitFor();
  await page.evaluate(async () => { await document.fonts.ready; });
  return { errors, unexpectedRequests, writes, async releaseWrites() {
    for (const entry of held.splice(0)) {
      try { await entry.route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...settings(entry.owner), ...entry.body, revision: 1 }) }); }
      catch { /* The browser may already have aborted the retired owner's fetch. */ }
    }
  } };
}
