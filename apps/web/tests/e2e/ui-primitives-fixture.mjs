import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import loadConfig from "tailwindcss/loadConfig.js";

const ORIGIN = "https://ui-primitives-fixture.local";
const SOURCE = `
  import React,{useRef,useState} from "react";
  import {createRoot} from "react-dom/client";
  import {Button} from "@/components/ui/Button";
  import {Modal} from "@/components/ui/Modal";
  import {Sheet} from "@/components/ui/Sheet";
  import {Popover} from "@/components/ui/Popover";
  import {IconButton} from "@/components/ui/IconButton";
  import {CopyButton} from "@/components/ui/CopyButton";
  import {useConfirm} from "@/components/ui/useConfirm";
  import {SkeletonChart,SkeletonKpi} from "@/components/ui/Skeleton";
  import {ToastProvider,useToast} from "@/components/ui/Toast";

  function KeyboardFixture(){
    const [open,setOpen]=useState(false),[choice,setChoice]=useState("No choice yet");
    const summary=useRef(null);const confirmation=useConfirm("local-fixture");
    return <>
      <Button onClick={()=>setOpen(true)}>Open keyboard dialog</Button>
      <Button onClick={async()=>setChoice(await confirmation.confirm({title:"Confirm local choice",description:"Only local fixture state changes.",confirmLabel:"Continue",focusCancel:true})?"Accepted":"Cancelled")}>Confirm local choice</Button>
      <output aria-label="Local choice">{choice}</output>
      <Modal open={open} onClose={()=>setOpen(false)} title="Keyboard dialog" hideClose initialFocusRef={summary}>
        <div className="space-y-4">
          <Button>First action</Button>
          <details><summary ref={summary}>Closed details summary</summary>
            <Button>Hidden details action</Button><input aria-label="Hidden details input" />
          </details>
          <Button>Last action</Button>
        </div>
      </Modal>
      {confirmation.dialog}
    </>;
  }

  function PopupActions({onUnmount}){
    const [child,setChild]=useState(false),[done,setDone]=useState(false);const {toast}=useToast();
    return <div className="space-y-3"><Button>First popup action</Button>
      <Button onClick={()=>setChild(true)}>Open popup modal</Button>
      <Button onClick={onUnmount}>Unmount dialog tree</Button>
      <Modal open={child} onClose={()=>setChild(false)} title="Popup child modal">
        <Button onClick={()=>{setDone(true);toast.success("Local child action completed",{duration:null});}}>Run child action</Button>
        <output aria-label="Child result">{done?"Child action completed":"Waiting"}</output>
      </Modal>
    </div>;
  }

  function LayeredParent({onClose,onUnmount,pointerMode=false}){
    const [popup,setPopup]=useState(false),[strategy,setStrategy]=useState("Balanced");const anchor=useRef(null),first=useRef(null);
    return <Modal open onClose={onClose} title="Parent modal" hideClose disableScrimClose initialFocusRef={first}>
      <div className="space-y-3">
        <Button ref={first}>First parent action</Button>
        <fieldset className="flex flex-wrap gap-3"><legend>Fixture strategy</legend>
          {["Safe","Balanced","Aggressive"].map(value=><label key={value} className="inline-flex items-center gap-2">
            <input type="radio" name="fixture-strategy" value={value} checked={strategy===value} onChange={()=>setStrategy(value)}/>{value}</label>)}
        </fieldset>
        <IconButton ref={anchor} aria-label="Open popup" aria-expanded={popup} aria-controls="fixture-popup" onClick={()=>setPopup(!popup)}><span>⋮</span></IconButton>
        <p className="ml-auto w-fit">Plain parent text</p>
        <label className="ml-auto block w-36">Outside text input<input aria-label="Outside text input" className="block w-full rounded border border-border bg-bg-surface p-2"/></label>
        <Button className="ml-auto flex w-fit">Last parent action</Button>
      </div>
      {/* This custom host intentionally has no transform/isolation/stacking context. */}
      <Popover open={popup} onClose={()=>setPopup(false)} anchorRef={anchor} label="Layered popup" id="fixture-popup" width={pointerMode?180:352} portalContainer={document.getElementById("custom-popover-root")}>
        {pointerMode?<Button>Popup action</Button>:<PopupActions onUnmount={onUnmount}/>}
      </Popover>
    </Modal>;
  }

  function LayerFixture({pointerMode=false}){
    const [open,setOpen]=useState(false);
    return <><Button onClick={()=>setOpen(true)}>Open layered dialog</Button>
      {open?<LayeredParent onClose={()=>setOpen(false)} onUnmount={()=>setOpen(false)} pointerMode={pointerMode}/>:null}</>;
  }

  function SheetFixture(){
    const [side,setSide]=useState(null);
    return <><Button onClick={()=>setSide("right")}>Open right sheet</Button>
      <Button onClick={()=>setSide("bottom")}>Open bottom sheet</Button>
      <Sheet open={side!==null} side={side??"bottom"} onClose={()=>setSide(null)} title={side==="right"?"Right sheet":"Bottom sheet"}
        footer={<Button onClick={()=>setSide(null)}>Finish sheet</Button>}>
        <div className="space-y-4">
          <p>These examples only change local fixture state.</p>
          <CopyButton text="Fixture replay notes" fallbackLabel="Fixture text">Copy fixture text</CopyButton>
          <SkeletonChart label="Loading fixture chart"/><SkeletonKpi label="Loading fixture statistics"/>
          <div style={{height:900}} aria-hidden="true"/>
          <p>End of scrollable sheet content.</p>
        </div>
      </Sheet></>;
  }

  function PointerFixture(){
    const [open,setOpen]=useState(false);const anchor=useRef(null);
    return <><LayerFixture pointerMode/><section className="space-y-4">
      <Button ref={anchor} onClick={()=>setOpen(true)}>Open viewport popup</Button>
      <Popover open={open} onClose={()=>setOpen(false)} anchorRef={anchor} label="Viewport popup" width={2400}>
        <div style={{height:1400}}><Button>Viewport popup action</Button><p>Deliberately tall popup content.</p></div>
      </Popover>
      <div style={{height:1800}} aria-hidden="true"/>
    </section></>;
  }

  function Fixture(){const scenario=location.pathname.slice(1);return <main className="mx-auto max-w-3xl space-y-4 p-4">
    <h1 className="text-h2">UI primitive fixture</h1>
    {scenario==="keyboard"?<KeyboardFixture/>:scenario==="layers"?<LayerFixture/>:scenario==="pointer"?<PointerFixture/>:<SheetFixture/>}
  </main>;}
  createRoot(document.getElementById("root")).render(<ToastProvider><Fixture/></ToastProvider>);
`;

