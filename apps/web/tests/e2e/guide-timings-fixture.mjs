import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

let bundle;
function fixtureBundle() {
  if (!bundle) bundle = build({
    stdin: { contents: `
      import React from "react";import {createRoot} from "react-dom/client";import {SWRConfig} from "swr";
      import {TimingsTable} from "@/components/guides/build/TimingsTable";import {GuidePersonalComparison} from "@/components/guides/GuidePersonalComparison";
      import {FIXTURE_BUILD_PUBLISHED} from "@/lib/guides/__fixtures__";
      const timings={...FIXTURE_BUILD_PUBLISHED.timings,milestones:FIXTURE_BUILD_PUBLISHED.timings.milestones.filter(row=>["TwilightCouncil","AdeptPiercingAttack"].includes(row.key)).map(row=>row.key==="TwilightCouncil"?{...row,p75:300}:row)};
      createRoot(document.getElementById("root")).render(<SWRConfig value={{provider:()=>new Map(),revalidateOnFocus:false}}><main className="mx-auto max-w-5xl space-y-6 p-4 lg:p-8"><h1 className="font-display text-h2 text-text">Your guide timings</h1><TimingsTable timings={timings} matchupSlug="pvz" buildSlug="stargate-into-glaives"/><GuidePersonalComparison matchupSlug="pvz" buildSlug="stargate-into-glaives" buildName="Stargate into Glaives" community={timings.milestones} communityWinRate={0.55} showTimings={false} showSignInPrompt={false}/></main></SWRConfig>);
    `, loader: "tsx", resolveDir: process.cwd() },
    bundle: true, write: false, minify: true, format: "iife", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
    define: { "process.env": "{}", "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_BASE": '"https://guide-timings-fixture.local"' },
    plugins: [{ name: "explicit-fixture-auth", setup(builder) {
      builder.onResolve({ filter: /^next\/navigation$|^@clerk\/nextjs$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ resolveDir: process.cwd(), contents: args.path === "next/navigation" ? 'import {useSyncExternalStore} from "react";const subscribe=fn=>{addEventListener("popstate",fn);return()=>removeEventListener("popstate",fn)};export const usePathname=()=>useSyncExternalStore(subscribe,()=>location.pathname,()=>"/guides/pvz/stargate-into-glaives");export const useSearchParams=()=>new URLSearchParams(useSyncExternalStore(subscribe,()=>location.search,()=>""));export const useRouter=()=>({refresh(){}});' : 'const auth={isLoaded:true,isSignedIn:true,userId:"fixture-guide-viewer",getToken:async()=>"fixture-only-token"};export const useAuth=()=>auth;' }));
    } }],
  }).then((result) => result.outputFiles[0].text);
  return bundle;
}

/** Actual islands and account-scoped SWR with intercepted synthetic data, never a real auth session.
 * @param {import('@playwright/test').Page} page @param {'success'|'retry'|'signedout'} [mode] */
export async function openGuideTimingsFixture(page, mode = "success") {
  const script = await fixtureBundle(); const cssRoot = path.join(process.cwd(), ".next/static/css");
  const sheets = (await readdir(cssRoot, { recursive: true })).filter((file) => file.endsWith(".css"));
  const css = (await Promise.all(sheets.map((file) => readFile(path.join(cssRoot, file), "utf8")))).join("\n");
  const fonts = [...css.matchAll(/\.(__variable_[a-z0-9]+)\{/g)].map((match) => match[1]).join(" "); let requests = 0;
  await page.route("https://guide-timings-fixture.local/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: script });
    if (url.pathname === "/fixture.css") return route.fulfill({ contentType: "text/css; charset=utf-8", body: css });
    if (url.pathname.startsWith("/_next/static/media/")) return route.fulfill({ contentType: "font/woff2", body: await readFile(path.join(process.cwd(), ".next/static/media", path.basename(url.pathname))) });
    if (url.pathname.startsWith("/v1/guides/me/")) {
      requests += 1;
      if (mode === "signedout") return route.fulfill({ status: 401, json: { error: "unauthorized" } });
      if (mode === "retry" && requests === 1) return route.fulfill({ status: 503, json: { error: "busy" } });
      if (mode === "retry") await new Promise((resolve) => setTimeout(resolve, 150));
      return route.fulfill({ json: { matchup: "PvZ", buildKey: "PvZ - Stargate into Glaives", era: "after", games: 37, wins: 18, losses: 19, winRate: 0.4865, timings: { samples: 2, milestones: [{ key: "TwilightCouncil", label: "Twilight Council", event: "start", median: 302, games: 2 }] } } });
    }
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body class="${fonts} font-sans"><div id="root"></div><script src="/fixture.js"></script></body></html>` });
  });
  await page.goto("https://guide-timings-fixture.local/guides/pvz/stargate-into-glaives");
  return { requests: () => requests };
}
