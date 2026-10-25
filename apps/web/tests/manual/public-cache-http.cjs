/* Local production HTTP proof. Run after next build from apps/web:
 * node tests/manual/public-cache-http.cjs --baseline
 * node tests/manual/public-cache-http.cjs
 * Only synthetic API fixtures and loopback Next are used. No browser, auth
 * provider, account mutation, production purge or external request is made. */
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const web = path.resolve(__dirname, "../..");
const baseline = process.argv.includes("--baseline");
// Parent owns this already-built, exact-main app. Baseline mode only starts
// its server; it never edits/builds/stages anything in that checkout.
const appWeb = baseline ? (process.env.PUBLIC_CACHE_BASELINE_WEB || "C:/SC2TOOLS/.worktrees/wave3-coaching-forms/apps/web") : web;
const baselineFile = path.resolve(web, "../../.cache/public-cache-baseline-http.json");
const baselineContract = baseline ? {} : JSON.parse(fs.readFileSync(baselineFile, "utf8"));
const { buildCommunityRevalidator } = require(path.join(web, "../api/src/services/communityRevalidate"));
const { signGuideRevalidation } = require(path.join(web, "../api/src/services/guideRevalidate"));
const origin = "http://127.0.0.1:3210", secret = "local-cache-proof-only";
const state = { contributors: 6, removed: false, version: 1, buildMode: "ok", statsMode: "ok" };
const reads = { opponent: 0, build: 0, stats: 0, failedPurges: 0 };
const apiStatus = { opponent: 0, build: 0 };
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
function verifyNotFound(response, html, name, oldContent) {
  const current = { status: response.status, fallback404: html.includes("NEXT_HTTP_ERROR_FALLBACK;404"),
    noindex: html.includes("noindex"), noOldContent: !html.includes(oldContent) };
  if (baseline) baselineContract[name] = current;
  else check(current.status === baselineContract[name].status, `${name} matches exact-main streamed HTTP status`);
  check(current.fallback404 && current.noindex && current.noOldContent, `${name} has404 fallback/noindex and no prior content`);
}
const json = (res, status, value) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "private, no-store" }); res.end(JSON.stringify(value)); };
const api = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname === "/__fixture/purge-failure") { reads.failedPurges++; return json(res, 503, { error: "synthetic_unavailable" }); }
  if (pathname === "/v1/community/opponents/cache-proof-opponent") {
    reads.opponent++;
    apiStatus.opponent = state.removed || state.contributors < 5 ? 404 : 200;
    return apiStatus.opponent === 404 ? json(res, 404, { error: "not_found" }) : json(res, 200, {
      pulseId: "cache-proof-opponent", pulseCharacterId: "123456", race: "Zerg", contributors: state.contributors,
      games: 20, wins: 12, losses: 8, winRate: 60, strategies: { "Zerg - Roach Ravager": 12 }, byMap: { "Synthetic Station": { wins: 12, losses: 8 } },
    });
  }
  if (pathname === "/v1/community/builds/cache-proof-build") {
    reads.build++;
    apiStatus.build = state.buildMode === "ok" ? 200 : state.buildMode === "missing" ? 404 : 503;
    if (state.buildMode !== "ok") return json(res, apiStatus.build, { error: state.buildMode });
    return json(res, 200, { slug: "cache-proof-build", title: `Cache proof opening ${state.version}`, matchup: "PvZ", votes: 3,
      authorName: "SyntheticBuilder", ownerUserId: "cache-proof-author", publishedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-10-25T00:00:00Z",
      description: "Synthetic local public cache proof.", build: { race: "Protoss", vsRace: "Zerg", perspective: "you", rules: [{ type: "before", name: "BuildGateway", time_lt: 60 }] } });
  }
  if (pathname === "/v1/site/stats") {
    reads.stats++;
    return json(res, state.statsMode === "ok" ? 200 : 503, state.statsMode === "ok" ? {
      agentDownloads: reads.stats, activeAgents: 5, activeUsers: 7, generatedAt: "2026-10-25T00:00:00Z", activityWindowSeconds: 60,
    } : { error: "synthetic_unavailable" });
  }
  return json(res, 503, { error: "fixture_route_not_available" });
});
const get = (route, headers = {}) => fetch(origin + route, { headers, signal: AbortSignal.timeout(15_000), redirect: "manual" });
const post = (raw, signature) => fetch(origin + "/api/revalidate-community", { method: "POST", body: raw,
  headers: { "content-type": "application/json", ...(signature ? { "x-sc2tools-signature": signature } : {}) }, signal: AbortSignal.timeout(10_000) });
