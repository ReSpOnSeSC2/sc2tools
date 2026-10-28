import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import loadConfig from "tailwindcss/loadConfig.js";

const ORIGIN = "https://bingo-ladder-fixture.local";
const SOURCE = `
import React from'react';import{createRoot}from'react-dom/client';
import{bingoLadder}from'@/components/analyzer/arcade/modes/games/bingoLadder';
import{buildCandidates}from'@/components/analyzer/arcade/modes/games/bingoLadder.candidates';
import{BingoFixtureStore}from'@/components/analyzer/arcade/hooks/useArcadeState';
const candidates=buildCandidates(new Set(['P','T','Z'])).sort((a,b)=>b.label.length-a.label.length);
const weekKey='2026-W44',cards=[];
for(let start=0;start<candidates.length;start+=24){
  const picked=candidates.slice(start,start+24);
  while(picked.length<24)picked.push(candidates[picked.length]);
  const cells=picked.map((cell,index)=>({...cell,id:'fixture-'+start+'-'+index,ticked:index%2===0}));
  cells.splice(12,0,{id:'fixture-'+start+'-free',predicate:'any_game',params:{},label:'Free space — play a game',ticked:true});
  cards.push({startedAt:'2026-10-27T12:00:00Z',weekKey,rerolled:false,cells});
}
window.bingoFixtureCards=cards;window.bingoFixtureMutations=[];
window.bingoFixtureLabels=candidates.map(cell=>cell.label);
const params=new URLSearchParams(location.search),requested=Number(params.get('card')??0);
const index=Number.isInteger(requested)&&requested>=0&&requested<cards.length?requested:0;
document.documentElement.style.fontSize=params.get('scale')==='2'?'32px':'16px';
function App(){
  return <main className="mx-auto min-w-0 max-w-3xl space-y-4 p-4">
    <h1 className="text-h2 font-semibold text-text">Arcade</h1><h2 className="text-body font-semibold text-text">Daily run · game</h2>
    <BingoFixtureStore.Provider value={cards[index]}>
      {bingoLadder.render({question:{weekKey,cells:cards[index].cells},answer:null,onAnswer:()=>{},score:null,revealed:false,isDaily:true})}
    </BingoFixtureStore.Provider>
  </main>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;

// Auth and the persisted state store are the only product boundaries replaced.
// The real mode, candidate factory, shell, icons and styles render unchanged.
const adapters = {
  "@clerk/nextjs": `export const useAuth=()=>({isSignedIn:false,getToken:async()=>{throw new Error('No fixture auth requests permitted')}});`,
  "arcade-state": `import{createContext,useContext}from'react';export const BingoFixtureStore=createContext(null);export function useArcadeState(){const bingo=useContext(BingoFixtureStore);if(!bingo)throw new Error('Missing synthetic Bingo provider');return{state:{minerals:0,bingo},update:()=>{window.bingoFixtureMutations.push('update')},spendMinerals:()=>{window.bingoFixtureMutations.push('spend');return false}}}`,
};

let assets;
function fixtureAssets() {
  return assets ??= (async () => {
    const cwd = process.cwd();
    const result = await build({
      stdin: { contents: SOURCE, loader: "tsx", resolveDir: cwd },
      bundle: true, write: false, minify: true, format: "iife", platform: "browser",
      jsx: "automatic", tsconfig: "tsconfig.json",
      define: { "process.env": "{}", "process.env.NODE_ENV": '"production"' },
      plugins: [{ name: "bingo-explicit-boundaries", setup(builder) {
        builder.onResolve({ filter: /^@clerk\/nextjs$|(?:^|\/)hooks\/useArcadeState$/ }, args => ({ path: args.path === "@clerk/nextjs" ? args.path : "arcade-state", namespace: "bingo-adapter" }));
        builder.onLoad({ filter: /.*/, namespace: "bingo-adapter" }, args => ({ contents: adapters[args.path], loader: "tsx", resolveDir: cwd }));
      } }],
    });
    const config = loadConfig(path.join(cwd, "tailwind.config.ts")), globals = path.join(cwd, "app/globals.css");
    const css = await postcss([tailwindcss({ ...config, content: [
      { raw: SOURCE, extension: "tsx" }, path.join(cwd, "components/analyzer/arcade/**/*.{ts,tsx}"),
      path.join(cwd, "components/ui/**/*.{ts,tsx}"),
    ] })]).process(await readFile(globals, "utf8"), { from: globals });
    const definitions = [
      ["BingoHanken", "hanken-grotesk-latin.woff2", "100 900"],
      ["BingoBricolage", "bricolage-grotesque-latin.woff2", "600 800"],
      ["BingoFraunces", "fraunces-latin-normal.woff2", "400 700"],
    ];
    const fonts = new Map(await Promise.all(definitions.map(async ([, file]) => [file, await readFile(path.join(cwd, "app/fonts", file))])));
    const fontCss = definitions.map(([family, file, weight]) => `@font-face{font-family:${family};src:url('/fonts/${file}') format('woff2');font-weight:${weight};font-style:normal;font-display:swap;}`).join("\n")
      + ":root{--font-sans:BingoHanken;--font-display:BingoBricolage;--font-serif:BingoFraunces;}";
    return { script: result.outputFiles[0].text, css: css.css + fontCss, fonts };
  })();
}

/** GET-only intercepted page: no listener, product credentials or API transport.
 * Current source and tokens are compiled; no stale .next CSS is accepted.
 * @param {import('@playwright/test').Page} page
 * @param {{theme?: 'light'|'dark'}} options
 */
export async function openBingoLadderFixture(page, { theme = "light" } = {}) {
  const { script, css, fonts } = await fixtureAssets();
  const errors = [], unexpectedRequests = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== ORIGIN || request.method() !== "GET") {
      unexpectedRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort();
    }
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: script });
    if (url.pathname === "/fixture.css") return route.fulfill({ contentType: "text/css; charset=utf-8", body: css });
    if (url.pathname.startsWith("/fonts/") && fonts.has(url.pathname.slice(7))) return route.fulfill({ contentType: "font/woff2", body: fonts.get(url.pathname.slice(7)) });
    if (url.pathname === "/arcade") return route.fulfill({ contentType: "text/html; charset=utf-8", body:
      `<!doctype html><html lang="en" data-theme="${theme}" data-theme-mode="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bingo layout proof</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>` });
    unexpectedRequests.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 404, body: "Unknown fixture resource" });
  });
  const showCard = async (card = 0, scale = 1) => {
    await page.goto(`${ORIGIN}/arcade?card=${card}&scale=${scale}`);
    await page.getByRole("grid", { name: "Bingo card", exact: true }).waitFor();
    await page.evaluate(async () => { await document.fonts.ready; });
  };
  await showCard();
  return { errors, unexpectedRequests, showCard };
}
