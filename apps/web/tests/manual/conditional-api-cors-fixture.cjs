/* Source-only proposal. Real HTTP, CORS, UserCache/UserRevision and client hooks.
 * Only Clerk, a two-row user collection and chart computation are synthetic. */
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");

const sha = value => createHash("sha256").update(value).digest("hex");
function ownedHttpServer(handler) {
  const server = http.createServer({ maxHeaderSize: 8 * 1024, requestTimeout: 5000,
    headersTimeout: 5000, keepAliveTimeout: 1000 }, handler);
  server.timeout = 5000; server.maxConnections = 16; server.maxRequestsPerSocket = 32;
  const sockets = new Set(), closing = new Set();
  server.on("connection", socket => {
    sockets.add(socket);
    let resolveClosed;
    const closed = new Promise(resolve => { resolveClosed = resolve; });
    closing.add(closed);
    socket.once("close", () => { sockets.delete(socket); closing.delete(closed); resolveClosed(); });
  });
  return { server, sockets, closing };
}
const listen = ({ server }) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    server.removeListener("error", reject);
    resolve(`http://127.0.0.1:${server.address().port}`);
  });
});
async function stop({ server, sockets, closing }) {
  if (server.listening) await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
  await Promise.all([...closing]);
  return { listening: server.listening, openSockets: sockets.size };
}

