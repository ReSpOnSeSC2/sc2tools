import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const ORIGIN = "https://more-sheet-fixture.local";
const SOURCE = `import React from 'react';import{createRoot}from'react-dom/client';
import{AppChrome}from'@/components/chrome/AppChrome';import{lockBodyScroll}from'@/lib/bodyScrollLock';
window.fixtureExtraLock=()=>{window.fixtureUnlock=lockBodyScroll()};
createRoot(document.getElementById('root')).render(<AppChrome><h1 className="font-display text-h2">Local navigation example</h1><p className="text-body text-text">Synthetic navigation and form boundaries; no account or provider writes.</p><button type="button" className="min-h-11 text-accent">Page action</button></AppChrome>);`;
const adapters = {
  "next/navigation": `import{useSyncExternalStore}from'react';const sub=f=>{addEventListener('fixture-nav',f);return()=>removeEventListener('fixture-nav',f)};const go=href=>{history.pushState({},'',href);dispatchEvent(new Event('fixture-nav'))};window.fixtureNavigate=go;const router={push:go,replace:go,prefetch(){}};export const usePathname=()=>useSyncExternalStore(sub,()=>location.pathname);export const useSearchParams=()=>new URLSearchParams(useSyncExternalStore(sub,()=>location.search));export const useRouter=()=>router;`,
  "next/link": `import React from'react';import{useRouter}from'next/navigation';export default React.forwardRef(function Link({href,children,prefetch,scroll,replace,onClick,onNavigate,target,...props},ref){const router=useRouter();return <a ref={ref} href={href} target={target} {...props} onClick={event=>{onClick?.(event);if(!event.defaultPrevented&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey&&(!target||target==='_self')&&String(href).startsWith('/')){event.preventDefault();let cancelled=false;onNavigate?.({preventDefault(){cancelled=true}});if(!cancelled)router.push(href)}}}>{children}</a>});`,
  "next/image": `import React from'react';export default function Image({priority,unoptimized,fill,...props}){return <img {...props}/>}`,
  "next/dynamic": `import React from'react';export default function dynamic(loader,options){const Lazy=React.lazy(()=>Promise.resolve(loader()).then(value=>typeof value==='function'?{default:value}:value));return props=><React.Suspense fallback={options?.loading?.()||null}><Lazy {...props}/></React.Suspense>}`,
  "@clerk/nextjs": `import React,{useSyncExternalStore}from'react';const CloseMenu=React.createContext(()=>{});let signedIn=true;const sub=f=>{addEventListener('fixture-auth',f);return()=>removeEventListener('fixture-auth',f)};window.fixtureAuth=value=>{signedIn=value;dispatchEvent(new Event('fixture-auth'))};export function useAuth(){const active=useSyncExternalStore(sub,()=>signedIn);return{isLoaded:true,isSignedIn:active,userId:active?'more-fixture-owner':null,getToken:async()=>null}}export const SignedIn=({children})=>useAuth().isSignedIn?children:null,SignedOut=({children})=>useAuth().isSignedIn?null:children,ClerkLoading=()=>null;export function UserButton({children}){const[open,setOpen]=React.useState(false);return <CloseMenu.Provider value={()=>setOpen(false)}><div className="relative"><button type="button" aria-label="Fixture account" aria-expanded={open} onClick={()=>setOpen(!open)}>Account</button><div hidden={!open} className="absolute right-0 top-full z-50 rounded-lg border border-border bg-bg-surface p-3 text-text">{children}</div></div></CloseMenu.Provider>}UserButton.MenuItems=({children})=><ul aria-label="Fixture account menu">{children}</ul>;UserButton.Link=({label,href})=><li><a href={href}>{label}</a></li>;UserButton.Action=({label,onClick})=>{const close=React.useContext(CloseMenu);if(label==='Appearance')window.fixtureAppearance=onClick;return <li>{onClick?<button type="button" className="min-h-11" onClick={()=>{close();onClick();}}>{label}</button>:<span>{label}</span>}</li>};`,
  "@/lib/clientApi": `const me={userId:'more-fixture-owner',isAdmin:false,games:{total:1,latest:null}},coaching={role:'none'};export const API_BASE='https://more-sheet-fixture.local';export function useApi(path){return{data:path==='/v1/me'?me:path==='/v1/coaching/me'?coaching:undefined}}`,
  "./ConnectionStatus": `export const ConnectionStatusProvider=({children})=>children;export const ConnectionBanner=()=>null;`,
  "@/components/SyncStatus": `export const SyncStatus=()=>null;`,
  "./CoachingBookingAlert": `export const CoachingBookingAlert=()=>null;`,
  "@/components/build-checkin/BuildCheckInProvider": `export const BuildCheckInProvider=({children})=>children;`,
  "@/components/build-checkin/BuildCheckInAlert": `export const BuildCheckInAlert=()=>null;`,
  "@/components/notifications/NotificationBell": `export const NotificationBell=()=>null;`,
  "@/components/announcements/WhatsNewButton": `export const WhatsNewButton=()=>null;`,
  "@/components/announcements/SiteIncidentBanner": `export const SiteIncidentBanner=()=>null;`,
  "@/components/practice/PracticeChip": `export const PracticeChip=()=>null;`,
  "./SiteStats": `export const SiteStats=()=>null;`,
  "@/components/feedback/LazyReportIssueModal": `import React from'react';import{Modal}from'@/components/ui/Modal';export function LazyReportIssueModal({open,onClose,prefill}){return <Modal open={open} onClose={onClose} title="Local report form"><p className="text-body text-text">Synthetic {prefill?.type} form boundary. No submission is available.</p><button type="button" className="min-h-11 text-accent" onClick={onClose}>Close local form</button></Modal>}`,
};

