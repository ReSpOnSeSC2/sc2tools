import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const COPY_FIXTURE_ORIGIN = "https://copy-consumers-fixture.local";
export const COPY_FIXTURE_PATH = "/community/builds/synthetic-stargate";

const SOURCE = `import React,{useState}from'react';import{createRoot}from'react-dom/client';
import{ShareLinkButton}from'@/components/community/ShareLinkButton';
import{CommunityBuildActionsBar}from'@/components/community/CommunityBuildActionsBar';
import{DefinitionsCatalog}from'@/components/definitions/DefinitionsCatalog';
import{Modal}from'@/components/ui/Modal';import{Button}from'@/components/ui/Button';import{ToastProvider}from'@/components/ui/Toast';
const compactBuild={slug:'synthetic-stargate',title:'Synthetic Stargate',description:'Synthetic published rules for a local layout example.',matchup:'PvZ',authorName:'Synthetic author',votes:17,publishedAt:'2026-10-26T00:00:00Z',build:{name:'Synthetic Stargate',race:'Protoss',vsRace:'Zerg',rules:[{type:'count_min',name:'BuildStargate',time_lt:300,count:1}]}};
function Fixture(){const[copyPath,setCopyPath]=useState('${COPY_FIXTURE_PATH}'),[open,setOpen]=useState(false);window.fixtureCopyPath=setCopyPath;
return <ToastProvider><main className="mx-auto min-w-0 max-w-5xl space-y-6 p-4 sm:p-6"><h1 className="font-display text-h2 font-bold text-text">Copy public links</h1><p className="text-body text-text-muted">Synthetic public examples. Clipboard delivery is simulated; no account or provider writes are available.</p>
<section aria-label="Community copy example" className="min-w-0 space-y-3 rounded-xl border border-border bg-bg-surface p-4"><h2 className="text-h3 font-semibold text-text">Community build link</h2><output aria-label="Current public copy path" className="block break-all text-caption text-text-muted">{copyPath}</output><ShareLinkButton path={copyPath} label="Share build link"/><Button variant="secondary" onClick={()=>setOpen(true)}>Open shared link modal</Button></section>
<section aria-label="Compact Community example" className="min-w-0 space-y-3"><h2 className="text-h3 font-semibold text-text">Compact build actions</h2><CommunityBuildActionsBar build={compactBuild}/></section>
<section aria-label="Definitions copy example" className="min-w-0 space-y-3"><h2 className="text-h3 font-semibold text-text">Definition links</h2><DefinitionsCatalog/></section>
<Modal open={open} onClose={()=>setOpen(false)} title="Public link example"><ShareLinkButton path={copyPath} label="Copy modal build link"/></Modal></main></ToastProvider>}
createRoot(document.getElementById('root')).render(<Fixture/>);`;

const adapters = {
  "next/navigation": `import{useSyncExternalStore}from'react';const changed='copy-fixture-location';for(const method of['pushState','replaceState']){const native=history[method].bind(history);history[method]=(...args)=>{native(...args);dispatchEvent(new Event(changed))}}const sub=f=>{addEventListener('popstate',f);addEventListener(changed,f);return()=>{removeEventListener('popstate',f);removeEventListener(changed,f)}};export const useSearchParams=()=>new URLSearchParams(useSyncExternalStore(sub,()=>location.search));export const usePathname=()=>useSyncExternalStore(sub,()=>location.pathname);`,
  "next/link": `import React from'react';export default React.forwardRef(function Link({children,prefetch,scroll,replace,onNavigate,...props},ref){return <a ref={ref} {...props}>{children}</a>});`,
  "next/image": `import React from'react';export default function Image({priority,unoptimized,fill,...props}){return <img {...props}/>}`,
  "@/components/practice/PracticeButton": `export const PracticeButton=()=>null;`,
  "./BuildVariantContinuation": `export const BuildVariantContinuation=()=>null;`,
  "@/components/help/LazyHelpLink": `import React from'react';import{CircleHelp}from'lucide-react';import{HELP_TEXT_LINK_CLASS,HELP_ICON_LINK_CLASS}from'@/components/help/HelpInline';export function LazyHelpLink({slug,anchor,children,variant='inline',className='',onOpen}){return <a href={'/help/'+slug+(anchor?'#'+anchor:'')} className={[(variant==='icon'?HELP_ICON_LINK_CLASS:HELP_TEXT_LINK_CLASS),className].filter(Boolean).join(' ')} onClick={onOpen} aria-label={variant==='icon'?'Help':undefined}>{variant==='icon'?<CircleHelp className="h-4 w-4" aria-hidden/>:children??'Help'}</a>}`,
  "./useCommunityVote": `export function useCommunityVote(_slug,initialVotes){return{votes:initialVotes,myVote:0,authenticated:true,authLoading:false,pending:false,completed:false,error:null,retry:null,cast(){throw new Error('Voting is forbidden in the copy fixture')}}}`,
  "./SaveToLibraryButton": `import React from'react';import{Button}from'@/components/ui/Button';import{Library}from'lucide-react';export function SaveToLibraryButton(){return <div className="space-y-1"><Button variant="primary" fullWidth iconLeft={<Library className="h-4 w-4" aria-hidden/>} onClick={()=>{throw new Error('Library writes are forbidden in the copy fixture')}}>Save to my library</Button><p className="text-micro text-text-muted">Saves a private copy you can edit. The author&apos;s page doesn&apos;t change.</p></div>}`,
  "./CommunityBuildOwnerControls": `export const CommunityBuildOwnerControls=()=>null;`,
};

