import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import loadConfig from "tailwindcss/loadConfig.js";

const ORIGIN = "https://chart-kit-fixture.local";
const period = (bucket, mmr, wins, losses) => ({ bucket, openMmr: mmr - 10, closeMmr: mmr, minMmr: mmr - 20, maxMmr: mmr + 20, wins, losses, total: wins + losses });
const ladders = Array.from({ length: 9 }, (_, index) => {
  const points = [period("2026-10-01", 3000 + index * 100, 3, 1), period("2026-10-04", 3050 + index * 100, 12, 8)];
  return { seriesKey: `fixture-${index + 1}|P`, toonHandle: `fixture-${index + 1}`, region: ["NA", "EU", "KR"][index % 3], ladderRace: "P", label: `${["NA", "EU", "KR"][index % 3]} fixture ${index + 1} / P`, points,
    peak: { bucket: points[1].bucket, mmr: points[1].closeMmr }, trough: { bucket: points[0].bucket, mmr: points[0].closeMmr }, latest: { bucket: points[1].bucket, mmr: points[1].closeMmr } };
});
const games = Array.from({ length: 25 }, (_, index) => ({ id: `fixture-game-${index + 1}`,
  date: index < 20 ? new Date(Date.parse("2026-10-01T08:00:00Z") + index * 30 * 60_000).toISOString() : `2026-10-${String(index - 18).padStart(2, "0")}T12:00:00Z`,
  result: index % 6 < 4 ? "Win" : "Loss", map: "Alcyone LE", my_build: "Synthetic opening", opp_strategy: "Synthetic pressure", macro_score: 40 + index,
}));
games.splice(10, 0, { id: "fixture-unknown", date: "2026-10-01T12:45:00Z", result: "Unknown", map: "Unmeasured map" });
const DATA = {
  ratingSeries: [{ matchup: "PvZ", totalGames: 75, sampleGames: 12, windowGames: 10, ratedGames: 10, excludedNoMmr: 2, perfRating: 4100,
    points: Array.from({ length: 12 }, (_, index) => ({ date: "2026-10-02T12:00:00Z", games: Math.min(index + 1, 10), ratedGames: Math.min(index + 1, 10), excludedNoMmr: 0, perfRating: index === 5 || index === 11 ? null : 4200.1 })) },
    { matchup: "PvT", totalGames: 10, sampleGames: 10, windowGames: 10, ratedGames: 10, excludedNoMmr: 0, perfRating: null,
      points: Array.from({ length: 10 }, (_, index) => ({ date: "2026-10-02T12:00:00Z", games: index + 1, ratedGames: index + 1, excludedNoMmr: 0, perfRating: null })) }],
  aging: [24, 20].map((count, index) => ({ build: index ? "Fixture expansion" : "Fixture opening", curve: Array.from({ length: count }, (_, cursor) => {
    const n = cursor + 1, cumulativeWins = index ? Math.floor(n * .7) : Math.ceil(n / 2);
    return { n, wins: 1, losses: 0, cumulativeWins, cumulativeLosses: n - cumulativeWins };
  }) })),
  progression: [24, 20].map((count, index) => ({ build: index ? "Fixture expansion" : "Fixture opening", points: Array.from({ length: count }, (_, cursor) => ({ date: `2026-10-${String(cursor + 1).padStart(2, "0")}T12:00:00Z`, mmr: index ? 3800 + cursor * 5 : 4000 + cursor * 10, result: cursor % 2 ? "loss" : "win" })) })),
  mmr: { interval: "day", points: ladders[0].points, series: ladders, peak: ladders[0].peak, trough: ladders[0].trough, latest: ladders[0].latest },
  daily: { dailySwings: { timezone: "UTC", bestGain: { day: "2026-10-01", netMmr: 40, measuredGames: 20, wins: 12, losses: 8 }, biggestLoss: { day: "2026-10-04", netMmr: -20, measuredGames: 20, wins: 8, losses: 12 }, measuredDays: 2, measuredGames: 40 } },
  bands: [
    { series: "Fixture opening", bucket: 4000, label: "4000–4199", games: 5, wins: 1, losses: 1 },
    { series: "Sparse fixture", bucket: 4000, label: "4000–4199", games: 2, wins: 2, losses: 0 },
    { series: "Fixture opening", bucket: 4200, label: "4200–4399", games: 20, wins: 12, losses: 8 },
  ],
  mechanics: [
    { date: "2026-10-01", games: 19, wins: 10, losses: 9, winRate: .5, avgMacroScore: 61, macroN: 19 },
    { date: "2026-10-02", games: 7, wins: 4, losses: 3, winRate: .5, avgMacroScore: 65 },
    { date: "2026-10-03", games: 20, wins: 10, losses: 10, winRate: .5, avgMacroScore: 79, macroN: 20 },
    { date: "2026-10-05", games: 0, wins: 0, losses: 0, winRate: 0, avgMacroScore: null, macroN: 0 },
  ],
  scores: [
    { key: "low", label: "Below 60", min: null, max: 60, games: 8, wins: 2, losses: 4, winRate: .37, avgScore: 45 },
    { key: "high", label: "80+", min: 80, max: null, games: 20, wins: 12, losses: 8, winRate: .6, avgScore: 85 },
  ], games,
};
const SOURCE = `import React,{useState} from "react";import {createRoot} from "react-dom/client";
import {DATA} from "fixture:chart-data";
import {Card} from "@/components/ui/Card";import {Button} from "@/components/ui/Button";
import {useChartKit} from "@/lib/charts/theme";
import {wrColor} from "@/lib/format";
import {MmrBucketChart} from "@/components/analyzer/mmr/MmrBucketChart";
import {BuildAgingCurve} from "@/components/analyzer/mmr/BuildAgingCurve";
import {MmrProgressionByBuild} from "@/components/analyzer/mmr/MmrProgressionByBuild";
import {MmrProgressionChart} from "@/components/analyzer/charts/MmrProgressionChart";
import {MatchByMatchTimeline} from "@/components/analyzer/h2h/MatchByMatchTimeline";
import {StreaksMomentum} from "@/components/analyzer/h2h/StreaksMomentum";
import {MacroTrendChart} from "@/components/analyzer/charts/MacroTrendChart";
import {ScoreBucketsCard} from "@/components/analyzer/macro/report/ScoreBucketsCard";
import {FormSparkline} from "@/components/analyzer/charts/FormSparkline";
import {MatchupRatingCard} from "@/components/analyzer/charts/MatchupRatingCard";
function Palette(){const kit=useChartKit();return <aside aria-label="Chart theme key" data-testid="chart-theme-key" data-axis={kit.axis} data-grid={kit.grid} data-reduced={String(kit.reducedMotion)} className="space-y-2 rounded-lg border border-border p-3 text-caption">
<p>Resolved chart theme and series key</p><div className="flex flex-wrap items-center gap-3"><span data-testid="chart-tooltip-surface" style={{background:kit.tooltipStyle.background,color:kit.tokens.text,padding:8,border:\"1px solid \"+kit.grid}}>Tooltip surface</span><span data-testid="global-low-sample" style={{color:wrColor(.5,1)}}>Low sample text</span><span data-testid="global-amber" style={{color:wrColor(.475,20)}}>Amber midpoint text</span>{kit.series.map((color,index)=><span key={index} className="inline-flex items-center gap-1"><span data-testid="chart-series-swatch" style={{display:\"inline-block\",width:20,height:12,background:color}}/><span>Series {index+1}</span></span>)}</div></aside>;}
function Fixture(){const group=location.pathname.slice(1),[mode,setMode]=useState(document.documentElement.getAttribute(\"data-theme\")),[action,setAction]=useState(null),[count,setCount]=useState(0);
const log=value=>{setAction(value);setCount(current=>current+1);};const select=id=>log({kind:\"game\",id});
return <main className="mx-auto max-w-6xl space-y-6 p-4"><header className="space-y-3"><h1 className="text-h2">Chart kit {group.toUpperCase()} fixture</h1><p className="text-caption text-text-muted">Synthetic replay data · Protoss vs Terran · Alcyone LE · selected date range.</p><Button onClick={()=>{const next=mode===\"dark\"?\"light\":\"dark\";document.documentElement.setAttribute(\"data-theme\",next);document.documentElement.setAttribute(\"data-theme-mode\",next);setMode(next);}}>Switch fixture theme</Button><output aria-label="Fixture action count">{count}</output><output aria-label="Last fixture action" className="block break-words font-mono text-caption">{JSON.stringify(action)}</output></header><Palette/>
{group===\"rating\"?<MatchupRatingCard/>:group===\"mmr\"?<><Card title="MMR bands"><MmrBucketChart rows={DATA.bands} minSampleSize={3}/></Card><BuildAgingCurve/><MmrProgressionByBuild/><MmrProgressionChart bucket=\"day\"/></>:group===\"macro\"?<><Card title="Macro trend"><MacroTrendChart series={DATA.mechanics} metric=\"macro\" bucket=\"day\"/></Card><ScoreBucketsCard buckets={DATA.scores} onDrill={drill=>log({kind:\"drill\",...drill})}/><Card title="Recent form, small sample"><FormSparkline results={[\"win\",\"loss\",\"loss\"]} title=\"Small recent form\"/></Card><Card title="Recent form, twenty results"><FormSparkline results={Array.from({length:20},(_,index)=>index%2?\"loss\":\"win\")} title=\"Established recent form\"/></Card></>:<><Card title="Match-by-match history"><MatchByMatchTimeline chronoGames={DATA.games} oppRace=\"Zerg\" bucket=\"day\" rollingWindow={10} presetLong=\"Fixture date range\" opponentName=\"Synthetic opponent\" onSelectGame={select}/></Card><Card title="Streak history"><StreaksMomentum chronoGames={DATA.games} presetShort=\"Fixture range\" presetLong=\"Fixture date range\" opponentName=\"Synthetic opponent\" onSelectGame={select}/></Card></>}
</main>;}
createRoot(document.getElementById(\"root\")).render(<Fixture/>);`;
const adapters = {
  "fixture:chart-data": `export const DATA=${JSON.stringify(DATA)};`,
  "@/lib/clientApi": `import {DATA} from "fixture:chart-data";export const API_BASE=${JSON.stringify(ORIGIN)};export const useApi=path=>({data:path.includes("aging-curve")?DATA.aging:DATA.progression,isLoading:false,isValidating:false,error:undefined,mutate:async()=>null});`,
  "@/lib/filterContext": 'export const useFilters=()=>({filters:{race:"P",opp_race:"T",map:"Alcyone LE"},dbRev:7});export const filtersToQuery=()=>"?race=P&opp_race=T&map=Alcyone+LE";',
  "@/lib/trendsDataContext": 'import {DATA} from "fixture:chart-data";export const useTrendsDataScope=()=>({isGlobal:false,view:"personal"});export const useTrendsApi=path=>({data:path.startsWith("/v1/timeseries/mmr")?DATA.mmr:path.startsWith("/v1/timeseries/matchups")?{ratingSeries:DATA.ratingSeries}:DATA.daily,isLoading:false,error:undefined,mutate:async()=>null});',
  "@clerk/nextjs": 'export const useAuth=()=>({isLoaded:true,isSignedIn:true,userId:"synthetic-chart-owner",getToken:async()=>"synthetic-only"});',
  "next/link": 'import React from "react";export default React.forwardRef(function Link({prefetch,replace,scroll,...props},ref){return <a {...props} ref={ref}/>;});',
  "next/image": 'import React from "react";export default function Image({unoptimized,priority,fill,...props}){return <img {...props}/>;}',
  "next/navigation": 'export const usePathname=()=>"/chart-fixture";export const useRouter=()=>({push:()=>{},replace:()=>{}});export const useSearchParams=()=>new URLSearchParams();',
  "@/lib/sentry": 'export const captureException=async()=>null;',
  "@/components/help/LazyHelpLink": 'import React from "react";export const LazyHelpLink=({children})=><span>{children}</span>;',
  "@/components/feedback/LazyReportIssueModal": 'export const LazyReportIssueModal=()=>null;',
};
let assets;
function fixtureAssets() {
  return assets ??= (async () => {
    const cwd = process.cwd();
    const result = await build({ stdin: { contents: SOURCE, loader: "tsx", resolveDir: cwd }, bundle: true, write: false, minify: true, format: "iife", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
      define: { "process.env": "{}", "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "isolated-chart-adapters", setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => adapters[args.path] ? { path: args.path, namespace: "chart-adapter" } : undefined);
        builder.onLoad({ filter: /.*/, namespace: "chart-adapter" }, args => ({ contents: adapters[args.path], loader: "tsx", resolveDir: cwd }));
      } }], });
    const globals = path.join(cwd, "app/globals.css"), config = loadConfig(path.join(cwd, "tailwind.config.ts"));
    const css = await postcss([tailwindcss({ ...config, content: [{ raw: SOURCE, extension: "tsx" }, path.join(cwd, "components/analyzer/**/*.{ts,tsx}"), path.join(cwd, "components/ui/**/*.{ts,tsx}"), path.join(cwd, "components/maps/**/*.{ts,tsx}")], })]).process(await readFile(globals, "utf8"), { from: globals });
    const definitions = [["ChartHanken", "hanken-grotesk-latin.woff2", "100 900"], ["ChartBricolage", "bricolage-grotesque-latin.woff2", "600 800"], ["ChartFraunces", "fraunces-latin-normal.woff2", "400 700"]];
    const fonts = new Map(await Promise.all(definitions.map(async ([, file]) => [file, await readFile(path.join(cwd, "app/fonts", file))])));
    const fontCss = definitions.map(([family, file, weight]) => `@font-face{font-family:${family};src:url('/fonts/${file}') format('woff2');font-weight:${weight};font-style:normal;font-display:swap;}`).join("\n") + ':root{--font-sans:ChartHanken;--font-display:ChartBricolage;--font-serif:ChartFraunces;}';
    const mapArt = await readFile(path.join(cwd, "../replay-engine/data/map-images/alcyone_le.webp"));
    return { script: result.outputFiles[0].text, css: css.css + fontCss, fonts, mapArt };
  })();
}

