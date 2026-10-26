import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const NOTIFICATION_FIXTURE_ORIGIN = "https://notification-popover-fixture.local";
const SOURCE = `import React,{useState}from'react';import{createRoot}from'react-dom/client';
import{SWRConfig}from'swr';import{NotificationBell}from'@/components/notifications/NotificationBell';
import{Modal}from'@/components/ui/Modal';
function Fixture(){const[later,setLater]=useState(false);window.fixtureOpenLaterNotificationDialog=()=>setLater(true);
return <SWRConfig value={{provider:()=>new Map(),dedupingInterval:0,shouldRetryOnError:false}}>
<main className="mx-auto max-w-3xl space-y-4 p-4"><h1 className="text-h2 font-display">Local notification example</h1>
<p className="text-body text-text-muted">Synthetic inbox data. Read acknowledgements stay inside this fixture.</p>
<div className="flex items-center justify-end gap-4"><button type="button" className="min-h-11 rounded px-2 text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Outside action</button><NotificationBell/></div>
<p className="text-body text-text">Plain outside text</p><div className="h-[1000px]" aria-hidden="true"/>
<Modal open={later} onClose={()=>setLater(false)} title="Later notification dialog"><button type="button" className="min-h-11 text-text">Later action</button></Modal>
</main></SWRConfig>};createRoot(document.getElementById('root')).render(<Fixture/>);`;

const adapters = {
  "next/link": `import React from'react';export default React.forwardRef(function Link({href,children,onClick,prefetch,scroll,...props},ref){return <a ref={ref} href={href} {...props} onClick={event=>{onClick?.(event);if(!event.defaultPrevented&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();history.pushState({},'',href)}}}>{children}</a>});`,
  "next/dynamic": `import React from'react';export default function dynamic(loader,options){const Lazy=React.lazy(()=>Promise.resolve(loader()).then(value=>typeof value==='function'?{default:value}:value));return props=><React.Suspense fallback={options?.loading?.()||null}><Lazy {...props}/></React.Suspense>}`,
  "@clerk/nextjs": `const getToken=async()=>'notification-fixture-token';export const useAuth=()=>({isLoaded:true,isSignedIn:true,userId:'notification-fixture-owner',getToken});`,
  "@/lib/useUserSocket": `import{useEffect}from'react';export function useUserSocket(handlers){useEffect(()=>{window.fixtureRefreshNotifications=()=>handlers['notifications:changed']?.();return()=>{delete window.fixtureRefreshNotifications}},[handlers])}`,
};

let assets;
function fixtureAssets() {
  return assets ??= (async () => {
    const cwd = process.cwd();
    const result = await build({ stdin: { contents: SOURCE, loader: "tsx", resolveDir: cwd }, bundle: true, write: false,
      minify: true, format: "iife", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
      define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_BASE": JSON.stringify(NOTIFICATION_FIXTURE_ORIGIN) },
      plugins: [{ name: "notification-synthetic-boundaries", setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => adapters[args.path] ? { path: args.path, namespace: "notification-adapter" } : undefined);
        builder.onLoad({ filter: /.*/, namespace: "notification-adapter" }, args => ({ contents: adapters[args.path], loader: "tsx", resolveDir: cwd }));
      } }],
    });
    const cssRoot = path.join(cwd, ".next/static/css");
    const cssNames = (await readdir(cssRoot, { recursive: true })).filter(file => file.endsWith(".css")).sort();
    if (!cssNames.length) throw new Error("Build current production CSS before running notification proof");
    const css = (await Promise.all(cssNames.map(file => readFile(path.join(cssRoot, file), "utf8")))).join("\n");
    const buildId = (await readFile(path.join(cwd, ".next/BUILD_ID"), "utf8")).trim();
    const definitions = [["NotificationHanken", "hanken-grotesk-latin.woff2", "100 900"],
      ["NotificationBricolage", "bricolage-grotesque-latin.woff2", "600 800"], ["NotificationFraunces", "fraunces-latin-normal.woff2", "400 700"]];
    const fonts = new Map(await Promise.all(definitions.map(async ([, file]) => [file, await readFile(path.join(cwd, "app/fonts", file))])));
    const fontCss = definitions.map(([family, file, weight]) => `@font-face{font-family:${family};src:url('/fonts/${file}') format('woff2');font-weight:${weight};font-style:normal;font-display:swap;}`).join("\n")
      + ":root{--font-sans:NotificationHanken;--font-display:NotificationBricolage;--font-serif:NotificationFraunces;}";
    return { script: result.outputFiles[0].text, css: css + fontCss, cssNames, buildId, fonts };
  })();
}

/** Actual Bell, lazy Panel, clientApi/SWR, Popover, Modal and production CSS.
 * Auth/socket/navigation and transport are synthetic. Only the exact fixture
 * read-ack POST is admitted; all other writes and nonlocal traffic are counted
 * and rejected. No real account, provider or clipboard receives a write.
 * @param {import('@playwright/test').Page} page
 * @param {'light'|'dark'} theme
 * @param {{count?: number, holdLists?: boolean, failList?: boolean, failUnread?: boolean}} options
 */
