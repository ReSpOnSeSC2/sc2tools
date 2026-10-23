import { build } from "esbuild";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

let bundle;
function fixtureBundle() {
  if (!bundle) bundle = build({
    stdin: { contents: `
      import React from "react"; import {createRoot} from "react-dom/client";
      import {ToastProvider} from "@/components/ui/Toast";
      import {PublicReplayAnalysis} from "@/components/public-profile/PublicReplayAnalysis";
      import {sharedAnalysisFixtureData} from "./tests/e2e/shared-analysis-fixture-data.mjs";
      const url=new URL(location.href); const data=sharedAnalysisFixtureData(decodeURIComponent(url.pathname.split("/").at(-1)));
      createRoot(document.getElementById("root")).render(<ToastProvider><main className="mx-auto max-w-7xl p-4 lg:p-6"><PublicReplayAnalysis key={data.game.gameId} data={data} from={url.searchParams.get("from")||undefined}/></main></ToastProvider>);
    `, loader: "tsx", resolveDir: process.cwd() },
    bundle: true, write: false, minify: true, format: "iife", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
    define: { "process.env": "{}", "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_BASE": '"https://shared-analysis-fixture.local"' },
    plugins: [{ name: "explicit-fixture-navigation", setup(builder) {
      builder.onResolve({ filter: /^next\/navigation$|^@clerk\/nextjs$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ resolveDir: process.cwd(), contents: args.path === "next/navigation" ? 'const router={push(path){location.assign(path)},refresh(){}}; export const useRouter=()=>router;' : 'const auth={isLoaded:true,isSignedIn:true,userId:"fixture-viewer",getToken:async()=>"fixture-token"};export const useAuth=()=>auth;export const SignedIn=({children})=>children;export const SignedOut=()=>null;' }));
    } }],
  }).then((result) => result.outputFiles[0].text);
  return bundle;
}

/** Actual client components with saved production CSS/fonts; all traffic stays intercepted. @param {import('@playwright/test').Page} page */
export async function openSharedAnalysisFixture(page, from = "matchup=PvZ&result=loss&cursor=old&page=3") {
  const script = await fixtureBundle(); const cssRoot = path.join(process.cwd(), ".next/static/css");
  const sheets = (await readdir(cssRoot, { recursive: true })).filter((file) => file.endsWith(".css"));
  const css = (await Promise.all(sheets.map((file) => readFile(path.join(cssRoot, file), "utf8")))).join("\n");
  const fonts = [...css.matchAll(/\.(__variable_[a-z0-9]+)\{/g)].map((match) => match[1]).join(" ");
  await page.route("https://shared-analysis-fixture.local/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: script });
    if (url.pathname === "/fixture.css") return route.fulfill({ contentType: "text/css; charset=utf-8", body: css });
    if (url.pathname.startsWith("/_next/static/media/")) return route.fulfill({ contentType: "font/woff2", body: await readFile(path.join(process.cwd(), ".next/static/media", path.basename(url.pathname))) });
    const publicRoot = path.resolve(process.cwd(), "public"); const asset = path.resolve(publicRoot, `.${url.pathname}`);
    if (asset.startsWith(publicRoot + path.sep) && /\.(png|webp|jpg|jpeg|svg)$/.test(asset)) {
      try { return await route.fulfill({ body: await readFile(asset), contentType: asset.endsWith("svg") ? "image/svg+xml" : asset.endsWith("webp") ? "image/webp" : "image/png" }); } catch { return route.fulfill({ status: 404, body: "" }); }
    }
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body class="${fonts} font-sans"><div id="root"></div><script src="/fixture.js"></script></body></html>` });
  });
  await page.goto(`https://shared-analysis-fixture.local/players/fixture-analysis-player/replays/current-game?from=${encodeURIComponent(from)}`);
}
