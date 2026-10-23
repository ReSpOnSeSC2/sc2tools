import { build } from "esbuild";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// Actual client components and production CSS, with explicit local auth/API
// fixtures. This never changes the application's Clerk setup or production data.
const bundles = new Map();
function fixtureBundle(kind, signedIn) {
  const key = `${kind}:${signedIn}`;
  if (!bundles.has(key)) bundles.set(key, build({
    stdin: { contents: kind === "creator" ? `
      import React, {useState} from "react";
      import {createRoot} from "react-dom/client";
      import {SWRConfig} from "swr";
      import {ToastProvider} from "@/components/ui/Toast";
      import {PublishCta} from "@/components/community/PublishCta";
      import {MyPublishedBuilds} from "@/components/community/MyPublishedBuilds";
      import {BuildPublishIntent} from "@/components/builds/BuildPublishIntent";
      import {BuildPublishModal} from "@/components/builds/BuildPublishModal";
      function Creator() {
        const [chosen,setChosen]=useState(null); const [editor,setEditor]=useState(false);
        const library=window.location.pathname==="/builds";
        return <main className="mx-auto max-w-4xl space-y-6 p-4 pb-20"><h1 className="text-h2">Community creator fixture</h1>
          {library ? <BuildPublishIntent onChoose={setChosen} onCreate={()=>setEditor(true)}/> : <><PublishCta/><MyPublishedBuilds/></>}
          {editor ? <p>Editor requested</p> : null}
          {chosen ? <BuildPublishModal open build={chosen} onClose={()=>setChosen(null)} onPublished={()=>{}}/> : null}
        </main>;
      }
      createRoot(document.getElementById("root")).render(<SWRConfig value={{provider:()=>new Map(),shouldRetryOnError:false}}><ToastProvider><Creator/></ToastProvider></SWRConfig>);
    ` : `
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
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ resolveDir: process.cwd(), contents: args.path === "next/navigation"
        ? 'import {useSyncExternalStore} from "react"; const router={refresh(){},replace(path){window.fixtureNavigation=path;history.replaceState(null,"",path);window.dispatchEvent(new PopStateEvent("popstate"));}}; export const useRouter=()=>router; const subscribe=(fn)=>{window.addEventListener("popstate",fn);return()=>window.removeEventListener("popstate",fn)}; export const useSearchParams=()=>new URLSearchParams(useSyncExternalStore(subscribe,()=>location.search,()=>""));'
        : `const auth={isLoaded:true,isSignedIn:${signedIn},userId:${signedIn ? '"fixture-owner"' : 'null'},getToken:async()=>"fixture-token"}; export const useAuth=()=>auth; export const SignedIn=({children})=>auth.isSignedIn?children:null; export const SignedOut=({children})=>auth.isSignedIn?null:children;` }));
    } }],
  }).then((result) => result.outputFiles[0].text));
  return bundles.get(key);
}

/** @param {import('@playwright/test').Page} page @param {import('@playwright/test').APIRequestContext} request @param {{kind?: string,signedIn?: boolean,initialPath?: string,emptyLibrary?:boolean,failListOnce?:boolean,failPublishOnce?:boolean}} [options] */
export async function openCommunityInteractiveFixture(page, request, options = {}) {
  const bundle = await fixtureBundle(options.kind ?? "interaction", options.signedIn !== false);
  const shell = await (await request.get("/community/builds/fixture-community-polish")).text();
  const htmlClass = /<html[^>]*class="([^"]*)"/.exec(shell)?.[1] ?? "";
  const bodyClass = /<body[^>]*class="([^"]*)"/.exec(shell)?.[1] ?? "";
  const cssRoot = path.join(process.cwd(), ".next/static/css");
  const sheets = (await readdir(cssRoot, { recursive: true })).filter((file) => file.endsWith(".css"));
  const css = (await Promise.all(sheets.map((file) => readFile(path.join(cssRoot, file), "utf8")))).join("\n");
  const calls = [];
  let votes = { votes: 3, myVote: 0 };
  let listFailed = false; let publishFailed = false;
  const privateBuilds = options.emptyLibrary ? [] : [
    { slug: "private-build-alpha", name: "Safe opening", race: "Protoss", vsRace: "Zerg", description: "A safe opening", updatedAt: "2026-10-03T00:00:00Z" },
    { slug: "private-build-beta", name: "Variant pressure", race: "Terran", vsRace: "Protoss", description: "A private variant", updatedAt: "2026-10-02T00:00:00Z" },
  ];
  const base = { slug: "fixture-community-polish", sourceSlug: "private-build-alpha", title: "Safe opening", matchup: "PvZ", total: 12, wins: 8, losses: 4, votes: 5, upCount: 7, downCount: 2, publishedAt: "2026-03-01T00:00:00Z", updatedAt: "2026-10-03T23:30:00Z", removed: false, publishAnonymously: false };
  const publications = options.emptyLibrary ? [] : [base, { ...base, slug: "anonymous-public", sourceSlug: "private-anonymous", title: "Anonymous opening", publishAnonymously: true }, { ...base, slug: "moderated-public", sourceSlug: "private-moderated", title: "Removed listing", removed: true, removedByModerator: true }];
  await page.route("https://community-fixture.local/**", async (route) => {
    const url = new URL(route.request().url()); const pathname = url.pathname;
    if (pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: bundle });
    if (pathname === "/fixture.css") return route.fulfill({ contentType: "text/css; charset=utf-8", body: css });
    if (pathname.startsWith("/_next/static/media/")) {
      const asset = path.resolve(process.cwd(), ".next/static/media", path.basename(pathname));
      return route.fulfill({ contentType: "font/woff2", body: await readFile(asset) });
    }
    if (pathname.startsWith("/v1/")) {
      const method = route.request().method();
      const body = route.request().postDataJSON(); calls.push({ pathname, method, body });
      if (pathname === "/v1/custom-builds" && options.failListOnce && !listFailed) { listFailed = true; return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable", message: "Fixture library unavailable" } }) }); }
      if (pathname === "/v1/community/builds" && method === "POST" && options.failPublishOnce && !publishFailed) { publishFailed = true; return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable", message: "Fixture publication unavailable" } }) }); }
      if (pathname === "/v1/community/my-builds") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: publications }) });
      if (pathname === "/v1/custom-builds") {
        const items = privateBuilds.filter((build) => build.name.toLowerCase().includes((url.searchParams.get("nameSearch") || "").toLowerCase()));
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ items, total: items.length, libraryTotal: privateBuilds.length, limit: 50, nextCursor: null }) });
      }
      if (pathname.startsWith("/v1/custom-builds/") && method === "GET") return route.fulfill({ contentType: "application/json", body: JSON.stringify(privateBuilds.find((build) => build.slug === pathname.split("/").at(-1))) });
      if (pathname.startsWith("/v1/community/my-build-publication/")) {
        const slug = pathname.split("/").at(-1); const published = publications.find((row) => row.sourceSlug === slug && !row.removed);
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ published: !!published, publicSlug: published?.slug ?? null, authorName: "Fixture creator", publishAnonymously: published?.publishAnonymously ?? false, mirrorPending: false }) });
      }
      if (pathname === "/v1/community/builds" && method === "POST") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ slug: publications.find((row) => row.sourceSlug === body.slug)?.slug ?? "fixture-new-public" }) });
      if (pathname.endsWith("/vote") && method === "POST") votes = { votes: 3 + body.delta, myVote: body.delta };
      const data = pathname.endsWith("/my-vote") || pathname.endsWith("/vote") ? votes : pathname === "/v1/community/my-build-stats" ? { items: [{ publicSlug: "fixture-community-polish", total: 12, wins: 8, losses: 4 }] } : pathname === "/v1/community/reports" ? { alreadyReported: false } : { items: [] };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
    }
    if (pathname.startsWith("/icons/")) return route.fulfill({ contentType: "image/png", body: await readFile(path.join(process.cwd(), "public", pathname)) });
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html lang="en" class="${htmlClass}"><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body class="${bodyClass}"><div id="root"></div><script src="/fixture.js"></script></body></html>` });
  });
  await page.goto(`https://community-fixture.local${options.initialPath ?? "/"}`);
  return calls;
}
