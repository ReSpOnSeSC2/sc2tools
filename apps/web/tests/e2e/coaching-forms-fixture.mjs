import { build } from "esbuild";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

let bundle;
function fixtureBundle() {
  return bundle ??= build({
    stdin: { contents: `
      import React,{useState} from "react"; import {createRoot} from "react-dom/client";
      import {ToastProvider} from "@/components/ui/Toast";
      import CoachingPractice from "@/app/coaching/CoachingPractice";
      import {CoachSchedule} from "@/app/coaching/CoachSchedule";
      const calendar={role:"coach",coach:{id:"coach",name:"Coach"},viewerTimeZone:"UTC",availabilityRev:7,
        availability:{enabled:true,timeZone:"UTC",durations:[60],windows:[{day:1,startMinute:540,endMinute:600}],updatedAt:"2026-10-01"},bookings:[],unreadAlerts:[],slots:[]};
      function Fixture(){const [data,setData]=useState(calendar);return <ToastProvider><main className="mx-auto max-w-6xl p-4 pb-40">
        <h1 className="mb-5 text-h2">Coaching form fixture</h1>
        {location.pathname==="/schedule"?<CoachSchedule data={data} localTimeZone="UTC" active refresh={async(next)=>{if(next)setData(next);return next??data;}}/>:<CoachingPractice role="coach"/>}
      </main></ToastProvider>;} createRoot(document.getElementById("root")).render(<Fixture/>);
    `, loader: "tsx", resolveDir: process.cwd() },
    bundle: true, write: false, minify: true, format: "iife", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
    define: { "process.env": "{}", "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "explicit-local-coaching-auth-and-api", setup(builder) {
      builder.onResolve({ filter: /^@clerk\/nextjs$|^@\/lib\/clientApi$|^@\/lib\/useUserSocket$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ resolveDir: process.cwd(), contents:
        args.path === "@clerk/nextjs" ? 'const auth={isLoaded:true,isSignedIn:true,userId:"coach",getToken:async()=>"fixture-token"};export const useAuth=()=>auth;'
          : args.path === "@/lib/useUserSocket" ? 'export const useUserSocket=()=>{};'
            : `export {boundedApiRequest,useOwnerRequestScope} from "./lib/clientApi.ts";
              export const API_BASE="https://coaching-fixture.local";
              const students=[{id:"alex",name:"Alex",userId:"alex-user"},{id:"blair",name:"Blair",userId:"blair-user"}];
              const roster={state:{students}};const sharing={rev:1,relationships:students.map(student=>({student,coach:{id:"coach",name:"Coach"},status:"accepted"}))};
              const assignments={assignments:[],page:1,hasMore:false};const observed={games:[]};const mutate=async()=>{};
              export const useApi=(path)=>({data:!path?undefined:path==="/v1/coaching/state"?roster:path==="/v1/coaching/practice-sharing"?sharing:path.includes("/assignments?")?assignments:observed,mutate,isLoading:false});
              export const apiCall=async(token,path,options)=>{const response=await fetch(path,{...options,headers:{"Content-Type":"application/json"}});const data=await response.json();if(!response.ok)throw data;return data;};` }));
    } }],
  }).then((result) => result.outputFiles[0].text);
}

/** Actual coaching components and production CSS/fonts; every request stays intercepted locally.
 * @param {import('@playwright/test').Page} page
 * @param {{schedule?:boolean,failFirstSave?:boolean,blockedStorage?:boolean}} options
 */
export async function openCoachingFormsFixture(page, options = {}) {
  const script = await fixtureBundle();
  const cssRoot = path.join(process.cwd(), ".next/static/css");
  const sheets = (await readdir(cssRoot, { recursive: true })).filter((file) => file.endsWith(".css"));
  const css = (await Promise.all(sheets.map((file) => readFile(path.join(cssRoot, file), "utf8")))).join("\n");
  const fonts = [...css.matchAll(/\.(__variable_[a-z0-9]+)\{/g)].map((match) => match[1]).join(" ");
  const calls = [];
  await page.addInitScript(({ blocked }) => {
    if (blocked) {
      Storage.prototype.getItem = () => { throw new Error("Storage is blocked"); };
      Storage.prototype.setItem = () => { throw new Error("Storage is blocked"); };
    } else localStorage.setItem("sc2tools:coaching:tz:alex", "Europe/Berlin");
  }, { blocked: Boolean(options.blockedStorage) });
  await page.route("https://coaching-fixture.local/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: script });
    if (url.pathname === "/fixture.css") return route.fulfill({ contentType: "text/css; charset=utf-8", body: css });
    if (url.pathname.startsWith("/_next/static/media/")) return route.fulfill({ contentType: "font/woff2", body: await readFile(path.join(process.cwd(), ".next/static/media", path.basename(url.pathname))) });
    if (url.pathname.startsWith("/v1/")) {
      const body = route.request().postDataJSON(); calls.push({ path: url.pathname, body });
      if (options.failFirstSave && calls.length === 1) return route.fulfill({ status: 503, json: { message: "The fixture connection was interrupted. Try again." } });
      return route.fulfill({ json: options.schedule ? { role: "coach", coach: { id: "coach", name: "Coach" }, viewerTimeZone: "UTC", availabilityRev: 8,
        availability: { ...body, enabled: true, updatedAt: "2026-10-23" }, bookings: [], unreadAlerts: [], slots: [] } : {} });
    }
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body class="${fonts} font-sans"><div id="root"></div><script src="/fixture.js"></script></body></html>` });
  });
  await page.goto(`https://coaching-fixture.local/${options.schedule ? "schedule" : "practice"}`);
  return calls;
}
