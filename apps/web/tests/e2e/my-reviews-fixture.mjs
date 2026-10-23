import { build } from "esbuild";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

let bundle;
function fixtureBundle() {
  return bundle ??= build({
    stdin: { contents: `
      import React from "react";import {createRoot} from "react-dom/client";
      import {SWRConfig} from "swr";import Page from "@/app/reviews/mine/page";
      const replace=history.replaceState.bind(history);history.replaceState=(...args)=>{replace(...args);dispatchEvent(new PopStateEvent("popstate"));};
      createRoot(document.getElementById("root")).render(<SWRConfig value={{dedupingInterval:0,shouldRetryOnError:false}}><main className="mx-auto max-w-7xl p-4 lg:p-6"><Page/></main></SWRConfig>);
    `, loader: "tsx", resolveDir: process.cwd() },
    bundle: true, write: false, minify: true, format: "iife", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
    define: { "process.env": "{}", "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_REVIEWS_ENABLED": '"on"', "process.env.NEXT_PUBLIC_API_BASE": '"https://my-reviews-fixture.local"' },
    plugins: [{ name: "explicit-fixture-auth-and-navigation", setup(builder) {
      builder.onResolve({ filter: /^next\/navigation$|^@clerk\/nextjs$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ resolveDir: process.cwd(), contents: args.path === "next/navigation"
        ? 'import {useSyncExternalStore} from "react";export const useSearchParams=()=>new URLSearchParams(useSyncExternalStore(fn=>{addEventListener("popstate",fn);return()=>removeEventListener("popstate",fn)},()=>location.search));export const useRouter=()=>({push:path=>location.assign(path),refresh(){}});export const notFound=()=>{throw Error("Unexpected fixture notFound")};'
        : 'const auth={isLoaded:true,isSignedIn:true,userId:"fixture-reviewer",getToken:async()=>"fixture-token"};export const useAuth=()=>auth;export const SignedIn=({children})=>children;export const SignedOut=()=>null;' }));
    } }],
  }).then((result) => result.outputFiles[0].text);
}

function card(id, status = "open", reviewCount = 1) {
  return { id, url: `/reviews/${id}`, question: `How should I defend the third base in ${id}?`, matchup: "PvZ", map: "Alcyone LE", tags: ["scouting"],
    result: "Loss", durationSec: 640, askerLabel: "Anonymous Protoss", askerBand: null, desiredLevel: "anyone", status, reviewCount,
    helpfulCount: 0, hasBest: status === "answered", hasPlayback: false, createdAt: "2026-10-20T12:00:00Z", lastActivityAt: null, isOwn: true };
}
const written = (id, upvotes) => ({ request: card(`request-${id}`), commentId: id, snippet: `Scout the third base before moving out: ${id}.`, helpful: true, best: false, upvotes, createdAt: "2026-10-20T12:00:00Z" });

/** Production components, real API hooks/SWR, synthetic auth, intercepted local data only.
 * @param {import('@playwright/test').Page} page
 * @param {{tab?:string,failPage?:boolean}} options
 */
export async function openMyReviewsFixture(page, options = {}) {
  const script = await fixtureBundle(); const cssRoot = path.join(process.cwd(), ".next/static/css");
  const sheets = (await readdir(cssRoot, { recursive: true })).filter((file) => file.endsWith(".css"));
  const css = (await Promise.all(sheets.map((file) => readFile(path.join(cssRoot, file), "utf8")))).join("\n");
  const fonts = [...css.matchAll(/\.(__variable_[a-z0-9]+)\{/g)].map((match) => match[1]).join(" ");
  const calls = []; let pageFailed = false;
  let reviewer = { name: "Fixture Reviewer", stats: { karma: 42, reviews: 12, helpful: 5, best: 2, upvotes: 7, removed: 0 },
    badges: [{ key: "first_review", label: "First Review" }], verified: null, verificationReason: "not_enough_ladder_games", flair: null,
    syncedGames: 14, requiredGames: 20, canComment: false, leaderboardOptIn: false, weeklyDigest: true };
  await page.route("https://my-reviews-fixture.local/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: script });
    if (url.pathname === "/fixture.css") return route.fulfill({ contentType: "text/css; charset=utf-8", body: css });
    if (url.pathname.startsWith("/_next/static/media/")) return route.fulfill({ contentType: "font/woff2", body: await readFile(path.join(process.cwd(), ".next/static/media", path.basename(url.pathname))) });
    if (url.pathname.startsWith("/v1/")) {
      const body = route.request().postDataJSON(); calls.push({ path: url.pathname, query: url.search, body });
      if (url.pathname === "/v1/me/reviewer") {
        if (route.request().method() === "PATCH") {
          if (body.leaderboardOptIn) return route.fulfill({ status: 503, json: { message: "Synthetic save interruption" } });
          reviewer = { ...reviewer, ...body };
        }
        return route.fulfill({ json: reviewer });
      }
      if (url.pathname === "/v1/me/review-blocks") return route.fulfill({ json: { items: [{ id: "blocked", name: "Blocked Fixture", createdAt: null }] } });
      if (url.pathname === "/v1/me/reviews") {
        const section = url.searchParams.get("section"), cursor = url.searchParams.get("cursor"), tab = url.searchParams.get("tab");
        if (!section) return route.fulfill({ json: { asked: [card("needs-1"), card("waiting-1", "open", 0)], answered: [written("newest", 2)],
          askedNextCursor: null, answeredNextCursor: "written-next", counts: { needs: 2, waiting: 1, answered: 0, closed: 0, all: 3 } } });
        if (section === "answered") return route.fulfill({ json: { items: [written(cursor ? "written-older" : url.searchParams.get("sort") === "top" ? "most-upvoted" : "newest", 12)], nextCursor: cursor ? null : "written-next" } });
        if (cursor && options.failPage && !pageFailed) { pageFailed = true; return route.fulfill({ status: 503, json: { message: "Synthetic page interruption" } }); }
        return route.fulfill({ json: { items: tab === "needs" ? [card(cursor ? "needs-older" : "needs-1")] : tab === "waiting" ? [card("waiting-1", "open", 0)] : [], nextCursor: tab === "needs" && !cursor ? "asked-next" : null } });
      }
      return route.fulfill({ status: 404, json: { error: "fixture_not_found" } });
    }
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body class="${fonts} font-sans"><div id="root"></div><script src="/fixture.js"></script></body></html>` });
  });
  await page.goto(`https://my-reviews-fixture.local/reviews/mine${options.tab ? `?tab=${options.tab}` : ""}`);
  return calls;
}
