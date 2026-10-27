import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createServer } from "node:https";
import path from "node:path";

const ORIGIN = "https://review-lifecycle-fixture.local";
const ID = "fixtureReview001";
const NOW = "2026-10-27T12:00:00.000Z";
const DOWNLOAD_NAME = `sc2tools-review-${ID}.SC2Replay`;
const DOWNLOAD_BODY = "SC2TOOLS_SYNTHETIC_REVIEW_FIXTURE_NO_GAME_DATA\n";
let downloadServer, downloadOrigin = "", activeDownload;
const downloadSockets = new Set(), downloadServerRequests = [], downloadServerErrors = [], downloadServerRejected = [];
const appendBounded = (ledger, value) => { if (ledger.length < 32) ledger.push(value); };

// Chromium's anchor[download] requests can have no CDP networkId and bypass
// both page/context routing. Serve only the synthetic attachment over real TLS.
async function startReviewDownloadServer() {
  if (downloadServer) return;
  const [cert, key] = await Promise.all([
    readFile(path.join(process.cwd(), "tests/e2e/fixtures/review-tls/local-test-only-cert.pem")),
    readFile(path.join(process.cwd(), "tests/e2e/fixtures/review-tls/local-test-only-key.pem")),
  ]);
  const current = createServer({ cert, key, minVersion: "TLSv1.2", handshakeTimeout: 5_000, maxHeaderSize: 8_192 }, (request, response) => {
    const expectedHost = downloadOrigin ? new URL(downloadOrigin).host : "";
    const allowed = activeDownload && request.method === "GET" && request.headers.host === expectedHost &&
      ["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "") &&
      request.url === activeDownload.path && !request.headers["transfer-encoding"] &&
      (!request.headers["content-length"] || request.headers["content-length"] === "0") && activeDownload.allowed();
    if (!allowed) {
      appendBounded(downloadServerRejected, { method: request.method, path: request.url });
      response.writeHead(403, { connection: "close", "content-length": "0" }); response.end(); request.resume(); return;
    }
    const entry = { method: request.method, path: request.url, filename: DOWNLOAD_NAME, bytes: Buffer.byteLength(DOWNLOAD_BODY), status: 200 };
    appendBounded(downloadServerRequests, entry); activeDownload.record(entry);
    response.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${DOWNLOAD_NAME}"`,
      "content-length": Buffer.byteLength(DOWNLOAD_BODY), "cache-control": "no-store", "x-content-type-options": "nosniff", connection: "close" });
    response.end(DOWNLOAD_BODY);
  });
  current.maxConnections = 4; current.maxRequestsPerSocket = 2;
  current.headersTimeout = 5_000; current.requestTimeout = 5_000; current.keepAliveTimeout = 1_000;
  current.on("connection", socket => { downloadSockets.add(socket); socket.setTimeout(5_000, () => socket.destroy()); socket.once("close", () => downloadSockets.delete(socket)); });
  current.on("tlsClientError", error => appendBounded(downloadServerErrors, String(error)));
  current.on("clientError", (error, socket) => { appendBounded(downloadServerErrors, String(error)); socket.destroy(); });
  current.on("error", error => appendBounded(downloadServerErrors, String(error)));
  await new Promise((resolve, reject) => {
    current.once("error", reject);
    current.listen(0, "127.0.0.1", () => { current.removeListener("error", reject); resolve(); });
  }).catch(error => { current.close(); throw error; });
  downloadServer = current; downloadOrigin = `https://127.0.0.1:${current.address().port}`; current.unref();
}

