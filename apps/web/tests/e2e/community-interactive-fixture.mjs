import { build } from "esbuild";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// Actual client components and production CSS, with explicit local auth/API
// fixtures. This never changes the application's Clerk setup or production data.
let bundlePromise;
function fixtureBundle() {
  bundlePromise ??= build({
    stdin: { contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { SWRConfig } from "swr";
      import { ToastProvider } from "@/components/ui/Toast";
      import { CommunityBuildCard } from "@/components/community/CommunityBuildCard";
      import { CommunityBuildActionsBar } from "@/components/community/CommunityBuildActionsBar";
      import { CommunityBuildReport } from "@/components/community/CommunityBuildReport";
      import { CommunityVotePanel } from "@/components/community/CommunityVotePanel";
      import { COMMUNITY_DETAIL } from "./tests/e2e/mock-community-detail-api.mjs";
      createRoot(document.getElementById("root")).render(<SWRConfig value={{provider: () => new Map(), shouldRetryOnError: false}}><ToastProvider>
        <main className="mx-auto max-w-4xl space-y-6 p-4 pb-20">
          <h1 className="text-h2">Community interaction fixture</h1>
          <CommunityBuildActionsBar build={COMMUNITY_DETAIL} />
          <section aria-label="Desktop vote fixture" className="rounded-xl border border-border p-4"><CommunityVotePanel slug={COMMUNITY_DETAIL.slug} initialVotes={3} /></section>
          <CommunityBuildCard build={{...COMMUNITY_DETAIL, authorName: "A".repeat(80)}} />
          <CommunityBuildReport slug={COMMUNITY_DETAIL.slug} />
        </main>
      </ToastProvider></SWRConfig>);
    `, loader: "tsx", resolveDir: process.cwd() },
    bundle: true, write: false, minify: true, format: "iife", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
    define: { "process.env": "{}", "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_BASE": '"https://community-fixture.local"', "process.env.NEXT_PUBLIC_BUILD_SHA": '"fixture"', "process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY": '"pk_live_Y2xlcmsuZXhhbXBsZS5jb20k"' },
    plugins: [{ name: "explicit-local-fixture-auth", setup(builder) {
      builder.onResolve({ filter: /^@clerk\/nextjs$|^next\/navigation$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ contents: args.path === "next/navigation"
        ? 'const router={refresh(){},replace(path){window.fixtureNavigation=path}}; export const useRouter=()=>router;'
        : 'const auth={isLoaded:true,isSignedIn:true,userId:"fixture-owner",getToken:async()=>"fixture-token"}; export const useAuth=()=>auth; export const SignedIn=({children})=>children; export const SignedOut=()=>null;' }));
    } }],
  }).then((result) => result.outputFiles[0].text);
  return bundlePromise;
}

export async function openCommunityInteractiveFixture(page, request) {
  const bundle = await fixtureBundle();
  const shell = await (await request.get("/community/builds/fixture-community-polish")).text();
  const htmlClass = /<html[^>]*class="([^"]*)"/.exec(shell)?.[1] ?? "";
  const bodyClass = /<body[^>]*class="([^"]*)"/.exec(shell)?.[1] ?? "";
  const cssRoot = path.join(process.cwd(), ".next/static/css");
  const sheets = (await readdir(cssRoot, { recursive: true })).filter((file) => file.endsWith(".css"));
  const css = (await Promise.all(sheets.map((file) => readFile(path.join(cssRoot, file), "utf8")))).join("\n");
  const calls = [];
  let votes = { votes: 3, myVote: 0 };
  await page.route("https://community-fixture.local/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: bundle });
    if (pathname === "/fixture.css") return route.fulfill({ contentType: "text/css; charset=utf-8", body: css });
    if (pathname.startsWith("/_next/static/media/")) {
      const asset = path.resolve(process.cwd(), ".next/static/media", path.basename(pathname));
      return route.fulfill({ contentType: "font/woff2", body: await readFile(asset) });
    }
    if (pathname.startsWith("/v1/")) {
      const method = route.request().method();
      const body = route.request().postDataJSON(); calls.push({ pathname, method, body });
      if (pathname.endsWith("/vote") && method === "POST") votes = { votes: 3 + body.delta, myVote: body.delta };
      const data = pathname.endsWith("/my-vote") || pathname.endsWith("/vote") ? votes : pathname === "/v1/community/my-build-stats" ? { items: [{ publicSlug: "fixture-community-polish", total: 12, wins: 8, losses: 4 }] } : pathname === "/v1/community/reports" ? { alreadyReported: false } : { items: [] };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
    }
    if (pathname.startsWith("/icons/")) return route.fulfill({ contentType: "image/png", body: await readFile(path.join(process.cwd(), "public", pathname)) });
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html lang="en" class="${htmlClass}"><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body class="${bodyClass}"><div id="root"></div><script src="/fixture.js"></script></body></html>` });
  });
  await page.goto("https://community-fixture.local/");
  return calls;
}
