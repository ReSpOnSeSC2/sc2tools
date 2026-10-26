import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const ORIGIN = "https://platform-disconnect-fixture.local";
const API_PATH = "/v1/me/integrations";
const SOURCE = `import React,{useLayoutEffect,useState} from "react";
import {createRoot} from "react-dom/client";import {SWRConfig,useSWRConfig} from "swr";
import {useAuth,setFixtureOwner,holdNextFixtureToken,releaseFixtureTokens,fixtureTokenState} from "@clerk/nextjs";
import {OfficialPlatformConnections} from "@/components/analyzer/settings/OfficialPlatformConnections";
import {Modal} from "@/components/ui/Modal";import {Button} from "@/components/ui/Button";
import {ToastProvider} from "@/components/ui/Toast";
function Harness(){const auth=useAuth(),{mutate}=useSWRConfig();const [mounted,setMounted]=useState(true),[later,setLater]=useState(false);
useLayoutEffect(()=>{window.platformDisconnectFixture={setOwner:setFixtureOwner,setMounted,holdNextToken:holdNextFixtureToken,
releaseTokens:releaseFixtureTokens,pendingTokens:()=>fixtureTokenState.pending.length,
refresh:()=>mutate(["authenticated-api",auth.userId,"/v1/me/integrations"]),openLaterDialog:()=>setLater(true)};},[auth.userId,mutate]);
return <main className="mx-auto max-w-4xl space-y-4 p-4"><h1 className="text-h2">Platform disconnect fixture</h1>
<p className="text-caption text-text-muted">Synthetic account permissions. Provider actions are unavailable in this fixture.</p>
<output aria-label="Fixture account">{auth.userId||"No account"}</output>
{mounted?<OfficialPlatformConnections/>:<p role="status">Connection view unmounted</p>}
<Modal open={later} onClose={()=>setLater(false)} title="Later local dialog"><p>Local focus and scroll-lock boundary.</p>
<Button onClick={()=>setLater(false)}>Close later dialog</Button></Modal></main>;}
const cache=new Map();createRoot(document.getElementById("root")).render(<SWRConfig value={{provider:()=>cache,
dedupingInterval:0,revalidateOnFocus:false,revalidateOnReconnect:false,shouldRetryOnError:false}}><ToastProvider><Harness/></ToastProvider></SWRConfig>);`;
const adapters = {
  "next/link": 'import React from "react";export default React.forwardRef(function Link({prefetch,replace,scroll,...props},ref){return <a {...props} ref={ref}/>;});',
  "@clerk/nextjs": `import {useSyncExternalStore} from "react";let state={owner:"owner-a",loaded:true},hold=false;const listeners=new Set();
const subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
export const fixtureTokenState={pending:[]};
export function setFixtureOwner(owner,loaded=true){state={owner,loaded};listeners.forEach(fn=>fn())}
export function holdNextFixtureToken(){hold=true}
export function releaseFixtureTokens(){for(const entry of fixtureTokenState.pending.splice(0))entry.resolve(entry.token)}
const getToken=async()=>{const token=state.owner?"synthetic-platform-"+state.owner:null;if(hold){hold=false;return new Promise(resolve=>fixtureTokenState.pending.push({resolve,token}))}return token};
export function useAuth(){const value=useSyncExternalStore(subscribe,()=>state);return{userId:value.owner,isLoaded:value.loaded,isSignedIn:!!value.owner,getToken}}`,
};
let assets;
function fixtureAssets() {
  return assets ??= (async () => {
    const cwd = process.cwd();
    const bundle = await build({ stdin: { contents: SOURCE, loader: "tsx", resolveDir: cwd }, bundle: true,
      write: false, minify: true, format: "iife", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
      define: { "process.env": JSON.stringify({ NEXT_PUBLIC_API_BASE: ORIGIN, NODE_ENV: "production" }) },
      plugins: [{ name: "synthetic-platform-auth", setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => adapters[args.path] ? { path: args.path, namespace: "platform-fixture" } : undefined);
        builder.onLoad({ filter: /.*/, namespace: "platform-fixture" }, args => ({ contents: adapters[args.path], loader: "tsx", resolveDir: cwd }));
      } }],
    });
    const buildId = (await readFile(path.join(cwd, ".next/BUILD_ID"), "utf8")).trim();
    const cssRoot = path.join(cwd, ".next/static/css");
    const cssNames = (await readdir(cssRoot, { recursive: true })).filter(file => file.endsWith(".css")).sort();
    if (!buildId || !cssNames.length) throw new Error("Current production CSS is required for platform disconnect proof");
    const css = (await Promise.all(cssNames.map(file => readFile(path.join(cssRoot, file), "utf8")))).join("\n");
    const definitions = [["PlatformHanken", "hanken-grotesk-latin.woff2", "100 900"],
      ["PlatformBricolage", "bricolage-grotesque-latin.woff2", "600 800"], ["PlatformFraunces", "fraunces-latin-normal.woff2", "400 700"]];
    const fonts = new Map(await Promise.all(definitions.map(async ([, file]) => [file, await readFile(path.join(cwd, "app/fonts", file))])));
    const fontCss = definitions.map(([family, file, weight]) => `@font-face{font-family:${family};src:url('/fonts/${file}') format('woff2');font-weight:${weight};font-style:normal;font-display:swap;}`).join("\n")
      + ":root{--font-sans:PlatformHanken;--font-display:PlatformBricolage;--font-serif:PlatformFraunces;}";
    return { script: bundle.outputFiles[0].text, css: css + fontCss, cssNames, buildId, fonts };
  })();
}
function connection(owner) {
  return { platform: "twitch", configured: true, connected: true, ready: true, streamingAvailable: true,
    streamingConsent: true, platformUserName: owner === "owner-b" ? "Fixture B account" : "Fixture A account",
    scopes: [], connectedAt: "2026-10-26T00:00:00Z", lastSyncedAt: null, lastError: null };
}