let assets;
function fixtureAssets() {
  return assets ??= (async () => {
    const cwd = process.cwd();
    const result = await build({
      stdin: { contents: SOURCE, loader: "tsx", resolveDir: cwd }, bundle: true, write: false,
      minify: true, format: "iife", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
      define: { "process.env": "{}", "process.env.NODE_ENV": '"production"' },
      plugins: [{ name: "copy-consumers-synthetic-boundaries", setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => adapters[args.path] ? { path: args.path, namespace: "copy-adapter" } : undefined);
        builder.onLoad({ filter: /.*/, namespace: "copy-adapter" }, args => ({ contents: adapters[args.path], loader: "tsx", resolveDir: cwd }));
      } }],
    });
    const buildId = (await readFile(path.join(cwd, ".next/BUILD_ID"), "utf8")).trim();
    if (!buildId) throw new Error("Build production CSS before running copy consumers");
    const cssRoot = path.join(cwd, ".next/static/css");
    const cssNames = (await readdir(cssRoot, { recursive: true })).filter(file => file.endsWith(".css")).sort();
    if (!cssNames.length) throw new Error("Production CSS is unavailable for copy consumers");
    const css = (await Promise.all(cssNames.map(file => readFile(path.join(cssRoot, file), "utf8")))).join("\n");
    const definitions = [["CopyHanken", "hanken-grotesk-latin.woff2", "100 900"],
      ["CopyBricolage", "bricolage-grotesque-latin.woff2", "600 800"], ["CopyFraunces", "fraunces-latin-normal.woff2", "400 700"]];
    const fonts = new Map(await Promise.all(definitions.map(async ([, file]) => [file, await readFile(path.join(cwd, "app/fonts", file))])));
    const fontCss = definitions.map(([family, file, weight]) => `@font-face{font-family:${family};src:url('/fonts/${file}') format('woff2');font-weight:${weight};font-style:normal;font-display:swap;}`).join("\n")
      + ":root{--font-sans:CopyHanken;--font-display:CopyBricolage;--font-serif:CopyFraunces;}";
    const icons = new Map(await Promise.all(["protoss", "terran", "zerg"].map(async race => [race,
      await readFile(path.join(cwd, `public/icons/sc2/races/${race}.svg`))])));
    return { script: result.outputFiles[0].text, css: css + fontCss, cssNames, buildId, fonts, icons };
  })();
}

/** Real copy consumers, compact ActionsBar/vote/export controls, Modal/Toast,
 * production CSS and committed fonts. Vote state and the normal library-save
 * leaf are synthetic; their mutation callbacks throw. Variant/practice, owner
 * controls, unrelated lazy Help and Next runtime boundaries are omitted;
 * export actions stay closed.
 * Every request is intercepted; clipboard/native-copy never reaches the host.
 * @param {import('@playwright/test').Page} page
 * @param {'light'|'dark'} theme
 */
export async function openCopyConsumersFixture(page, theme) {
  const { script, css, cssNames, buildId, fonts, icons } = await fixtureAssets();
  const errors = [], unexpectedRequests = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const state = { mode: "denied", writes: [], pending: [], promptCalls: 0, execCalls: 0 };
    Object.defineProperty(window, "fixtureCopyState", { value: state });
    Object.defineProperty(window, "fixtureCopyMode", { value: mode => { state.mode = mode; } });
    Object.defineProperty(window, "fixtureCopySettle", { value: outcome => {
      const pending = state.pending.shift();
      if (!pending) throw new Error("No synthetic clipboard request is pending");
      if (outcome === "resolve") pending.resolve(); else pending.reject(new DOMException("Synthetic clipboard denied", "NotAllowedError"));
    } });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: text => {
      state.writes.push(text);
      if (state.mode === "success") return Promise.resolve();
      if (state.mode === "held") return new Promise((resolve, reject) => state.pending.push({ resolve, reject }));
      return Promise.reject(new DOMException("Synthetic clipboard denied", "NotAllowedError"));
    } } });
    window.prompt = () => { state.promptCalls += 1; throw new Error("Native prompt is forbidden in this fixture"); };
    document.execCommand = () => { state.execCalls += 1; throw new Error("Native execCommand is forbidden in this fixture"); };
  });
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== COPY_FIXTURE_ORIGIN || request.method() !== "GET") {
      unexpectedRequests.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort();
    }
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: script });
    if (url.pathname === "/fixture.css") return route.fulfill({ contentType: "text/css", body: css });
    if (url.pathname.startsWith("/fonts/") && fonts.has(url.pathname.slice(7))) return route.fulfill({ contentType: "font/woff2", body: fonts.get(url.pathname.slice(7)) });
    const race = /^\/icons\/sc2\/races\/(protoss|terran|zerg)\.svg$/.exec(url.pathname)?.[1];
    if (race && icons.has(race)) return route.fulfill({ contentType: "image/svg+xml", body: icons.get(race) });
    if (url.pathname === "/definitions") return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en" data-theme="${theme}" data-theme-mode="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local copy consumer proof</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>` });
    unexpectedRequests.push(`${request.method()} ${url.pathname}`); return route.fulfill({ status: 404, body: "Unknown fixture resource" });
  });
  await page.goto(`${COPY_FIXTURE_ORIGIN}/definitions`);
  await page.getByRole("heading", { name: "Copy public links", exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { errors, unexpectedRequests, cssNames, buildId };
}
