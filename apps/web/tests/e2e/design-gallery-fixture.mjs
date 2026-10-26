import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import loadConfig from "tailwindcss/loadConfig.js";

const ORIGIN = "https://design-gallery-fixture.local";
const SOURCE = `import React from "react";import {createRoot} from "react-dom/client";
import {DesignGallery} from "@/app/admin/design/DesignGallery";
createRoot(document.getElementById("root")).render(<main className="mx-auto max-w-6xl p-4"><DesignGallery/></main>);`;
const adapters = {
  "next/link": 'import React from "react";export default React.forwardRef(function Link({prefetch,replace,scroll,...props},ref){return <a {...props} ref={ref}/>;});',
  "next/image": 'import React from "react";export default function Image({unoptimized,priority,fill,...props}){return <img {...props}/>;}',
  "next/navigation": 'export const usePathname=()=>"/admin/design";',
  "@clerk/nextjs": 'export const useAuth=()=>({isLoaded:true,isSignedIn:true,userId:"gallery-fixture"});',
  "@/lib/sentry": 'export const captureException=async()=>null;',
  "@/components/help/LazyHelpLink": 'import React from "react";export const LazyHelpLink=({children,slug,...props})=><a {...props} href={"/help/"+slug}>{children}</a>;',
  "@/components/feedback/LazyReportIssueModal": 'export const LazyReportIssueModal=()=>null;',
};

let assets;
function fixtureAssets() {
  return assets ??= (async () => {
    const cwd = process.cwd();
    const result = await build({ stdin: { contents: SOURCE, loader: "tsx", resolveDir: cwd }, bundle: true,
      write: false, minify: true, format: "iife", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
      define: { "process.env": "{}", "process.env.NODE_ENV": '"production"' },
      plugins: [{ name: "explicit-gallery-fixture-boundaries", setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => adapters[args.path] ? { path: args.path, namespace: "gallery-adapter" } : undefined);
        builder.onLoad({ filter: /.*/, namespace: "gallery-adapter" }, args => ({ contents: adapters[args.path], loader: "tsx", resolveDir: cwd }));
      } }],
    });
    const config = loadConfig(path.join(cwd, "tailwind.config.ts"));
    const globals = path.join(cwd, "app/globals.css");
    const css = await postcss([tailwindcss({ ...config, content: [{ raw: SOURCE, extension: "tsx" },
      path.join(cwd, "app/admin/design/**/*.tsx"), path.join(cwd, "components/ui/**/*.{ts,tsx}")],
    })]).process(await readFile(globals, "utf8"), { from: globals });
    const definitions = [["GalleryHanken", "hanken-grotesk-latin.woff2", "100 900"],
      ["GalleryBricolage", "bricolage-grotesque-latin.woff2", "600 800"], ["GalleryFraunces", "fraunces-latin-normal.woff2", "400 700"]];
    const fonts = new Map(await Promise.all(definitions.map(async ([, file]) => [file, await readFile(path.join(cwd, "app/fonts", file))])));
    const fontCss = definitions.map(([family, file, weight]) => `@font-face{font-family:${family};src:url('/fonts/${file}') format('woff2');font-weight:${weight};font-style:normal;font-display:swap;}`).join("\n")
      + ':root{--font-sans:GalleryHanken;--font-display:GalleryBricolage;--font-serif:GalleryFraunces;}';
    return { script: result.outputFiles[0].text, css: css.css + fontCss, fonts };
  })();
}

/** Actual gallery/primitives/CSS/fonts. Next navigation/image, Clerk, Help/report
 * and Sentry are explicit fixture adapters; the separate server tests prove
 * authorization. Every request is intercepted; clipboard access is denied.
 * @param {import('@playwright/test').Page} page
 * @param {'light'|'dark'} theme
 */
export async function openDesignGalleryFixture(page, theme) {
  const { script, css, fonts } = await fixtureAssets();
  const errors = [], unexpectedRequests = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { configurable: true,
    value: { writeText: async () => { throw new DOMException("Fixture permission denied", "NotAllowedError"); } },
  }));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== ORIGIN || request.method() !== "GET") {
      unexpectedRequests.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort();
    }
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: script });
    if (url.pathname === "/fixture.css") return route.fulfill({ contentType: "text/css", body: css });
    if (url.pathname.startsWith("/fonts/") && fonts.has(url.pathname.slice(7))) return route.fulfill({ contentType: "font/woff2", body: fonts.get(url.pathname.slice(7)) });
    if (url.pathname.startsWith("/icons/") && !url.pathname.includes("..")) {
      const publicRoot = path.resolve(process.cwd(), "public"), icon = path.resolve(publicRoot, url.pathname.slice(1));
      if (icon.startsWith(publicRoot + path.sep)) {
        try { return route.fulfill({ contentType: "image/png", body: await readFile(icon) }); } catch { /* Unexpected paths are reported below. */ }
      }
    }
    if (url.pathname === "/admin/design") return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en" data-theme="${theme}" data-theme-mode="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Design gallery fixture</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>` });
    unexpectedRequests.push(`${request.method()} ${url.pathname}`); return route.fulfill({ status: 404, body: "Unknown fixture resource" });
  });
  await page.goto(`${ORIGIN}/admin/design`);
  await page.getByRole("heading", { name: "Design gallery", exact: true }).waitFor();
  await page.evaluate(async () => { await document.fonts.ready; });
  return { errors, unexpectedRequests };
}