/** Actual chart components/Recharts/kit/Frame/global CSS/local fonts.
 * Only auth, query hooks, navigation, Help and reporting are synthetic adapters.
 * Every browser request is intercepted; no real account/provider is reachable.
 * @param {import('@playwright/test').Page} page
 * @param {'mmr'|'macro'|'h2h'|'rating'} group
 * @param {{theme?:'light'|'dark',reducedMotion?:boolean}} options
 */
export async function openChartKitFixture(page, group, { theme = "dark", reducedMotion = false } = {}) {
  const { script, css, fonts, mapArt } = await fixtureAssets(), errors = [], unexpectedRequests = [], handledMapRequests = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: reducedMotion ? "reduce" : "no-preference" });
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === "GET" && url.origin === "http://localhost:8080" && url.pathname === "/v1/map-image" && url.searchParams.size === 1 && url.searchParams.get("map") === "Alcyone LE") {
      handledMapRequests.push(request.url());
      return route.fulfill({ contentType: "image/webp", body: mapArt });
    }
    if (url.origin !== ORIGIN || request.method() !== "GET") { unexpectedRequests.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort(); }
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: script });
    if (url.pathname === "/fixture.css") return route.fulfill({ contentType: "text/css", body: css });
    if (url.pathname.startsWith("/fonts/") && fonts.has(url.pathname.slice(7))) return route.fulfill({ contentType: "font/woff2", body: fonts.get(url.pathname.slice(7)) });
    if (/^\/(icons|maps)\//.test(url.pathname) && !url.pathname.includes("..")) {
      const root = path.resolve(process.cwd(), "public"), file = path.resolve(root, url.pathname.slice(1));
      if (file.startsWith(root + path.sep)) try { return route.fulfill({ contentType: file.endsWith(".svg") ? "image/svg+xml" : file.endsWith(".webp") ? "image/webp" : "image/png", body: await readFile(file) }); } catch { /* Unknown paths are reported below. */ }
    }
    if (url.pathname === `/${group}`) return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en" data-theme="${theme}" data-theme-mode="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chart kit ${group} fixture</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>` });
    unexpectedRequests.push(`${request.method()} ${url.pathname}`); return route.fulfill({ status: 404, body: "Unknown chart fixture resource" });
  });
  await page.goto(`${ORIGIN}/${group}`);
  await page.getByRole("heading", { name: `Chart kit ${group.toUpperCase()} fixture`, exact: true }).waitFor();
  await page.evaluate(async () => { await document.fonts.ready; });
  return { errors, unexpectedRequests, handledMapRequests };
}
