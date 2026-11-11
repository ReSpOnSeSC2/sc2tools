import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import loadConfig from "tailwindcss/loadConfig.js";

const ORIGIN = "https://arcade-rounds-fixture.local";
const buildNames = ["Reaper expansion", "Bio pressure", "Mech transition", "Air switch", "Gateway pressure", "Roach timing"];
const games = [], opponents = [];
for (let opponent = 0; opponent < 24; opponent++) {
  const pulseId = `synthetic-rival-${opponent + 1}`, wins = 3 + opponent % 6, losses = 3 + opponent % 7;
  opponents.push({ pulseId, name: `Synthetic rival ${opponent + 1}`, games: wins + losses, wins, losses,
    userWinRate: wins / (wins + losses), opponentWinRate: losses / (wins + losses), lastPlayed: null });
  for (let index = 0; index < wins + losses; index++) {
    const buildIndex = (opponent + index) % buildNames.length;
    games.push({ gameId: `${pulseId}-${index}`, oppPulseId: pulseId, result: index < wins ? "Win" : "Loss",
      date: new Date(Date.UTC(2026, 9, 1) + (opponent * 24 + index) * 60 * 60_000).toISOString(),
      myBuild: buildNames[buildIndex], duration: 480 + buildIndex * 120 + index });
  }
}
// Every rival has a historical 3+ game streak in each direction. Six distinct
// build-duration tiers independently qualify Closer's Eye using the same games.
const DATA = { games, opponents, builds: [], customBuilds: [], communityBuilds: [], matchups: [], maps: [], summary: null, mapPool: [] };

const SOURCE = `import React,{useEffect,useState} from "react";import {createRoot} from "react-dom/client";
import {ModeRunner} from "@/components/analyzer/arcade/ModeRunner";
import {activeStreakHunter} from "@/components/analyzer/arcade/modes/quizzes/activeStreakHunter";
import {closersEye} from "@/components/analyzer/arcade/modes/quizzes/closersEye";
import {records} from "fixture:arcade-state";
function Fixture(){const [count,setCount]=useState(0),mode=location.pathname==="/streak"?activeStreakHunter:closersEye;
useEffect(()=>{const update=()=>setCount(records.length);window.addEventListener("arcade-fixture-recorded",update);return()=>window.removeEventListener("arcade-fixture-recorded",update);},[]);
return <main className="mx-auto max-w-3xl space-y-4 p-4"><header><h1 className="text-h2">Arcade rounds fixture</h1><p className="text-caption text-text-muted">Synthetic replay history · {mode.title} · Quick Play</p><output aria-label="Recorded attempts">{count}</output></header><section aria-label="Fixture Arcade round"><ModeRunner mode={mode} isDaily={false}/></section></main>;}
createRoot(document.getElementById("root")).render(<Fixture/>);`;

