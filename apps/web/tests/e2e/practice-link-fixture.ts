import { build } from "esbuild";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";

let bundlePromise: Promise<string> | undefined;
function bundle() {
  bundlePromise ??= build({
    entryPoints: ["tests/e2e/practice-link-entry.tsx"], bundle: true, write: false,
    format: "iife", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    plugins: [{ name: "local-replay-session-fixture", setup(builder) {
      builder.onResolve({ filter: /^@\/lib\/instant\/useInstantSession$/ }, () => ({
        path: path.resolve("tests/e2e/practice-link-session.ts"),
      }));
    } }],
  }).then(result => result.outputFiles[0].text);
  return bundlePromise;
}

export async function openPracticeLinkFixture(page: Page, request: APIRequestContext, theme: string, empty = false) {
  const root = path.resolve(".next/static/css");
  const files = (await readdir(root, { recursive: true })).filter(file => file.endsWith(".css"));
  const [js, css, shell] = await Promise.all([
    bundle(), Promise.all(files.map(file => readFile(path.join(root, file), "utf8"))), request.get("/").then(response => response.text()),
  ]);
  const html = /<html[^>]*class="([^"]*)"/.exec(shell)?.[1] ?? "";
  const body = /<body[^>]*class="([^"]*)"/.exec(shell)?.[1] ?? "";
  await page.route("https://practice-fixture.local/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/fixture.css") return route.fulfill({ contentType: "text/css", body: css.join("\n") });
    if (pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: js });
    if (/^\/_next\/static\/media\/[a-zA-Z0-9._-]+\.woff2$/.test(pathname)) {
      const font = await request.get(pathname);
      return route.fulfill({ status: font.status(), contentType: "font/woff2", body: await font.body() });
    }
    if (pathname !== "/b/fixture") return route.fulfill({ status: 404 });
    return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en" class="${html}" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Practice Link fixture</title><link rel="stylesheet" href="/fixture.css"></head><body class="${body}"><div id="root"></div><script src="/fixture.js"></script></body></html>` });
  });
  await page.route("https://www.youtube.com/iframe_api", route => route.fulfill({ contentType: "text/javascript", body: `
    window.YT = { PlayerState: { PLAYING: 1, ENDED: 0 }, Player: class {
      constructor(frame, config) {
        this.seconds = Number(new URL(frame.src).searchParams.get('start'));
        queueMicrotask(() => config.events.onReady({ target: this }));
      }
      getCurrentTime() { return this.seconds; }
      seekTo(seconds) { this.seconds = seconds; }
      destroy() {}
    } };
    window.onYouTubeIframeAPIReady();
  ` }));
  await page.route("https://www.youtube-nocookie.com/embed/**", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><head><title>Fixture video</title></head><body><p>Fixture video</p></body></html>' }));
  await page.goto(`https://practice-fixture.local/b/fixture${empty ? "?empty=1" : ""}`);
}