let assets;
function fixtureAssets() {
  return assets ??= (async () => {
    const cwd = process.cwd();
    const result = await build({ stdin: { contents: SOURCE, loader: "tsx", resolveDir: cwd }, bundle: true, write: false,
      minify: true, format: "iife", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
      define: { "process.env": "{}", "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_GUIDES_ENABLED": '"on"' },
      plugins: [{ name: "more-appearance-synthetic-boundaries", setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => adapters[args.path] ? { path: args.path, namespace: "more-adapter" } : undefined);
        builder.onLoad({ filter: /.*/, namespace: "more-adapter" }, args => ({ contents: adapters[args.path], loader: "tsx", resolveDir: cwd }));
      } }],
    });
    const cssRoot = path.join(cwd, ".next/static/css");
    const cssNames = (await readdir(cssRoot, { recursive: true })).filter(file => file.endsWith(".css")).sort();
    if (!cssNames.length) throw new Error("Build production CSS before running the More fixture");
    const css = (await Promise.all(cssNames.map(file => readFile(path.join(cssRoot, file), "utf8")))).join("\n");
    const definitions = [["MoreHanken", "hanken-grotesk-latin.woff2", "100 900"],
      ["MoreBricolage", "bricolage-grotesque-latin.woff2", "600 800"], ["MoreFraunces", "fraunces-latin-normal.woff2", "400 700"]];
    const fonts = new Map(await Promise.all(definitions.map(async ([, file]) => [file, await readFile(path.join(cwd, "app/fonts", file))])));
    const fontCss = definitions.map(([family, file, weight]) => `@font-face{font-family:${family};src:url('/fonts/${file}') format('woff2');font-weight:${weight};font-style:normal;font-display:swap;}`).join("\n")
      + ":root{--font-sans:MoreHanken;--font-display:MoreBricolage;--font-serif:MoreFraunces;}";
    return { script: result.outputFiles[0].text, css: css + fontCss, cssNames, fonts, logo: await readFile(path.join(cwd, "public/logo-64.webp")) };
  })();
}

/** Actual AppChrome/More/Sheet/Appearance and production CSS/fonts. Auth,
 * navigation and auxiliary data are synthetic; the report body uses real Modal.
 * Every request is intercepted and the host clipboard is unavailable.
 * @param {import('@playwright/test').Page} page
 * @param {'light'|'dark'} theme
 */
export async function openMoreAppearanceFixture(page, theme) {
  const { script, css, cssNames, fonts, logo } = await fixtureAssets();
  const errors = [], unexpectedRequests = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript(mode => {
    localStorage.setItem("sc2tools.theme", mode);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new DOMException("Fixture clipboard denied", "NotAllowedError"); } } });
  }, theme);
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== ORIGIN || request.method() !== "GET") {
      unexpectedRequests.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort();
    }
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: script });
    if (url.pathname === "/fixture.css") return route.fulfill({ contentType: "text/css", body: css });
    if (url.pathname === "/logo-64.webp") return route.fulfill({ contentType: "image/webp", body: logo });
    if (url.pathname.startsWith("/fonts/") && fonts.has(url.pathname.slice(7))) return route.fulfill({ contentType: "font/woff2", body: fonts.get(url.pathname.slice(7)) });
    if (url.pathname === "/settings") return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en" data-theme="${theme}" data-theme-mode="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local More navigation proof</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>` });
    unexpectedRequests.push(`${request.method()} ${url.pathname}`); return route.fulfill({ status: 404, body: "Unknown fixture resource" });
  });
  await page.goto(`${ORIGIN}/settings`);
  await page.getByRole("heading", { name: "Local navigation example" }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { errors, unexpectedRequests, cssNames };
}