const adapters = {
  "fixture:arcade-data": `export const DATA=${JSON.stringify(DATA)};`,
  "fixture:arcade-state": 'export const records=[];window.arcadeFixtureRecords=records;export const recordPlay=entry=>{records.push(entry);window.dispatchEvent(new Event("arcade-fixture-recorded"));};export const state={buildleByDay:{}};export const earnBadge=()=>{};',
  "./hooks/useArcadeData": 'import {DATA} from "fixture:arcade-data";const source={data:DATA,baseData:DATA,loading:false,error:null,retrySessionPolicy:async()=>null};export const useArcadeData=()=>source;',
  "./hooks/useArcadeState": 'import {recordPlay,earnBadge,state} from "fixture:arcade-state";export const useArcadeState=()=>({recordPlay,earnBadge,state});',
  "./hooks/useDailySeed": 'const rng=()=>0.5;export const useDailySeed=()=>({day:"2026-11-10",tz:"UTC",rng,userId:"synthetic-arcade-owner"});',
  "next/link": 'import React from "react";export default React.forwardRef(function Link({prefetch,replace,scroll,...props},ref){return <a {...props} ref={ref}/>;});',
  "@/components/help/LazyHelpLink": 'import React from "react";export const LazyHelpLink=({children})=><span>{children}</span>;',
};
let assets;
function fixtureAssets() {
  return assets ??= (async () => {
    const cwd = process.cwd();
    const result = await build({ stdin: { contents: SOURCE, loader: "tsx", resolveDir: cwd }, bundle: true, write: false, minify: true,
      format: "iife", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json", define: { "process.env": "{}", "process.env.NODE_ENV": '"production"' },
      plugins: [{ name: "isolated-arcade-adapters", setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => adapters[args.path] ? { path: args.path, namespace: "arcade-adapter" } : undefined);
        builder.onLoad({ filter: /.*/, namespace: "arcade-adapter" }, args => ({ contents: adapters[args.path], loader: "tsx", resolveDir: cwd }));
      } }], });
    const globals = path.join(cwd, "app/globals.css"), config = loadConfig(path.join(cwd, "tailwind.config.ts"));
    const css = await postcss([tailwindcss({ ...config, content: [{ raw: SOURCE, extension: "tsx" },
      path.join(cwd, "components/analyzer/arcade/**/*.{ts,tsx}"), path.join(cwd, "components/ui/**/*.{ts,tsx}")], })]).process(await readFile(globals, "utf8"), { from: globals });
    const definitions = [["ArcadeHanken", "hanken-grotesk-latin.woff2", "100 900"], ["ArcadeBricolage", "bricolage-grotesque-latin.woff2", "600 800"], ["ArcadeFraunces", "fraunces-latin-normal.woff2", "400 700"]];
    const fonts = new Map(await Promise.all(definitions.map(async ([, file]) => [file, await readFile(path.join(cwd, "app/fonts", file))])));
    const fontCss = definitions.map(([family, file, weight]) => `@font-face{font-family:${family};src:url('/fonts/${file}') format('woff2');font-weight:${weight};font-style:normal;font-display:swap;}`).join("\n") + ':root{--font-sans:ArcadeHanken;--font-display:ArcadeBricolage;--font-serif:ArcadeFraunces;}';
    return { script: result.outputFiles[0].text, css: css.css + fontCss, fonts };
  })();
}

/** Real ModeRunner, quiz generators, renderers, scoring, shells, theme and fonts.
 * Only data/state/seed hooks and incidental Next/help adapters are synthetic.
 * Every request is handled locally; writes and external requests are rejected.
 * @param {import('@playwright/test').Page} page
 * @param {'streak'|'closers'} mode
 * @param {{theme?:'light'|'dark'}} options
 */
export async function openArcadeRoundsFixture(page, mode, { theme = "light" } = {}) {
  const { script, css, fonts } = await fixtureAssets(), errors = [], unexpectedRequests = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== "GET" || url.origin !== ORIGIN) { unexpectedRequests.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort(); }
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: script });
    if (url.pathname === "/fixture.css") return route.fulfill({ contentType: "text/css", body: css });
    if (url.pathname.startsWith("/fonts/") && fonts.has(url.pathname.slice(7))) return route.fulfill({ contentType: "font/woff2", body: fonts.get(url.pathname.slice(7)) });
    if (url.pathname === `/${mode}`) return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en" data-theme="${theme}" data-theme-mode="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Arcade rounds fixture</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>` });
    unexpectedRequests.push(`${request.method()} ${url.pathname}`); return route.fulfill({ status: 404, body: "Unknown Arcade fixture resource" });
  });
  await page.goto(`${ORIGIN}/${mode}`);
  await page.getByRole("heading", { name: mode === "streak" ? "Streak Hunter" : "Closer's Eye", exact: true }).waitFor();
  await page.evaluate(async () => { await document.fonts.ready; });
  return { errors, unexpectedRequests };
}
