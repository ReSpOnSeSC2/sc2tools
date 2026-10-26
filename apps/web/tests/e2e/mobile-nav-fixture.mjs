import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const MOBILE_NAV_FIXTURE_ORIGIN = "https://mobile-nav-fixture.local";
const SOURCE = `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{SWRConfig}from'swr';
import{Header}from'@/components/chrome/Header';import{Modal}from'@/components/ui/Modal';import{lockBodyScroll}from'@/lib/bodyScrollLock';
function Fixture(){const[later,setLater]=useState(false);window.fixtureMobileOpenLater=()=>setLater(true);
window.fixtureMobileAddLock=()=>{window.fixtureMobileReleaseLock=lockBodyScroll()};
return <SWRConfig value={{provider:()=>new Map(),dedupingInterval:0,shouldRetryOnError:false}}><Header/>
<main id="main-content" className="mx-auto max-w-3xl space-y-4 p-4"><h1 className="text-h2 font-display">Local mobile navigation example</h1>
<p className="text-body text-text-muted">Real navigation and theme controls with synthetic auth and transport.</p>
<button type="button" className="min-h-11 rounded px-3 text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Page action</button>
<div className="h-[1000px]" aria-hidden="true"/>
<Modal open={later} onClose={()=>setLater(false)} title="Later navigation dialog"><button type="button" className="min-h-11 text-text">Later action</button></Modal>
</main></SWRConfig>};createRoot(document.getElementById('root')).render(<Fixture/>);`;
const adapters = {
  "next/navigation": `import{useSyncExternalStore}from'react';const sub=f=>{addEventListener('fixture-mobile-nav',f);return()=>removeEventListener('fixture-mobile-nav',f)};const go=href=>{history.pushState({},'',href);dispatchEvent(new Event('fixture-mobile-nav'))};window.fixtureMobileNavigate=go;const router={push:go,replace:go,prefetch(){}};export const usePathname=()=>useSyncExternalStore(sub,()=>location.pathname);export const useSearchParams=()=>new URLSearchParams(useSyncExternalStore(sub,()=>location.search));export const useRouter=()=>router;`,
  "next/link": `import React from'react';import{useRouter}from'next/navigation';export default React.forwardRef(function Link({href,children,prefetch,scroll,replace,onClick,onNavigate,target,...props},ref){const router=useRouter();return <a ref={ref} href={href} target={target} {...props} onClick={event=>{onClick?.(event);if(!event.defaultPrevented&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey&&(!target||target==='_self')&&String(href).startsWith('/')){event.preventDefault();let cancelled=false;onNavigate?.({preventDefault(){cancelled=true}});if(!cancelled)router.push(href)}}}>{children}</a>});`,
  "next/image": `import React from'react';export default function Image({priority,unoptimized,fill,...props}){return <img {...props}/>}`,
  "@clerk/nextjs": `import React,{useSyncExternalStore}from'react';let mode='out';const sub=f=>{addEventListener('fixture-mobile-auth',f);return()=>removeEventListener('fixture-mobile-auth',f)};window.fixtureMobileAuth=value=>{mode=value;dispatchEvent(new Event('fixture-mobile-auth'))};const tokens={player:async()=>'mobile-fixture-player',admin:async()=>'mobile-fixture-admin',out:async()=>null};export function useAuth(){const current=useSyncExternalStore(sub,()=>mode);return{isLoaded:true,isSignedIn:current!=='out',userId:current==='out'?null:'mobile-fixture-'+current,getToken:tokens[current]}}export const SignedIn=({children})=>useAuth().isSignedIn?children:null,SignedOut=({children})=>useAuth().isSignedIn?null:children;export function UserButton({children}){return <div><button type="button" aria-label="Fixture account" className="min-h-11">Account</button><div hidden>{children}</div></div>};UserButton.MenuItems=({children})=><div>{children}</div>;UserButton.Link=({label,href})=><a href={href}>{label}</a>;UserButton.Action=({label,onClick})=><button type="button" onClick={onClick}>{label}</button>;`,
  "./CoachingBookingAlert": `export const CoachingBookingAlert=()=>null;`,
  "@/components/notifications/NotificationBell": `export const NotificationBell=()=>null;`,
};