const logPath = path.resolve(web, `../../.cache/public-cache-${baseline ? "baseline-" : ""}next-http.log`);
fs.mkdirSync(path.dirname(logPath), { recursive: true });
const log = fs.createWriteStream(logPath);
let next;
async function stopNext() {
  if (!next || next.exitCode !== null) return;
  const stopped = new Promise(resolve => next.once("exit", resolve));
  next.kill(); await Promise.race([stopped, delay(5_000)]);
}
async function startNext(configured = true) {
  next = spawn(process.execPath, [path.join(appWeb, "node_modules/next/dist/bin/next"), "start", "-p", "3210"], { cwd: appWeb, windowsHide: true,
    env: { ...process.env, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_Y2xlcmsuZXhhbXBsZS5jb20k", CLERK_SECRET_KEY: "sk_live_dummy",
      NEXT_PUBLIC_API_BASE: "http://localhost:8080", SC2TOOLS_API_BASE: "http://localhost:8080", COMMUNITY_REVALIDATE_SECRET: configured ? secret : "" } });
  next.stdout.pipe(log); next.stderr.pipe(log);
  let ready = false;
  for (let i = 0; i < 100; i++) { try { ready = (await get("/api/site/stats")).ok; } catch { /* Starting. */ } if (ready) break; await delay(200); }
  check(ready, "local production Next is ready");
}
async function purge() {
  const sender = buildCommunityRevalidator({ url: origin + "/api/revalidate-community", secret });
  sender.notify(); await sender.flush();
}
async function main() {
  await new Promise((resolve, reject) => { api.once("error", reject); api.listen(8080, resolve); });
  await startNext();
  if (!baseline) await purge();
  if (baseline) {
    let response = await get("/community/opponents/cache-proof-opponent"), html = await response.text();
    check(response.status === 200 && html.includes("Combined from 6 SC2 Tools players"), "baseline opponent initially succeeds");
    state.contributors = 4;
    response = await get("/community/opponents/cache-proof-opponent"); html = await response.text();
    check(apiStatus.opponent === 404, "baseline below-floor API read is404");
    verifyNotFound(response, html, "floor", "Combined from 6 SC2 Tools players");
    state.contributors = 6; state.removed = true;
    response = await get("/community/opponents/cache-proof-opponent"); html = await response.text();
    check(apiStatus.opponent === 404, "baseline removed API read is404");
    verifyNotFound(response, html, "removed", "Combined from 6 SC2 Tools players");
    response = await get("/community/builds/cache-proof-build"); html = await response.text();
    check(response.status === 200 && html.includes("Cache proof opening 1"), "baseline build initially succeeds");
    state.buildMode = "missing";
    response = await get("/community/builds/cache-proof-build"); html = await response.text();
    check(apiStatus.build === 404, "baseline missing build API read is404");
    verifyNotFound(response, html, "missingBuild", "Cache proof opening 1");
    fs.writeFileSync(baselineFile, JSON.stringify(baselineContract, null, 2));
    console.log(JSON.stringify({ baseline: true, checks, baselineContract })); return;
  }
  check((await post("{}")).status === 401, "unsigned purge rejected");
  const ts = Date.now(), wrong = JSON.stringify({ ts, scope: "guides" });
  check((await post(wrong, signGuideRevalidation(secret, ts, wrong))).status === 400, "wrong signed scope rejected");
  check((await post("x".repeat(4097))).status === 413, "oversized purge rejected");

  const opponent = "/community/opponents/cache-proof-opponent";
  let response = await get(opponent), html = await response.text();
  check(response.status === 200 && html.includes("Combined from 6 SC2 Tools players"), "warm opponent succeeds");
  check((response.headers.get("cache-control") || "").includes("no-store"), "opponent rendered response is no-store");
  const warmReads = reads.opponent;
  response = await get(opponent); await response.text();
  check(reads.opponent > warmReads, "warm opponent still reaches API admission");
  state.contributors = 4;
  const failed = buildCommunityRevalidator({ url: "http://localhost:8080/__fixture/purge-failure", secret });
  failed.notify(); await failed.flush();
  check(reads.failedPurges === 1, "real sender encounters synthetic delivery failure");
  response = await get(opponent); html = await response.text();
  check(apiStatus.opponent === 404, "failed purge still reaches current below-floor API404");
  verifyNotFound(response, html, "floor", "Combined from 6 SC2 Tools players");
  state.contributors = 6; state.removed = true;
  response = await get(opponent); html = await response.text();
  check(apiStatus.opponent === 404, "removed opponent reaches current API404");
  verifyNotFound(response, html, "removed", "Combined from 6 SC2 Tools players");
  state.removed = false;
  check((await get(opponent)).status === 200, "eligible opponent recovers without purge");

  const build = "/community/builds/cache-proof-build";
  response = await get(build); html = await response.text();
  check(response.status === 200 && html.includes("Cache proof opening 1"), "public build initially renders");
  const buildReads = reads.build; state.version = 2;
  response = await get(build); html = await response.text();
  check(html.includes("Cache proof opening 1") && reads.build === buildReads, "configured data tag caches public build");
  await purge();
  response = await get(build); html = await response.text();
  check(response.status === 200 && html.includes("Cache proof opening 2") && reads.build > buildReads, "signed tag purge refreshes actual public build");
  // Advance only this synthetic fetch entry's age, not the server clock or any
  // real data. Restart clears Next's memory copy so its real disk TTL is read.
  state.buildMode = "error"; await stopNext();
  const cacheDir = path.join(web, ".next/cache/fetch-cache"); let aged = false;
  for (const name of fs.readdirSync(cacheDir)) {
    const file = path.join(cacheDir, name); if (!fs.statSync(file).isFile()) continue;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value.data?.url !== "http://localhost:8080/v1/community/builds/cache-proof-build") continue;
    fs.utimesSync(file, new Date(), new Date(Date.now() - 301_000)); aged = true;
  }
  check(aged, "only synthetic successful cache entry is aged past300 seconds");
  const beforeOutage = reads.build; await startNext();
  response = await get(build); html = await response.text();
  check(response.status === 200 && html.includes("Cache proof opening 2"), "expired public data still renders last good content during outage");
  await delay(300);
  response = await get(build); html = await response.text();
  check(reads.build > beforeOutage && response.status === 200 && html.includes("Cache proof opening 2"), "failed background refresh retains last good public data");
  state.buildMode = "missing"; await purge();
  response = await get(build); html = await response.text();
  check(apiStatus.build === 404, "confirmed missing build reaches current API404 after purge");
  verifyNotFound(response, html, "missingBuild", "Cache proof opening 2");

  response = await get("/api/site/stats"); const firstStats = await response.json();
  check(response.headers.get("cache-control") === "public, s-maxage=15, stale-while-revalidate=60", "site proxy sends 15/60 header");
  response = await get("/api/site/stats"); const secondStats = await response.json();
  check(secondStats.agentDownloads > firstStats.agentDownloads, "proxy upstream itself stays uncached");
  state.statsMode = "error"; response = await get("/api/site/stats"); await response.text();
  check(response.status === 503 && (response.headers.get("cache-control") || "").includes("no-store"), "proxy outage is uncached 503");

  // The same compiled app must also fail closed without runtime purge config,
  // including with previously warm configured fetch-cache artifacts on disk.
  state.statsMode = "ok"; state.buildMode = "ok"; state.version = 3;
  await stopNext(); await startNext(false);
  check((await post("{}")).status === 503, "unset receiver secret returns503");
  response = await get(build); html = await response.text(); const uncachedReads = reads.build;
  check(response.status === 200 && html.includes("Cache proof opening 3") && (response.headers.get("cache-control") || "").includes("no-store"), "unset secret bypasses warm configured data");
  state.version = 4; response = await get(build); html = await response.text();
  check(reads.build > uncachedReads && html.includes("Cache proof opening 4"), "unset secret reads current public data on every request");
  response = await get(build + "/opengraph-image"); await response.arrayBuffer();
  check(response.status === 200 && (response.headers.get("cache-control") || "").includes("no-store"), "unset secret leaves actual user-derived PNG uncached");
  console.log(JSON.stringify({ checks, reads, baselineContract, fixtures: "synthetic loopback HTTP only; no browser/account mutation" }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await stopNext(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); log.end();
});