export async function openNotificationPopoverFixture(page, theme, options = {}) {
  const { script, css, cssNames, buildId, fonts } = await fixtureAssets();
  const errors = [], unexpectedRequests = [], rejectedWrites = [], externalAttempts = [], getRequests = [], readWrites = [];
  const state = { holdLists: options.holdLists ?? false, failList: options.failList ?? false, failUnread: options.failUnread ?? false };
  const heldLists = [], loadedIds = new Set();
  const rows = Array.from({ length: options.count ?? 2 }, (_, index) => ({
    id: `fixture-${String(index).padStart(2, "0")}`, kind: index % 2 ? "import.done" : "review.new",
    title: `Fixture update ${String(index).padStart(2, "0")}`, body: "Synthetic notification for keyboard and layout proof.",
    href: `/reviews/fixture-${index}`, count: 1, readAt: null,
    createdAt: new Date(Date.UTC(2026, 9, 25, 12, 0, index)).toISOString(),
  }));
  const cursorFor = row => `${row.createdAt}|${row.id}`;
  const json = (route, value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async () => { throw new DOMException("Clipboard is unavailable in notification proof", "NotAllowedError"); },
    } });
  });
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== NOTIFICATION_FIXTURE_ORIGIN) {
      externalAttempts.push(`${method} ${url.origin}${url.pathname}`);
      return route.abort();
    }
    if (method === "POST" && url.pathname === "/v1/me/notifications/read" && !url.search) {
      let body;
      try { body = request.postDataJSON(); } catch { body = null; }
      const keys = body && typeof body === "object" ? Object.keys(body) : [];
      const all = keys.length === 1 && keys[0] === "all" && body.all === true;
      const ids = keys.length === 1 && keys[0] === "ids" && Array.isArray(body.ids) && body.ids.length > 0 && body.ids.length <= 20
        && body.ids.every(id => typeof id === "string" && loadedIds.has(id)) && new Set(body.ids).size === body.ids.length;
      if (!all && !ids) {
        rejectedWrites.push(`${method} ${url.pathname} invalid read body`);
        return json(route, { error: { code: "bad_request", message: "Unknown fixture read body" } }, 400);
      }
      readWrites.push(all ? { all: true } : { ids: [...body.ids] });
      let updated = 0;
      for (const row of rows) if ((all || body.ids.includes(row.id)) && !row.readAt) { row.readAt = "2026-10-26T00:00:00.000Z"; updated += 1; }
      return json(route, { updated });
    }
    if (method !== "GET") {
      rejectedWrites.push(`${method} ${url.pathname}${url.search}`);
      return route.abort();
    }
    if (url.pathname === "/fixture.js" && !url.search) return route.fulfill({ contentType: "text/javascript", body: script });
    if (url.pathname === "/fixture.css" && !url.search) return route.fulfill({ contentType: "text/css", body: css });
    if (url.pathname.startsWith("/fonts/") && !url.search && fonts.has(url.pathname.slice(7))) return route.fulfill({ contentType: "font/woff2", body: fonts.get(url.pathname.slice(7)) });
    if (url.pathname === "/v1/me/notifications/unread-count" && !url.search) {
      getRequests.push(url.pathname);
      return state.failUnread ? json(route, { error: { code: "internal_error", message: "Fixture unread count unavailable" } }, 503)
        : json(route, { count: rows.filter(row => !row.readAt).length });
    }
    if (url.pathname === "/v1/me/notifications" && url.searchParams.get("limit") === "20"
      && [...url.searchParams.keys()].every(key => ["limit", "unread", "before"].includes(key))
      && [...url.searchParams.keys()].length === new Set(url.searchParams.keys()).size
      && (!url.searchParams.has("unread") || url.searchParams.get("unread") === "true")
      && (!url.searchParams.has("before") || rows.some(row => cursorFor(row) === url.searchParams.get("before")))) {
      getRequests.push(`${url.pathname}${url.search}`);
      if (state.holdLists) await new Promise(resolve => heldLists.push(resolve));
      if (state.failList) return json(route, { error: { code: "internal_error", message: "Fixture notification list unavailable" } }, 503);
      let filtered = rows.filter(row => !url.searchParams.has("unread") || !row.readAt);
      const before = url.searchParams.get("before");
      if (before) filtered = filtered.filter(row => cursorFor(row) < before);
      filtered = [...filtered].sort((a, b) => cursorFor(b).localeCompare(cursorFor(a)));
      const items = filtered.slice(0, 20).map(row => ({ ...row }));
      items.forEach(row => loadedIds.add(row.id));
      return json(route, { items, nextCursor: filtered.length > 20 ? cursorFor(filtered[19]) : null });
    }
    if (url.pathname === "/example" && !url.search) return route.fulfill({ contentType: "text/html", body:
      `<!doctype html><html lang="en" data-theme="${theme}" data-theme-mode="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local notification proof</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>` });
    unexpectedRequests.push(`${method} ${url.pathname}${url.search}`);
    return json(route, { error: { code: "not_found", message: "Unknown fixture GET" } }, 404);
  });
  await page.goto(`${NOTIFICATION_FIXTURE_ORIGIN}/example`);
  await page.getByRole("heading", { name: "Local notification example" }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { errors, unexpectedRequests, rejectedWrites, externalAttempts, getRequests, readWrites, cssNames, buildId,
    heldListCount: () => heldLists.length,
    releaseLists: () => { state.holdLists = false; heldLists.splice(0).forEach(resolve => resolve()); },
    allowList: () => { state.failList = false; }, allowUnread: () => { state.failUnread = false; },
  };
}