let assets;
function fixtureAssets() {
  return assets ??= (async () => {
    const cwd = process.cwd();
    const result = await build({ stdin: { contents: SOURCE, loader: "tsx", resolveDir: cwd }, bundle: true, write: false,
      minify: true, format: "iife", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
      define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_BASE": JSON.stringify(MOBILE_NAV_FIXTURE_ORIGIN),
        "process.env.NEXT_PUBLIC_GUIDES_ENABLED": '"on"', "process.env.NEXT_PUBLIC_REVIEWS_ENABLED": '"on"', "process.env.NEXT_PUBLIC_INSTANT_IMPORT": '"all"' },
      plugins: [{ name: "mobile-navigation-synthetic-boundaries", setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => adapters[args.path] ? { path: args.path, namespace: "mobile-nav-adapter" } : undefined);
        builder.onLoad({ filter: /.*/, namespace: "mobile-nav-adapter" }, args => ({ contents: adapters[args.path], loader: "tsx", resolveDir: cwd }));
      } }],
    });
    const cssRoot = path.join(cwd, ".next/static/css");
    const cssNames = (await readdir(cssRoot, { recursive: true })).filter(file => file.endsWith(".css")).sort();
    if (!cssNames.length) throw new Error("Build current production CSS before running MobileNav proof");
    const css = (await Promise.all(cssNames.map(file => readFile(path.join(cssRoot, file), "utf8")))).join("\n");
    const buildId = (await readFile(path.join(cwd, ".next/BUILD_ID"), "utf8")).trim();
    const definitions = [["MobileNavHanken", "hanken-grotesk-latin.woff2", "100 900"],
      ["MobileNavBricolage", "bricolage-grotesque-latin.woff2", "600 800"], ["MobileNavFraunces", "fraunces-latin-normal.woff2", "400 700"]];
    const fonts = new Map(await Promise.all(definitions.map(async ([, file]) => [file, await readFile(path.join(cwd, "app/fonts", file))])));
    const fontCss = definitions.map(([family, file, weight]) => `@font-face{font-family:${family};src:url('/fonts/${file}') format('woff2');font-weight:${weight};font-style:normal;font-display:swap;}`).join("\n")
      + ":root{--font-sans:MobileNavHanken;--font-display:MobileNavBricolage;--font-serif:MobileNavFraunces;}";
    return { script: result.outputFiles[0].text, css: css + fontCss, cssNames, buildId, fonts, logo: await readFile(path.join(cwd, "public/logo-64.webp")) };
  })();
}

/** Actual Header, MobileNav, gates, auth links, Sheet/Modal and ThemeChoice,
 * plus clientApi/SWR and production CSS/fonts. Auth, navigation and unrelated
 * notification/coaching controls are synthetic. Only the typed /v1/me GET is
 * admitted; unknown GETs, all writes and nonlocal requests are counted/rejected.
 * @param {import('@playwright/test').Page} page
 * @param {'light'|'dark'} theme
 */
export async function openMobileNavFixture(page, theme) {
  const { script, css, cssNames, buildId, fonts, logo } = await fixtureAssets();
  const errors = [], unexpectedRequests = [], rejectedWrites = [], externalAttempts = [], apiGets = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript(mode => {
    localStorage.setItem("sc2tools.theme", mode);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async () => { throw new DOMException("Clipboard is unavailable in navigation proof", "NotAllowedError"); },
    } });
  }, theme);
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== MOBILE_NAV_FIXTURE_ORIGIN) { externalAttempts.push(`${method} ${url.origin}${url.pathname}`); return route.abort(); }
    if (method !== "GET") { rejectedWrites.push(`${method} ${url.pathname}${url.search}`); return route.abort(); }
    if (url.pathname === "/fixture.js" && !url.search) return route.fulfill({ contentType: "text/javascript", body: script });
    if (url.pathname === "/fixture.css" && !url.search) return route.fulfill({ contentType: "text/css", body: css });
    if (url.pathname === "/logo-64.webp" && !url.search) return route.fulfill({ contentType: "image/webp", body: logo });
    if (url.pathname.startsWith("/fonts/") && !url.search && fonts.has(url.pathname.slice(7))) return route.fulfill({ contentType: "font/woff2", body: fonts.get(url.pathname.slice(7)) });
    if (url.pathname === "/v1/me" && !url.search) {
      const authorization = request.headers().authorization;
      if (["Bearer mobile-fixture-player", "Bearer mobile-fixture-admin"].includes(authorization)) {
        apiGets.push({ path: url.pathname, audience: authorization.endsWith("admin") ? "admin" : "player" });
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ isAdmin: authorization.endsWith("admin") }) });
      }
    }
    if (url.pathname === "/guides/pvz" && !url.search) return route.fulfill({ contentType: "text/html", body:
      `<!doctype html><html lang="en" data-theme="${theme}" data-theme-mode="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local mobile navigation proof</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>` });
    unexpectedRequests.push(`${method} ${url.pathname}${url.search}`);
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "not_found", message: "Unknown navigation fixture GET" } }) });
  });
  await page.goto(`${MOBILE_NAV_FIXTURE_ORIGIN}/guides/pvz`);
  await page.getByRole("heading", { name: "Local mobile navigation example" }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { errors, unexpectedRequests, rejectedWrites, externalAttempts, apiGets, cssNames, buildId };
}