async function startConditionalApiCorsFixture(root = process.cwd()) {
  root = path.resolve(root);
  if (JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).name !== "@sc2tools/web") {
    throw new Error("Run the dedicated config from apps/web; no inferred import.meta paths.");
  }
  const webRequire = createRequire(path.join(root, "package.json"));
  const apiRoot = path.resolve(root, "../api"), apiRequire = createRequire(path.join(apiRoot, "package.json"));
  const express = apiRequire("express"), cors = apiRequire("cors");
  const { UserCache } = apiRequire(path.join(apiRoot, "src/middleware/userCache.js"));
  const { UserRevision } = apiRequire(path.join(apiRoot, "src/util/userRevision.js"));
  const rows = new Map(["owner-A", "owner-B"].map(userId => [userId, { userId, clerkUserId: userId, dataRev: 0 }]));
  const users = {
    async findOne({ userId }) { return structuredClone(rows.get(userId) || null); },
    async findOneAndUpdate({ userId }) {
      const row = rows.get(userId); if (!row) return null;
      row.dataRev += 1; return structuredClone(row);
    },
  };
  const revisions = new UserRevision(users, { enabled: true });
  const cache = new UserCache(revisions, { enabled: true }); // Production limits unchanged.
  const calls = [], computes = [], overflow = { calls: false, computes: false };
  const record = (target, value, name) => {
    if (target.length < 512) target.push(value); else overflow[name] = true;
  };
  let faults = [], script = "", css = "", browserOrigin = "", apiOrigin = "";
  const cssRoot = path.join(root, ".next/static/css");
  const cssPaths = (await fs.readdir(cssRoot, { recursive: true })).filter(name => name.endsWith(".css")).sort();
  if (!cssPaths.length) throw new Error("An owned production build with CSS is required; fixture does not generate one.");
  const cssFiles = [];
  for (const name of cssPaths) {
    const body = await fs.readFile(path.join(cssRoot, name));
    css += body.toString("utf8") + "\n"; cssFiles.push({ path: name, bytes: body.length, sha256: sha(body) });
  }
  const buildId = (await fs.readFile(path.join(root, ".next/BUILD_ID"), "utf8")).trim();
  const fontClasses = [...css.matchAll(/\.(__variable_[a-z0-9]+)\{/g)].map(match => match[1]).join(" ");
  const app = express(); app.disable("etag");
  // Observe real server delivery, without replacing browser fetch or HTTP transport.
  app.use((req, res, next) => {
    const chunks = [], originalEnd = res.end.bind(res);
    res.end = (chunk, ...args) => {
      if (chunk !== undefined && chunk !== null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof args[0] === "string" ? args[0] : undefined));
      return originalEnd(chunk, ...args);
    };
    res.once("finish", () => record(calls, {
      method: req.method, url: req.originalUrl, origin: req.headers.origin || null,
      authorization: req.headers.authorization || null, ifNoneMatch: req.headers["if-none-match"] || null,
      requestedHeaders: req.headers["access-control-request-headers"] || null,
      status: res.statusCode, etag: res.getHeader("ETag") || null,
      allowOrigin: res.getHeader("Access-Control-Allow-Origin") || null,
      allowHeaders: res.getHeader("Access-Control-Allow-Headers") || null,
      exposeHeaders: res.getHeader("Access-Control-Expose-Headers") || null,
      cacheControl: res.getHeader("Cache-Control") || null,
      vary: res.getHeader("Vary") || null, contentType: res.getHeader("Content-Type") || null,
      contentLength: res.getHeader("Content-Length") ?? null,
      body: Buffer.concat(chunks).toString("utf8"),
    }, "calls"));
    next();
  });
  app.use(cors({
    origin: (origin, done) => done(null, origin === browserOrigin ? browserOrigin : false),
    maxAge: 0, credentials: false,
    exposedHeaders: ["Retry-After", "X-Export-Truncated", "Content-Disposition", "ETag"],
  }));
  app.get("/v1/timeseries", async (req, res, next) => {
    const owner = ["owner-A", "owner-B"].find(value => req.headers.authorization === `Bearer etag-browser-${value}`);
    if (!owner) return res.status(401).json({ error: { code: "auth_required", message: "Synthetic sign-in required." } });
    if (req.headers.origin !== browserOrigin) return res.status(403).json({ error: { code: "forbidden", message: "Unapproved fixture origin." } });
    const map = typeof req.query.map === "string" ? req.query.map : "Old";
    if (!["Old", "New", "HeaderProbe"].includes(map)) return res.status(400).json({ error: "invalid_fixture_map" });
    const fault = map !== "HeaderProbe" ? faults.shift() : undefined;
    if (fault === "wrong304") {
      // Deliberate protocol fault ONLY: normal packets use the actual responder.
      return res.set("ETag", `W/"uc1-${"0".repeat(64)}"`).set("Cache-Control", "private, no-cache")
        .vary("Authorization").status(304).end();
    }
    try {
      return await cache.send(req, res, owner, "timeseries", { map }, { bucket: "day" }, async () => {
        const row = rows.get(owner);
        const value = { owner, map, revision: row.dataRev, points: [{ day: "2026-10-27", games: row.dataRev + (map === "Old" ? 2 : 4) }] };
        record(computes, structuredClone(value), "computes"); return value;
      });
    } catch (error) { return next(error); }
  });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: { code: error.code || "fixture_failed", message: error.message } }));
  app.use((_req, res) => res.status(404).json({ error: "fixture_route_not_found" }));
  const apiServer = ownedHttpServer(app);
  const browserServer = ownedHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url, browserOrigin || "http://127.0.0.1");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src ${apiOrigin}; base-uri 'none'; form-action 'none'`);
      if (url.pathname === "/fixture.js") return res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }).end(script);
      if (url.pathname === "/fixture.css") return res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" }).end(css);
      if (/^\/_next\/static\/media\/[a-zA-Z0-9._-]+\.(woff2?|ttf|otf)$/.test(url.pathname)) {
        const body = await fs.readFile(path.join(root, ".next/static/media", path.basename(url.pathname)));
        return res.writeHead(200, { "Content-Type": url.pathname.endsWith("woff2") ? "font/woff2" : "font/woff" }).end(body);
      }
      if (url.pathname !== "/") return res.writeHead(404).end();
      return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>body{margin:0}main{max-width:72rem;margin:auto;padding:16px;min-width:0}fieldset{display:flex;flex-wrap:wrap;gap:12px;margin:12px 0;padding:12px}button,select{min-height:44px;max-width:100%;padding:8px}pre,output{display:block;white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%}section{min-width:0}</style></head><body class="${fontClasses} font-sans"><div id="root"></div><script src="/fixture.js"></script></body></html>`);
    } catch (error) { res.writeHead(500).end(String(error)); }
  });
  try {
    browserOrigin = await listen(browserServer); apiOrigin = await listen(apiServer);
    const entry = `
      import React from "react"; import {createRoot} from "react-dom/client";
      import {SWRConfig} from "swr"; import {useAuth} from "@clerk/nextjs";
      import {useApi} from "@/lib/clientApi"; import {ConditionalApiProvider} from "@/lib/conditionalApiScope";
      window.etagFixtureOwner="owner-A"; window.etagFixtureCommits=[]; window.etagFixtureCommitOverflow=false;
      const swrCache=new Map();
      function Probe(){
        const auth=useAuth(),[map,setMap]=React.useState("Old"),[revision,setRevision]=React.useState(1),[ready,setReady]=React.useState(false);
        const path="/v1/timeseries?map="+map+"#rev="+revision;
        const query=useApi(path); const refresh=()=>query.mutate().catch(()=>undefined);
        React.useLayoutEffect(()=>{if(window.etagFixtureCommits.length<512)window.etagFixtureCommits.push({owner:auth.userId,dataOwner:query.data?.owner??null,path});else window.etagFixtureCommitOverflow=true;});
        const changeOwner=owner=>{window.etagFixtureOwner=owner;dispatchEvent(new Event("etag-fixture-auth"));};
        return <main><h1>Conditional chart HTTP fixture</h1><fieldset><legend>Fixture controls</legend>
          <button onClick={()=>changeOwner("owner-A")}>Use owner A</button><button onClick={()=>changeOwner("owner-B")}>Use owner B</button>
          <label>Map <select value={map} onChange={event=>setMap(event.target.value)}><option>Old</option><option>New</option></select></label>
          <button onClick={()=>setRevision(value=>value+1)}>Advance local revision</button>
          <button disabled={query.isValidating} onClick={refresh}>Refresh chart</button>
          <button onClick={async()=>{await import("@/lib/conditionalApiResponses");await Promise.resolve();setReady(true);}}>Confirm enhancement ready</button>
        </fieldset><output aria-label="Enhancement state">{ready?"ready":"not confirmed"}</output>
        <output aria-label="Current owner">{auth.userId}</output><output aria-label="Resource identity">{path}</output>
        <output aria-label="Request state">{query.isValidating?"loading":"idle"}</output>
        <section aria-label="Rendered chart DTO"><pre>{query.data?JSON.stringify(query.data):"No chart data"}</pre></section>
        {query.error?<section role="alert"><p>{query.error.message}</p><output aria-label="Error code">{query.error.code}</output><button onClick={refresh}>Retry</button></section>:null}
        </main>;
      }
      function Fixture(){const {userId}=useAuth();return <React.StrictMode><ConditionalApiProvider owner={userId}>
        <SWRConfig value={{provider:()=>swrCache,dedupingInterval:0,shouldRetryOnError:false,errorRetryCount:0,revalidateOnFocus:false,revalidateOnReconnect:false,keepPreviousData:true}}><Probe/></SWRConfig>
      </ConditionalApiProvider></React.StrictMode>;}
      createRoot(document.getElementById("root")).render(<Fixture/>);
    `;
    const result = await webRequire("esbuild").build({
      stdin: { contents: entry, loader: "tsx", sourcefile: "conditional-api-cors-fixture.tsx", resolveDir: root },
      bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", minify: true,
      tsconfig: path.join(root, "tsconfig.json"), alias: { "@": root },
      define: { "process.env": "{}", "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_BASE": JSON.stringify(apiOrigin) },
      plugins: [{ name: "synthetic-clerk-only", setup(builder) {
        builder.onResolve({ filter: /^@clerk\/nextjs$/ }, args => ({ path: args.path, namespace: "synthetic-auth" }));
        builder.onLoad({ filter: /.*/, namespace: "synthetic-auth" }, () => ({ loader: "js", resolveDir: root, contents: `
          import {useSyncExternalStore} from "react";
          const subscribe=fn=>{addEventListener("etag-fixture-auth",fn);return()=>removeEventListener("etag-fixture-auth",fn)};
          const getToken=async()=>"etag-browser-"+window.etagFixtureOwner;
          export function useAuth(){const userId=useSyncExternalStore(subscribe,()=>window.etagFixtureOwner,()=>"owner-A");return{userId,isLoaded:true,isSignedIn:true,getToken};}
        ` }));
      } }], logLevel: "warning",
    });
    script = result.outputFiles[0].text;
  } catch (error) {
    await Promise.allSettled([stop(browserServer), stop(apiServer)]); throw error;
  }
  return {
    browserOrigin, apiOrigin, calls, computes, overflow,
    buildEvidence: { buildId, cssFiles, browserBundleSha256: sha(script) },
    reads: () => calls.filter(call => call.method === "GET" && call.url.startsWith("/v1/timeseries?") && !call.url.includes("HeaderProbe")),
    protocolFaults: count => {
      if (count !== 1 && count !== 2) throw new Error("Only one or two deliberate304 faults are supported.");
      faults = Array(count).fill("wrong304");
    },
    bumpOwner: owner => {
      if (!rows.has(owner)) throw new Error("Unknown synthetic owner.");
      return revisions.run(owner, async () => undefined);
    },
    counters: () => cache.counters,
    async close() {
      const [browser, api] = await Promise.all([stop(browserServer), stop(apiServer)]);
      return { browser, api };
    },
  };
}
module.exports = { startConditionalApiCorsFixture };
