import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const INFO_TIP_FIXTURE_ORIGIN = "https://info-tip-fixture.local";
const SOURCE = `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{usePathname}from'next/navigation';
import{InfoTip}from'@/components/ui/InfoTip';import{Term}from'@/components/ui/Term';import{Modal}from'@/components/ui/Modal';
import{GroupingPreference}from'@/components/analyzer/opponents/GroupingPreference';import{HelpArticleBody}from'@/components/help/HelpArticleBody';
import{HelpSearch}from'@/components/help/HelpSearch';import article from'@/lib/help/articles/analyzer/glossary';window.fixtureGroupingWrites=[];
function Fixture(){const route=usePathname(),[term,setTerm]=useState('net-mmr'),[grouped,setGrouped]=useState(true),[parent,setParent]=useState(false),[later,setLater]=useState(false);
window.fixtureTipTerm=setTerm;window.fixtureTipLater=()=>setLater(true);
const preference={groupByPlayer:grouped,loading:false,saving:false,unavailable:false,error:'',retry(){},async setGroupByPlayer(value){window.fixtureGroupingWrites.push(value);setGrouped(value);return true}};
return <main className="mx-auto max-w-3xl space-y-6 p-4"><h1 className="text-h2 font-display">Local glossary example</h1>
{route==='/help/glossary'?<HelpArticleBody article={article}/>:<><section aria-label="Contextual help example" className="space-y-3">
<Term id={term} label={term==='net-mmr'?'Net MMR':'Pulse ID'}>{term==='net-mmr'?'Net MMR':'Pulse ID'}</Term>
<GroupingPreference preference={preference}/><button type="button" className="min-h-11 rounded px-3 text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Outside action</button>
<button type="button" className="min-h-11 rounded px-3 text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={()=>setParent(true)}>Open tip parent</button></section>
<section aria-label="Help search example"><h2 className="text-h4 font-semibold">Find a definition</h2><HelpSearch label="Search help"/></section></>}
<Modal open={parent} onClose={()=>setParent(false)} title="InfoTip parent"><InfoTip termId="toon" label="Toon"/></Modal>
<Modal open={later} onClose={()=>setLater(false)} title="Later tip dialog"><button type="button" className="min-h-11 text-text">Later action</button></Modal>
</main>};createRoot(document.getElementById('root')).render(<Fixture/>);`;
const adapters = {
  "next/navigation": `import{useSyncExternalStore}from'react';const sub=f=>{addEventListener('fixture-tip-nav',f);return()=>removeEventListener('fixture-tip-nav',f)};const go=href=>{history.pushState({},'',href);dispatchEvent(new Event('fixture-tip-nav'));requestAnimationFrame(()=>document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView({block:'nearest'}))};window.fixtureTipNavigate=go;export const usePathname=()=>useSyncExternalStore(sub,()=>location.pathname);`,
  "next/link": `import React from'react';export default React.forwardRef(function Link({href,children,onClick,target,prefetch,scroll,...props},ref){return <a ref={ref} href={href} target={target} {...props} onClick={event=>{onClick?.(event);if(!event.defaultPrevented&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey&&(!target||target==='_self')&&String(href).startsWith('/')){event.preventDefault();window.fixtureTipNavigate(href)}}}>{children}</a>});`,
  "@/components/analyzer/settings/ChatCommandsCard": `export const ChatCommandsCard=()=>null;`,
};

