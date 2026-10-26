import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const ORIGIN = "https://site-cta-fixture.local";
const SOURCE = `import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{LandingPageContent}from'@/components/landing/LandingPageContent';import{setFixtureAudience}from'@clerk/nextjs';
import{setFixtureMode}from'@/lib/instant/flag';
function Fixture(){const[revision,render]=useState(0);window.siteCtaFixture={setOptions:(signedIn,mode)=>{setFixtureAudience(signedIn);setFixtureMode(mode);render(value=>value+1)}};
return <main id="main-content" data-fixture-revision={revision} className="mx-auto max-w-6xl px-4 pb-8"><LandingPageContent/></main>}
createRoot(document.getElementById('root')).render(<Fixture/>);`;
const adapters = {
  "next/link": `import React from'react';export default React.forwardRef(function Link({prefetch,replace,scroll,onNavigate,...props},ref){return <a {...props} ref={ref}/>})`,
  "next/image": `import React from'react';export default function Image({priority,unoptimized,fill,...props}){return <img {...props}/>}`,
  "@clerk/nextjs": `import{useSyncExternalStore}from'react';let signedIn=false;const listeners=new Set();export function setFixtureAudience(value){signedIn=value;listeners.forEach(listener=>listener())}const subscribe=listener=>{listeners.add(listener);return()=>listeners.delete(listener)};export const SignedIn=({children})=>useSyncExternalStore(subscribe,()=>signedIn)?children:null;export const SignedOut=({children})=>useSyncExternalStore(subscribe,()=>signedIn)?null:children`,
  "@/lib/instant/flag": `let mode='all';export const getInstantImportMode=()=>mode;export const setFixtureMode=value=>{mode=value}`,
  "@/components/landing/HeroCarousel": "export const HeroCarousel=()=>null;",
  "@/components/landing/RealGameShowcase": "export const RealGameShowcase=()=>null;",
  "@/components/landing/GuidesStrip": "export const GuidesStrip=()=>null;",
  "@/components/landing/StreamManagerShowcase": "export const StreamManagerShowcase=()=>null;",
  "@/components/landing/ReplayDemo": "export const ReplayDemo=()=>null;",
  "@/components/landing/ProductShowcases": "export const PracticePreview=()=>null,ReplayTheaterPreview=()=>null,StreamStudioPreview=()=>null,VirtualSetStrip=()=>null;",
  "@/components/landing/CompanionShowcase": "export const CompanionShowcase=()=>null;",
  "@/components/pwa/InstallPrompt": "export const InstallPrompt=()=>null;",
};

let assets;
function fixtureAssets() {
  return assets ??= (async () => {
    const cwd = process.cwd();
    const bundle = await build({ stdin: { contents: SOURCE, loader: "tsx", resolveDir: cwd }, bundle: true,
      write: false, minify: true, format: "iife", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [{ name: "landing-cta-synthetic-boundaries", setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => adapters[args.path] ? { path: args.path, namespace: "site-cta-fixture" } : undefined);
        builder.onLoad({ filter: /.*/, namespace: "site-cta-fixture" }, args => ({ contents: adapters[args.path], loader: "tsx", resolveDir: cwd }));
      } }],
    });
    const buildId = (await readFile(path.join(cwd, ".next/BUILD_ID"), "utf8")).trim();
    const cssRoot = path.join(cwd, ".next/static/css");
    const cssNames = (await readdir(cssRoot, { recursive: true })).filter(file => file.endsWith(".css")).sort();
    if (!cssNames.length) throw new Error("Build current production CSS before the landing CTA proof");
    const css = (await Promise.all(cssNames.map(file => readFile(path.join(cssRoot, file), "utf8")))).join("\n");
    const definitions = [["SiteCtaHanken", "hanken-grotesk-latin.woff2", "100 900"],
      ["SiteCtaBricolage", "bricolage-grotesque-latin.woff2", "600 800"], ["SiteCtaFraunces", "fraunces-latin-normal.woff2", "400 700"]];
    const fonts = new Map(await Promise.all(definitions.map(async ([, file]) => [file, await readFile(path.join(cwd, "app/fonts", file))])));
    const fontCss = definitions.map(([family, file, weight]) => `@font-face{font-family:${family};src:url('/fonts/${file}') format('woff2');font-weight:${weight};font-style:normal;font-display:swap;}`).join("\n")
      + ":root{--font-sans:SiteCtaHanken;--font-display:SiteCtaBricolage;--font-serif:SiteCtaFraunces;}";
    return { script: bundle.outputFiles[0].text, css: css + fontCss, cssNames, fonts, buildId, publicRoot: path.resolve(cwd, "public") };
  })();
}

/** Real LandingPageContent/LinkButton; non-CTA showcases, auth and rollout are
 * synthetic. CSS/fonts and requested public images come from the current build.
 * No account, provider, API or clipboard action is available.
 * @param {import('@playwright/test').Page} page
 * @param {'light'|'dark'} theme
 */
export async function openLandingCtaFixture(page, theme) {
  const { script, css, cssNames, fonts, buildId, publicRoot } = await fixtureAssets();
  const errors = [], unknownRequests = [], rejectedWrites = [], externalAttempts = [], staticGets = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("No fixture clipboard access"); } } });
  });
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== ORIGIN) { externalAttempts.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort(); }
    if (request.method() !== "GET") { rejectedWrites.push(`${request.method()} ${url.pathname}`); return route.abort(); }
    if (url.search) { unknownRequests.push(`${request.method()} ${url.pathname}${url.search}`); return route.abort(); }
    const reply = (contentType, body) => { staticGets.push(url.pathname); return route.fulfill({ contentType, body }); };
    if (url.pathname === "/fixture.js") return reply("text/javascript", script);
    if (url.pathname === "/fixture.css") return reply("text/css", css);
    if (url.pathname.startsWith("/fonts/") && fonts.has(url.pathname.slice(7))) return reply("font/woff2", fonts.get(url.pathname.slice(7)));
    if (url.pathname === "/") return reply("text/html", `<!doctype html><html lang="en" data-theme="${theme}" data-theme-mode="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local landing action proof</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
    const image = path.resolve(publicRoot, `.${decodeURIComponent(url.pathname)}`);
    if (image.startsWith(publicRoot + path.sep) && /\.(png|webp|svg)$/.test(image)) {
      try { return await reply(image.endsWith(".svg") ? "image/svg+xml" : image.endsWith(".webp") ? "image/webp" : "image/png", await readFile(image)); } catch { /* Record missing static resources with all other unknown requests. */ }
    }
    unknownRequests.push(`${request.method()} ${url.pathname}`); return route.abort();
  });
  await page.goto(`${ORIGIN}/`);
  await page.getByRole("heading", { level: 1 }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { buildId, cssNames, errors, unknownRequests, rejectedWrites, externalAttempts, staticGets };
}