export async function closeReviewLifecycleDownloadServer() {
  const current = downloadServer, origin = downloadOrigin; activeDownload = null; downloadServer = null;
  if (current) await new Promise(resolve => { current.close(resolve); current.closeAllConnections(); for (const socket of downloadSockets) socket.destroy(); });
  downloadOrigin = "";
  return { closed: true, listening: current?.listening ?? false, openSockets: downloadSockets.size, origin,
    requests: downloadServerRequests.splice(0), errors: downloadServerErrors.splice(0), rejected: downloadServerRejected.splice(0), activeDownload: Boolean(activeDownload) };
}
let bundled;
function script() {
  return bundled ??= build({
    stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
      import React,{useSyncExternalStore} from "react";import{createRoot}from"react-dom/client";
      import{SWRConfig}from"swr";import{useAuth}from"@clerk/nextjs";
      import{AskForReviewButton}from"@/components/reviews/AskForReviewButton";
      import{ReviewPage}from"@/components/reviews/ReviewPage";
      const subscribe=fn=>{addEventListener("popstate",fn);return()=>removeEventListener("popstate",fn)};
      const cache=new Map();const swr={dedupingInterval:0,shouldRetryOnError:false,revalidateOnFocus:false,provider:()=>cache};
      function Fixture(){const current=useSyncExternalStore(subscribe,()=>location.pathname);const auth=useAuth();
        return <SWRConfig value={swr}>
          <main className="mx-auto w-full max-w-[1680px] flex-1 px-4 pb-24 pt-5 sm:px-6 md:pb-10 lg:px-8"><aside aria-label="Synthetic fixture session" className="mb-4 flex flex-wrap gap-2">
            <p className="w-full text-caption text-text-muted">Synthetic local review lifecycle. No real accounts or public posts.</p>
            {["asker","reviewer","new-reviewer","signed-out"].map(id=><button type="button" key={id} className="min-h-11 rounded border border-border px-3" onClick={()=>window.reviewFixtureSession.set(id)}>Use {id}</button>)}
            <span data-testid="fixture-owner">{auth.userId??"signed-out"}</span>
          </aside>{current.startsWith("/reviews/")?<ReviewPage initial={window.reviewFixtureInitial}/>:<AskForReviewButton gameId="private-fixture-game" durationSec={640} matchup="PvZ"/>}</main>
        </SWRConfig>}
      createRoot(document.getElementById("root")).render(<Fixture/>);
    ` },
    bundle: true, write: false, minify: true, format: "iife", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
    define: { "process.env": "{}", "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_REVIEWS_ENABLED": '"on"', "process.env.NEXT_PUBLIC_API_BASE": JSON.stringify(ORIGIN) },
    plugins: [{ name: "synthetic-session-navigation-boundary", setup(builder) {
      builder.onResolve({ filter: /^@clerk\/nextjs$|^next\/navigation$|^next\/dynamic$/ }, args => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ resolveDir: process.cwd(), contents: args.path === "@clerk/nextjs" ? `
        import{useSyncExternalStore}from"react";let user="asker";const listeners=new Set();
        const subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
        window.reviewFixtureSession={set:id=>{user=id;for(const fn of listeners)fn()}};
        export function useAuth(){const id=useSyncExternalStore(subscribe,()=>user);return{isLoaded:true,isSignedIn:id!=="signed-out",userId:id==="signed-out"?null:id,getToken:async()=>user==="signed-out"?null:"fixture-"+user}}
        export const SignedIn=({children})=>useAuth().isSignedIn?children:null;export const SignedOut=({children})=>useAuth().isSignedIn?null:children;
      ` : args.path === "next/navigation" ? `
        export const useRouter=()=>({push:path=>{history.pushState(null,"",path);dispatchEvent(new PopStateEvent("popstate"))},refresh(){}});
        export const usePathname=()=>location.pathname;export const useSearchParams=()=>new URLSearchParams(location.search);
        export const notFound=()=>{throw Error("Unexpected fixture notFound")};
      ` : `import React,{lazy,Suspense}from"react";export default function dynamic(loader,options={}){const Component=lazy(()=>loader().then(module=>({default:module.default??module})));return props=><Suspense fallback={options.loading?React.createElement(options.loading):null}><Component {...props}/></Suspense>}`,
        loader: "tsx" }));
    } }],
  }).then(result => result.outputFiles[0].text);
}

function initialRequest(question = "How should I defend this attack at the third base?") {
  return { id: ID, url: `/reviews/${ID}`, question, tags: [], timeRange: null, desiredLevel: "anyone", visibility: "public", status: "open", closedReason: null, hidden: false,
    asker: { label: "Anonymous Protoss", anonymous: true, band: null, mmr: null, isYou: false },
    game: { matchup: "PvZ", myRace: "Protoss", oppRace: "Zerg", map: "Fixture Station LE", result: "Loss", durationSec: 640, myBuild: null, oppStrategy: null, macroScore: 61, hasPlayback: false },
    opponent: { label: "Opponent (Zerg, ~4,100 MMR)", race: "Zerg", band: null, mmr: 4100 },
    stats: { reviewCount: 0, commentCount: 0, helpfulCount: 0, upvoteTotal: 0 }, bestCommentId: null, replay: { shared: false, optedIn: false, available: true }, createdAt: NOW, lastActivityAt: NOW };
}

/** Real components, real SWR/API hooks, synthetic session + intercepted in-memory API.
 * No provider/account/public writes, and no replacement composer/thread/replay component.
 * @param {import('@playwright/test').Page} page
 * @param {{failAfterComment?:boolean,failAfterClose?:boolean}} options
 */
export async function openReviewLifecycleFixture(page, options = {}) {
  await startReviewDownloadServer();
  const js = await script();
  const cssRoot = path.join(process.cwd(), ".next/static/css");
  const css = (await Promise.all((await readdir(cssRoot, { recursive: true })).filter(file => file.endsWith(".css")).map(file => readFile(path.join(cssRoot, file), "utf8")))).join("\n");
  const fonts = [...css.matchAll(/\.(__variable_[a-z0-9]+)\{/g)].map(match => match[1]).join(" ");
  const calls = [], downloads = [], external = [], unexpected = [];
  let request = null, comments = [], failRead = false, failedComment = false;
  const downloadPath = `/fixture-download/${DOWNLOAD_NAME}?token=${randomBytes(16).toString("hex")}`;
  const downloadUrl = `${downloadOrigin}${downloadPath}`, attachmentRequests = [];
  activeDownload = { path: downloadPath, allowed: () => Boolean(request?.replay.shared && request.status !== "closed"),
    record: entry => { attachmentRequests.push(entry); downloads.push({ filename: DOWNLOAD_NAME, body: DOWNLOAD_BODY }); } };
  const snapshot = (viewer = null) => {
    const r = request ?? initialRequest();
    const active = r.status === "open" || r.status === "answered";
    const signedIn = !!viewer;
    const isAsker = viewer === "asker";
    return { request: { ...r, replay: { shared: active && r.replay.shared, available: active && r.replay.shared && r.replay.available, ...(isAsker ? { optedIn: r.replay.optedIn } : {}) }, asker: { ...r.asker, isYou: isAsker }, stats: {
      reviewCount: comments.filter(comment => !comment.parentId && comment.owner !== "asker" && comment.state === "visible").length,
      commentCount: comments.length, helpfulCount: comments.filter(comment => comment.helpful).length,
      upvoteTotal: comments.reduce((total, comment) => total + comment.upvotes, 0) } },
      comments: comments.filter(comment => comment.state !== "deleted" || comments.some(reply => reply.parentId === comment.id)).map(({ owner, ...comment }) => ({ ...comment, mine: owner === viewer, canEdit: owner === viewer && comment.state === "visible" && Date.now() - Date.parse(comment.createdAt) <= 15 * 60_000, upvoted: viewer === "asker" && comment.upvotes > 0 })),
      viewer: { signedIn, isAsker, isAdmin: false, canComment: active && signedIn && viewer !== "new-reviewer", canReview: active && signedIn && !isAsker && viewer !== "new-reviewer", reason: !active ? "closed" : !signedIn ? "sign_in" : viewer === "new-reviewer" ? "min_games" : null, syncedGames: viewer === "new-reviewer" ? 2 : 30, requiredGames: 20 },
      seo: { indexable: false, answerCount: comments.length, acceptedAnswerId: r.bestCommentId, suggestedAnswerIds: [] } };
  };
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === downloadOrigin) {
      if (url.href === downloadUrl && route.request().method() === "GET") return route.continue();
      unexpected.push({ path: url.pathname, method: route.request().method() }); return route.abort();
    }
    if (url.origin !== ORIGIN) { external.push(route.request().url()); return route.abort(); }
    if (url.pathname === "/favicon.ico") return route.fulfill({ status: 204, body: "" });
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: js });
    if (url.pathname === "/fixture.css") return route.fulfill({ contentType: "text/css; charset=utf-8", body: css });
    if (url.pathname.startsWith("/_next/static/media/")) return route.fulfill({ contentType: "font/woff2", body: await readFile(path.join(process.cwd(), ".next/static/media", path.basename(url.pathname))) });
    const publicRoot = path.resolve(process.cwd(), "public"), asset = path.resolve(publicRoot, `.${url.pathname}`);
    if (asset.startsWith(publicRoot + path.sep) && /\.(png|webp|jpg|jpeg|svg)$/.test(asset)) {
      try { return await route.fulfill({ body: await readFile(asset) }); } catch { return route.fulfill({ status: 404, body: "" }); }
    }
    if (url.pathname.startsWith("/v1/")) {
      const method = route.request().method(), body = route.request().postDataJSON();
      const bearer = route.request().headers().authorization;
      const viewer = bearer === "Bearer fixture-asker" ? "asker" : bearer === "Bearer fixture-reviewer" ? "reviewer" : bearer === "Bearer fixture-new-reviewer" ? "new-reviewer" : null;
      calls.push({ path: url.pathname, method, body, viewer });
      const fail = (status, code, message) => route.fulfill({ status, json: { error: { code, message } } });
      if (method !== "GET" && !viewer) return fail(401, "auth_required", "Sign in on the website.");
      if (url.pathname === "/v1/reviews" && method === "POST") {
        if (request) return fail(409, "review_exists", "This game already has a request.");
        request = { ...initialRequest(body.question), tags: body.tags, timeRange: body.timeRange, desiredLevel: body.desiredLevel, visibility: body.visibility,
          replay: { shared: body.shareReplay, optedIn: body.shareReplay, available: true } };
        return route.fulfill({ json: { id: ID, url: `/reviews/${ID}` } });
      }
      if (url.pathname === `/v1/reviews/${ID}` && method === "GET") {
        if (failRead) { failRead = false; return fail(503, "fixture_refresh_failure", "Synthetic thread refresh interruption."); }
        return route.fulfill({ json: snapshot(viewer) });
      }
      if (url.pathname === `/v1/reviews/${ID}/analysis` && method === "GET") {
        if (request?.status === "closed") return fail(410, "review_closed", "The replay is no longer shared.");
        return route.fulfill({ json: { requestId: ID, game: { ...initialRequest().game, askerLabel: "Anonymous Protoss", opponentLabel: "Opponent" }, macroBreakdown: null, buildOrder: null, playback: { mode: "none" } } });
      }
      if (url.pathname === `/v1/reviews/${ID}/replay` && method === "GET") {
        if (!viewer) return fail(401, "auth_required", "Sign in to download the replay.");
        if (!request?.replay.shared || request.status === "closed") return fail(410, "replay_unavailable", "Replay sharing is off or the request is closed.");
        return route.fulfill({ json: { url: downloadUrl, filename: DOWNLOAD_NAME, expiresIn: 60 } });
      }
      if (url.pathname === `/v1/reviews/${ID}/comments` && method === "POST") {
        if (!request || request.status === "closed") return fail(410, "review_closed", "Comments are closed.");
        if (viewer === "new-reviewer") return fail(403, "min_games", "Sync 20 games before reviewing.");
        const id = `fixtureComment${String(comments.length + 1).padStart(2, "0")}`;
        comments.push({ id, owner: viewer, parentId: body.parentId, state: "visible", author: { label: viewer === "asker" ? "Anonymous Protoss" : "Fixture Reviewer", isAsker: viewer === "asker", profileHref: null, verified: null, badges: [], flair: null },
          body: body.body, gameTimeSec: body.gameTimeSec, endTimeSec: body.endTimeSec, mapPoint: body.mapPoint, upvotes: 0, helpful: false, best: false, createdAt: new Date().toISOString(), editedAt: null });
        if (options.failAfterComment && !failedComment) { failedComment = true; failRead = true; }
        return route.fulfill({ json: { id } });
      }
      if (url.pathname === `/v1/reviews/${ID}/close` && method === "POST") {
        if (viewer !== "asker") return fail(403, "not_asker", "Only the asker can close this request.");
        request = { ...request, status: "closed", closedReason: "asker" }; failRead = !!options.failAfterClose;
        return route.fulfill({ json: { ok: true } });
      }
      if (url.pathname === `/v1/reviews/${ID}/replay-sharing` && method === "POST") {
        if (viewer !== "asker") return fail(403, "not_asker", "Only the asker can change sharing.");
        request.replay = { shared: body.value, optedIn: body.value, available: true }; return route.fulfill({ json: { ok: true } });
      }
      const action = url.pathname.match(new RegExp(`^/v1/reviews/${ID}/comments/([^/]+)(?:/(helpful|best|upvote))?$`));
      if (action) {
        const comment = comments.find(value => value.id === action[1]); if (!comment) return fail(404, "not_found", "Comment not found.");
        if (method === "PATCH" || method === "DELETE") {
          if (comment.owner !== viewer) return fail(403, "not_author", "Only the author can edit this comment.");
          if (method === "PATCH") { comment.body = body.body; comment.editedAt = new Date().toISOString(); }
          else { comment.body = ""; comment.state = "deleted"; comment.gameTimeSec = null; comment.endTimeSec = null; comment.mapPoint = null; }
          return route.fulfill({ json: { ok: true } });
        }
        if (method === "POST" && action[2]) {
          if (action[2] !== "upvote" && viewer !== "asker") return fail(403, "not_asker", "Only the asker can mark reviews.");
          if (action[2] === "best") { comments.forEach(value => { value.best = value === comment && body.value; }); request.bestCommentId = body.value ? comment.id : null; request.status = body.value ? "answered" : "open"; }
          else if (action[2] === "helpful") comment.helpful = body.value;
          else comment.upvotes = body.value ? 1 : 0;
          return route.fulfill({ json: { ok: true } });
        }
      }
      unexpected.push({ path: url.pathname, method }); return fail(404, "unexpected_fixture_path", "Unexpected fixture path.");
    }
    if (route.request().resourceType() !== "document" || !["/fixture", `/reviews/${ID}`].includes(url.pathname)) { unexpected.push({ path: url.pathname, method: route.request().method() }); return route.fulfill({ status: 404, body: "" }); }
    const initial = JSON.stringify(snapshot()).replaceAll("<", "\\u003c");
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body class="${fonts} font-sans"><div id="root"></div><script>window.reviewFixtureInitial=${initial}</script><script src="/fixture.js"></script></body></html>` });
  });
  await page.goto(`${ORIGIN}/fixture`);
  return { calls, downloads, downloadUrl, attachmentRequests, external, unexpected, state: () => snapshot("asker") };
}