let assets;
function fixtureAssets() {
  return assets ??= (async () => {
    const cwd = process.cwd();
    const result = await build({ stdin: { contents: SOURCE, loader: "tsx", resolveDir: cwd }, bundle: true, write: false,
      minify: true, format: "iife", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
      define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_REVIEWS_ENABLED": '"on"' },
      plugins: [{ name: "info-tip-definition-and-navigation-boundaries", setup(builder) {
        builder.onResolve({ filter: /^@\/lib\/glossary$/ }, args => args.kind === "dynamic-import"
          ? { path: `${INFO_TIP_FIXTURE_ORIGIN}/definitions.mjs`, external: true } : undefined);
        builder.onResolve({ filter: /.*/ }, args => adapters[args.path] ? { path: args.path, namespace: "tip-adapter" } : undefined);
        builder.onLoad({ filter: /.*/, namespace: "tip-adapter" }, args => ({ contents: adapters[args.path], loader: "tsx", resolveDir: cwd }));
      } }],
    });
    // Serve the actual canonical module, not handwritten definitions. Only its
    // native dynamic-import boundary is held; all InfoTip lifetime code is real.
    const definitions = await build({ entryPoints: [path.join(cwd, "lib/glossary.ts")], bundle: true, write: false,
      minify: true, format: "esm", platform: "browser", tsconfig: "tsconfig.json" });
    const cssRoot = path.join(cwd, ".next/static/css");
    const cssNames = (await readdir(cssRoot, { recursive: true })).filter(file => file.endsWith(".css")).sort();
    if (!cssNames.length) throw new Error("Build current production CSS before InfoTip proof");
    const css = (await Promise.all(cssNames.map(file => readFile(path.join(cssRoot, file), "utf8")))).join("\n");
    const buildId = (await readFile(path.join(cwd, ".next/BUILD_ID"), "utf8")).trim();
    const fontDefinitions = [["InfoTipHanken", "hanken-grotesk-latin.woff2", "100 900"],
      ["InfoTipBricolage", "bricolage-grotesque-latin.woff2", "600 800"], ["InfoTipFraunces", "fraunces-latin-normal.woff2", "400 700"]];
    const fonts = new Map(await Promise.all(fontDefinitions.map(async ([, file]) => [file, await readFile(path.join(cwd, "app/fonts", file))])));
    const fontCss = fontDefinitions.map(([family, file, weight]) => `@font-face{font-family:${family};src:url('/fonts/${file}') format('woff2');font-weight:${weight};font-style:normal;font-display:swap;}`).join("\n")
      + ":root{--font-sans:InfoTipHanken;--font-display:InfoTipBricolage;--font-serif:InfoTipFraunces;}";
    return { script: result.outputFiles[0].text, definitions: definitions.outputFiles[0].text, css: css + fontCss, cssNames, buildId, fonts };
  })();
}

/** Actual InfoTip/Term/Popover/Modal, GroupingPreference, glossary article/
 * renderer/browser and HelpSearch. The import boundary alone is intercepted;
 * a module-local switch can throw from lookup to exercise retry. Navigation
 * and the existing chat widget are synthetic; all API writes/external requests
 * are counted/rejected. Grouping changes local fixture state only.
 * @param {import('@playwright/test').Page} page
 * @param {'light'|'dark'} theme
 * @param {{holdDefinitions?: boolean, startPath?: string}} options
 */
export async function openInfoTipFixture(page, theme, options = {}) {
  const { script, definitions, css, cssNames, buildId, fonts } = await fixtureAssets();
  const errors = [], unexpectedRequests = [], rejectedWrites = [], externalAttempts = [], definitionLoads = [];
  let holding = options.holdDefinitions ?? false;
  const held = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript(() => { window.fixtureDefinitionFailure = false; window.fixtureDefinitionLookups = []; });
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== INFO_TIP_FIXTURE_ORIGIN) { externalAttempts.push(`${method} ${url.origin}${url.pathname}`); return route.abort(); }
    if (method !== "GET") { rejectedWrites.push(`${method} ${url.pathname}${url.search}`); return route.abort(); }
    if (url.pathname === "/fixture.js" && !url.search) return route.fulfill({ contentType: "text/javascript", body: script });
    if (url.pathname === "/fixture.css" && !url.search) return route.fulfill({ contentType: "text/css", body: css });
    if (url.pathname.startsWith("/fonts/") && !url.search && fonts.has(url.pathname.slice(7))) return route.fulfill({ contentType: "font/woff2", body: fonts.get(url.pathname.slice(7)) });
    if (url.pathname === "/canonical-glossary.mjs" && !url.search) return route.fulfill({ contentType: "text/javascript", body: definitions });
    if (url.pathname === "/definitions.mjs" && !url.search) {
      definitionLoads.push(url.pathname); if (holding) await new Promise(resolve => held.push(resolve));
      return route.fulfill({ contentType: "text/javascript", body: `import{glossaryTerm as lookup}from'/canonical-glossary.mjs';export function glossaryTerm(id){window.fixtureDefinitionLookups.push(id);if(window.fixtureDefinitionFailure)throw new Error('Synthetic lookup failure');return lookup(id)}` });
    }
    if (["/example", "/help/glossary"].includes(url.pathname) && !url.search) return route.fulfill({ contentType: "text/html", body:
      `<!doctype html><html lang="en" data-theme="${theme}" data-theme-mode="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local glossary proof</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>` });
    unexpectedRequests.push(`${method} ${url.pathname}${url.search}`);
    return route.fulfill({ status: 404, body: "Unknown glossary fixture GET" });
  });
  await page.goto(`${INFO_TIP_FIXTURE_ORIGIN}${options.startPath ?? "/example"}`);
  await page.getByRole("heading", { name: "Local glossary example" }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { errors, unexpectedRequests, rejectedWrites, externalAttempts, definitionLoads, cssNames, buildId,
    heldCount: () => held.length, releaseDefinitions: () => { holding = false; held.splice(0).forEach(resolve => resolve()); } };
}