let assets;
function fixtureAssets() {
  // Compile current component utilities and real global tokens; a stale .next
  // build must not silently omit a newly added sheet or focus utility.
  return assets ??= (async () => {
    const cwd = process.cwd();
    const result = await build({
      stdin: { contents: SOURCE, loader: "tsx", resolveDir: cwd },
      bundle: true, write: false, minify: true, format: "iife", platform: "browser",
      jsx: "automatic", tsconfig: "tsconfig.json",
      define: { "process.env": "{}", "process.env.NODE_ENV": '"production"' },
    });
    const config = loadConfig(path.join(cwd, "tailwind.config.ts"));
    const globals = path.join(cwd, "app/globals.css");
    const css = await postcss([tailwindcss({ ...config, content: [
      { raw: SOURCE, extension: "tsx" }, path.join(cwd, "components/ui/**/*.{ts,tsx}"),
    ] })]).process(await readFile(globals, "utf8"), { from: globals });
    const definitions = [
      ["FixtureHanken", "hanken-grotesk-latin.woff2", "100 900"],
      ["FixtureBricolage", "bricolage-grotesque-latin.woff2", "600 800"],
      ["FixtureFraunces", "fraunces-latin-normal.woff2", "400 700"],
    ];
    const fonts = new Map(await Promise.all(definitions.map(async ([, file]) => [file, await readFile(path.join(cwd, "app/fonts", file))])));
    const fontCss = definitions.map(([family, file, weight]) => `@font-face{font-family:${family};src:url('/fonts/${file}') format('woff2');font-weight:${weight};font-style:normal;font-display:swap;}`).join("\n")
      + ':root{--font-sans:FixtureHanken;--font-display:FixtureBricolage;--font-serif:FixtureFraunces;}';
    return { script: result.outputFiles[0].text, css: css.css + fontCss, fonts };
  })();
}

/** Real primitives, real Tailwind/global styles, and no server or auth adapters.
 * Invoking this helper compiles the fixture once per Playwright worker.
 * @param {import('@playwright/test').Page} page
 * @param {'keyboard'|'layers'|'sheets'|'pointer'} scenario
 */
export async function openUiPrimitivesFixture(page, scenario) {
  const { script, css, fonts } = await fixtureAssets();
  const errors = [], unexpectedRequests = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async () => { throw new DOMException("Fixture clipboard permission denied", "NotAllowedError"); },
    } });
  });
  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== ORIGIN || request.method() !== "GET") {
      unexpectedRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort();
    }
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: script });
    if (url.pathname === "/fixture.css") return route.fulfill({ contentType: "text/css; charset=utf-8", body: css });
    if (url.pathname.startsWith("/fonts/") && fonts.has(url.pathname.slice(7))) return route.fulfill({ contentType: "font/woff2", body: fonts.get(url.pathname.slice(7)) });
    if (url.pathname === `/${scenario}`) return route.fulfill({ contentType: "text/html; charset=utf-8", body:
      '<!doctype html><html lang="en" data-theme="dark" data-theme-mode="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><div id="custom-popover-root"></div><button type="button" id="portal-between">Outside between portal and modal</button><script src="/fixture.js"></script></body></html>' });
    unexpectedRequests.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 404, body: "Unknown fixture resource" });
  });
  await page.goto(`${ORIGIN}/${scenario}`);
  await page.getByRole("heading", { name: "UI primitive fixture" }).waitFor();
  await page.evaluate(async () => { await document.fonts.ready; });
  return { errors, unexpectedRequests };
}