/** Actual consumer, SWR/clientApi ownership, confirmation, Modal, Toast and
 * production CSS/fonts. Only auth and HTTP are synthetic. Every request is
 * intercepted; no provider popup, native confirmation or real account exists.
 * @param {import('@playwright/test').Page} page
 * @param {'light'|'dark'} theme
 */
export async function openPlatformDisconnectFixture(page, theme = "light") {
  const { script, css, cssNames, buildId, fonts } = await fixtureAssets();
  const errors = [], unexpectedRequests = [], externalAttempts = [], rejectedWrites = [], reads = [], writes = [], approvals = [];
  let failingStatusReads = 0;
  let nextPostDeleteVariant = null, awaitingPostDeleteStatus = false;
  const state = new Map([["owner-a", connection("owner-a")], ["owner-b", connection("owner-b")]]);
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const forbidden = { popups: 0, nativeConfirms: 0 };
    window.platformDisconnectForbidden = forbidden;
    window.open = () => { forbidden.popups += 1; throw new Error("Provider popups are forbidden in this fixture"); };
    window.confirm = () => { forbidden.nativeConfirms += 1; throw new Error("Native confirmation is forbidden in this fixture"); };
  });
  await page.routeWebSocket("**/*", socket => {
    const url = new URL(socket.url());
    externalAttempts.push({ method: "WEBSOCKET", origin: url.origin, path: url.pathname, search: url.search });
    unexpectedRequests.push(`WEBSOCKET ${socket.url()}`); socket.close();
  });
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const authorization = request.headers().authorization;
    const owner = authorization === "Bearer synthetic-platform-owner-a" ? "owner-a"
      : authorization === "Bearer synthetic-platform-owner-b" ? "owner-b" : null;
    const receipt = { method, path: url.pathname, search: url.search, owner, authorization,
      contentType: request.headers()["content-type"] ?? null, body: request.postData() };
    if (method !== "GET") writes.push(receipt);
    const reject = (reason = "unknown_resource") => {
      unexpectedRequests.push(`${method} ${url.origin}${url.pathname}${url.search}`);
      if (method !== "GET") rejectedWrites.push({ ...receipt, origin: url.origin, reason });
      return route.abort();
    };
    if (url.origin !== ORIGIN) {
      externalAttempts.push({ method, origin: url.origin, path: url.pathname, search: url.search });
      return reject("external_request");
    }
    const json = (data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data), headers: { "cache-control": "no-store" } });
    if (url.pathname.startsWith("/v1/")) {
      if (!owner || url.search) return reject();
      if (method === "GET" && url.pathname === API_PATH) {
        reads.push(receipt);
        const variant = awaitingPostDeleteStatus ? nextPostDeleteVariant : null;
        if (awaitingPostDeleteStatus) { awaitingPostDeleteStatus = false; nextPostDeleteVariant = null; }
        if (failingStatusReads > 0) {
          failingStatusReads -= 1;
          return json({ error: { code: "synthetic_status_unavailable", message: "Synthetic status refresh failed." } }, 503);
        }
        const platforms = [state.get(owner), ...["kick", "youtube"].map(platform => ({ platform,
          configured: false, connected: false, ready: false, streamingAvailable: false, streamingConsent: false,
          platformUserName: "", scopes: [], connectedAt: null, lastSyncedAt: null, lastError: null }))];
        if (variant === "missingTwitch") return json({ platforms: platforms.filter(row => row.platform !== "twitch") });
        if (variant === "stillConnected" || variant === "invalidTwitch") {
          platforms[0] = { ...platforms[0], connected: variant === "stillConnected" ? true : "invalid",
            connectedAt: "2026-10-26T00:02:00Z", platformUserName: "Unconfirmed post-delete status" };
        }
        return json({ platforms });
      }
      if (method === "DELETE" && url.pathname === `${API_PATH}/twitch`) {
        const approval = approvals.shift();
        if (!approval || approval.owner !== owner || approval.connectedAt !== state.get(owner).connectedAt || receipt.body !== null) return reject("invalid_or_unapproved_disconnect");
        if (approval.outcome === "error") return json({ error: { code: "synthetic_unavailable", message: "Synthetic disconnect failed. Retry requires another confirmation." } }, 503);
        state.set(owner, { ...state.get(owner), connected: false, ready: false, streamingConsent: false, connectedAt: null });
        awaitingPostDeleteStatus = true;
        return json({ ok: true });
      }
      return reject();
    }
    if (method !== "GET") return reject();
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: script });
    if (url.pathname === "/fixture.css") return route.fulfill({ contentType: "text/css", body: css });
    if (url.pathname.startsWith("/fonts/") && fonts.has(url.pathname.slice(7))) return route.fulfill({ contentType: "font/woff2", body: fonts.get(url.pathname.slice(7)) });
    if (url.pathname === "/settings") return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en" data-theme="${theme}" data-theme-mode="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Platform disconnect fixture</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>` });
    return reject();
  });
  await page.goto(`${ORIGIN}/settings`);
  await page.getByRole("group", { name: "Twitch account permissions" }).getByRole("button", { name: "Disconnect", exact: true }).waitFor();
  await page.evaluate(async () => { await document.fonts.ready; });
  return { errors, unexpectedRequests, externalAttempts, rejectedWrites, reads, writes, cssNames, buildId,
    failNextStatusRead() { failingStatusReads += 1; },
    /** Only the status GET after the next successful synthetic DELETE changes. */
    nextPostDeleteStatus(variant) { nextPostDeleteVariant = variant; },
    /** Only the test's explicit approval may arm this synthetic DELETE. */
    approveDelete(owner = "owner-a", outcome = "success") { approvals.push({ owner, outcome, connectedAt: state.get(owner).connectedAt }); },
    async replaceRevision(owner = "owner-a") {
      state.set(owner, { ...state.get(owner), connectedAt: "2026-10-26T00:01:00Z" });
      await page.evaluate(() => window.platformDisconnectFixture.refresh());
    },
  };
}
