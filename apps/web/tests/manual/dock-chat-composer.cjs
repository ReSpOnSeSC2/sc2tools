/* Local browser verification: real chat/composer, synthetic sends, no provider traffic. */
const fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const esbuild = require("esbuild"), { execFileSync } = require("node:child_process");
const { chromium, expect } = require("@playwright/test");
const axe = require("axe-core");
const root = process.cwd(), output = path.resolve(root, "../../output/dock-chat-composer");
const origin = "http://127.0.0.1:3266";
fs.mkdirSync(output, { recursive: true }); fs.mkdirSync(".tmp", { recursive: true });
const entry = `import React from'react';import{createRoot}from'react-dom/client';import{DockChat}from'@/components/dock/DockChat';import{DockChatComposer}from'@/components/dock/DockChatComposer';import{DockBlockedUsers}from'@/components/dock/DockBlockedUsers';
const platforms={twitch:{enabled:true,channel:'streamer'},kick:{enabled:true,channel:'streamer',chatroomId:42},youtube:{enabled:true,channel:'@streamer'},tiktok:{enabled:true,username:'streamer'}};
const messages=[{platform:'twitch',id:'1',user:'Aurora',text:'Crystal Ball is OPEN! Type !win or !loss now.',atMs:Date.now(),badges:[]},{platform:'youtube',id:'2',user:'Viewer',text:'Hello from YouTube',atMs:Date.now(),badges:[]},{platform:'tiktok',id:'3',user:'AnotherViewer',text:'Great hold at the natural!',atMs:Date.now(),badges:[]}];
createRoot(document.getElementById('root')).render(<main className="min-w-0 bg-bg p-2 text-text"><DockChat embedded loaded platforms={platforms} messages={messages} statuses={{twitch:{state:'connected'},kick:{state:'connected'},youtube:{state:'connected'},tiktok:{state:'connected'}}} blockedUsers={[]} busy={false} onBlock={()=>{}} onHighlight={()=>{}} composer={<DockChatComposer token="synthetic-dock" platforms={platforms} loaded onInvalid={()=>{}}/>}/><DockBlockedUsers users={['spam']} managedUsers={[]} busy={false} ready onUnblock={()=>{}}/></main>);`;
fs.writeFileSync(".tmp/dock-chat-composer.tsx", entry);
const boundaries = { "@/lib/clientApi": `export const API_BASE=${JSON.stringify(origin)};export const boundedApiRequest=(op,ms,signal)=>op(signal);export const buildApiError=async res=>({status:res.status,...(await res.json()).error});` };
async function run() {
  console.log("Bundling chat fixture");
  await esbuild.build({ entryPoints: [".tmp/dock-chat-composer.tsx"], bundle: true, outfile: ".tmp/dock-chat-composer.js", alias: { "@": root }, jsx: "automatic",
    define: { "process.env": "{}", "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "local-api", setup(build) {
      build.onResolve({ filter: /.*/ }, args => boundaries[args.path] ? { path: args.path, namespace: "boundary" } : undefined);
      build.onLoad({ filter: /.*/, namespace: "boundary" }, args => ({ contents: boundaries[args.path], loader: "js", resolveDir: root }));
    } }] });
  if (!process.argv.includes("--reuse-css") || !fs.existsSync(".tmp/dock-chat-composer-tailwind.css")) {
    console.log("Compiling chat styles");
    execFileSync(process.execPath, ["node_modules/tailwindcss/lib/cli.js", "-i", "app/globals.css", "-o", ".tmp/dock-chat-composer-tailwind.css", "--minify"], { stdio: "pipe" });
  }
  const css = fs.readFileSync(".tmp/dock-chat-composer-tailwind.css", "utf8") + fs.readFileSync(".tmp/dock-chat-composer.css", "utf8");
  const fonts = "@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay}";
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    if (url.pathname === "/fonts/hanken-grotesk-latin.woff2" || url.pathname === "/fonts/bricolage-grotesque-latin.woff2") {
      res.setHeader("Content-Type", "font/woff2"); return res.end(fs.readFileSync(path.join(root, "app", url.pathname)));
    }
    if (url.pathname.endsWith("/chat")) {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "POST") {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks)); calls.push(body);
        return res.end(JSON.stringify({ results: body.platforms.map(platform => ({ platform, status: platform === "twitch" ? "queued" : "sent" })) }));
      }
      return res.end(JSON.stringify({ platforms: [{ platform: "twitch", available: true, identity: "streamerbot", maxLength: 450 },
        { platform: "kick", available: true, identity: "streamer", maxLength: 500 }, { platform: "youtube", available: true, identity: "streamer", maxLength: 200 },
        { platform: "tiktok", available: false, reason: "TikTok chat is receive-only in this Dock. Reply through TikTok LIVE.", maxLength: 200 }] }));
    }
    if (url.pathname === "/fixture.js") { res.setHeader("Content-Type", "text/javascript"); return res.end(fs.readFileSync(".tmp/dock-chat-composer.js")); }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html lang="en" data-theme="${url.searchParams.get("theme") === "light" ? "light" : "dark"}"><head><title>Chat composer test</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  });
  await new Promise(resolve => server.listen(3266, "127.0.0.1", resolve));
  let browser;
  try {
    console.log("Launching local browser");
    browser = await chromium.launch({ headless: true });
    for (const width of [300, 390, 1280]) for (const theme of ["dark", "light"]) {
      const context = await browser.newContext({ viewport: { width, height: 779 }, hasTouch: width < 1000 });
      await context.route("**/*", route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
      const page = await context.newPage(), errors = []; page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
      await page.goto(`${origin}/?theme=${theme}`);
      await page.evaluate(() => document.fonts.ready);
      const input = page.getByRole("textbox", { name: "Chat message" });
      await expect(page.getByRole("checkbox", { name: "Send to Twitch" })).toBeEnabled();
      await expect(input).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: path.join(output, `chat-${theme}-${width}.png`) });
      await input.fill("Hello everyone!"); await input.press("Enter");
      await expect(page.getByText("YouTube: Sent")).toBeVisible();
      expect(calls.at(-1)).toEqual({ text: "Hello everyone!", platforms: ["twitch", "kick", "youtube"] });
      await page.getByRole("checkbox", { name: "Send to Kick" }).uncheck();
      await page.getByRole("checkbox", { name: "Send to YouTube" }).uncheck();
      await input.fill("Twitch only"); await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(input).toHaveValue(""); expect(calls.at(-1).platforms).toEqual(["twitch"]);
      await page.getByText("Chat sending setup", { exact: true }).click();
      await expect(page.getByText(/TikTok chat is receive-only/)).toBeVisible();
      await page.addScriptTag({ content: axe.source });
      const violations = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } })).violations.map(issue => ({ id: issue.id, targets: issue.nodes.map(node => node.target) })));
      expect(violations).toEqual([]); expect(errors).toEqual([]);
      console.log(JSON.stringify({ width, theme, passed: true })); await context.close();
    }
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
