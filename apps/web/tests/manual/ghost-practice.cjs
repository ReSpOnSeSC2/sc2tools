/* Real practice/settings/grade/widget and app chrome, production CSS/fonts.
 * API/auth/socket boundaries are synthetic and all nonlocal traffic is blocked. */
const fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const { execFileSync } = require("node:child_process"), { chromium, expect } = require("@playwright/test");
execFileSync(process.execPath, ["tests/manual/ghost-practice-fixture.cjs"], { stdio: "inherit" });
const origin = "http://127.0.0.1:3256", writes = [], unexpected = [];
const target = { v: 1, name: "TvT Reaper expand", steps: [{ supply: null, t: 30, name: "SupplyDepot" }, { supply: null, t: 65, name: "Barracks" }, { supply: null, t: 120, name: "CommandCenter" }], sourceGameId: "recorded-reference" };
let prefs;
const css = fs.readdirSync(".next/static/css", { recursive: true }).filter(name => name.endsWith(".css")).map(name => fs.readFileSync(path.join(".next/static/css", name), "utf8")).join("\n");
const fonts = "@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay;--font-serif:serif}.ghost-fixture-preview .widget-shell{position:relative!important;left:0!important;top:0!important;bottom:auto!important;transform:none!important;width:100%!important;max-width:100%!important}";
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, origin), p = url.pathname;
  const json = (data, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(data)); };
  if (p.startsWith("/v1/")) {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    if (req.method !== "GET") writes.push({ path: p, method: req.method, body });
    if (p === "/v1/me/preferences/ghost") {
      if (req.method === "GET") return json(prefs);
      if (req.method === "PATCH") {
        const slots = { ...prefs.slots };
        if (body.onlyEmpty) { for (const [key, value] of Object.entries(body.merge.slots)) if (!slots[key]) slots[key] = value; }
        else if (body.target) slots[body.matchup] = body.target; else delete slots[body.matchup];
        prefs = { v: 2, slots, revision: prefs.revision + 1 }; return json(prefs);
      }
    }
    if (req.method !== "GET") { unexpected.push(p); return json({ error: { code: "unexpected_fixture_write" } }, 405); }
    if (p === "/v1/me/ghost-builds") return json({ v: 1, slots: { TvT: target }, references: { ref: { buildKey: "tvt-reaper", matchup: "TvT", side: "you", target } } });
    if (p === "/v1/site/banner") return json({ banner: null });
    if (p === "/v1/ping") return json({ ok: true });
    if (p === "/v1/me") return json({ userId: "synthetic-local-fixture", games: { total: 14 } });
    if (p === "/v1/coaching/me") return json({ role: "none" });
    if (p.endsWith("/unread-count")) return json({ count: 0 });
    return json({});
  }
  if (p === "/api/site/stats") return json({ agentDownloads: 42, activeAgents: 0, activeUsers: 1, generatedAt: new Date().toISOString(), activityWindowSeconds: 60 });
  if (p === "/fixture.js") { res.setHeader("content-type", "text/javascript"); return res.end(fs.readFileSync(".tmp/ghost-practice-fixture.js")); }
  if (p.startsWith("/fonts/")) { res.setHeader("content-type", "font/woff2"); return res.end(fs.readFileSync(path.join("app", p))); }
  if (p === "/builds/tvt-reaper") {
    res.setHeader("content-type", "text/html;charset=utf-8");
    return res.end(`<!doctype html><html data-theme="${url.searchParams.get("theme") === "dark" ? "dark" : "light"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${fonts}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  }
  const assetRoot = path.resolve("public"), asset = path.resolve(assetRoot, "." + p);
  if (asset.startsWith(assetRoot + path.sep) && fs.existsSync(asset) && fs.statSync(asset).isFile()) { res.setHeader("content-type", ({ ".webp": "image/webp", ".png": "image/png", ".svg": "image/svg+xml" })[path.extname(asset)] || "application/octet-stream"); return res.end(fs.readFileSync(asset)); }
  res.statusCode = 404; res.end();
});

(async () => {
  await new Promise(resolve => server.listen(3256, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true }); let checks = 0;
  try {
    for (const width of [375, 1440]) for (const theme of ["light", "dark"]) {
      prefs = { v: 2, slots: { TvT: target }, revision: 1 };
      const contexts = [];
      const make = async () => {
        const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: "reduce" }); contexts.push(context);
        await context.route("**/*", route => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
        const page = await context.newPage(); const errors = []; page.on("pageerror", error => errors.push(error.message)); return { page, errors };
      };
      const { page, errors } = await make();
      await page.addInitScript(() => { localStorage.setItem("sc2tools:ghost-build:armed", "__LEGACY__"); });
      // Supply the exact legacy codec instead of teaching the fixture another serializer.
      await page.goto(`${origin}/builds/tvt-reaper?theme=${theme}`);
      await expect(page.getByRole("button", { name: "Practice in TvT", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: /Practicing: TvT Reaper expand/ })).toBeVisible();
      await expect(page.getByTestId("ghost-grade-card")).toBeVisible(); checks += 3;
      const beforeMigration = writes.length;
      await expect(page.getByRole("button", { name: "Move assignments" })).toBeVisible();
      expect(writes.length).toBe(beforeMigration);
      await page.getByRole("button", { name: "Move assignments" }).click();
      await expect(page.getByRole("button", { name: "Move assignments" })).toHaveCount(0);
      expect(writes.at(-1).body.onlyEmpty).toBe(true); expect(prefs.slots.TvT.name).toBe(target.name); checks += 3;
      const before = writes.length;
      await page.getByRole("button", { name: "Practice in TvT", exact: true }).click();
      await expect(page.getByText(/Your Ghost URL updates automatically/)).toBeVisible();
      expect(writes.length).toBe(before + 1); expect(writes.at(-1).body.matchup).toBe("TvT"); checks += 2;
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: `../../docs/handoff/screenshots/ghost-practice-settings-${theme}-${width}.png` });
      await page.getByRole("button", { name: "Practice options for TvT Reaper expand" }).click();
      const dialog = page.getByRole("dialog"); await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("combobox")).toHaveValue("TvT");
      await dialog.getByRole("combobox").selectOption("TvZ");
      await dialog.getByRole("button", { name: "Practice in TvZ" }).click();
      await expect(dialog.getByText(/Your Ghost URL updates automatically/)).toBeVisible();
      expect(Object.keys(prefs.slots).sort()).toEqual(["TvT", "TvZ"]); checks += 3;
      await page.screenshot({ path: `../../docs/handoff/screenshots/ghost-practice-options-${theme}-${width}.png` });
      await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); checks++;
      const second = await make(); await second.page.goto(`${origin}/builds/tvt-reaper?theme=${theme}`);
      await expect(second.page.getByRole("link", { name: /Practicing: TvT Reaper expand.*\+1/ })).toBeVisible();
      expect(await second.page.evaluate(() => localStorage.getItem("sc2tools:ghost-build:armed"))).toBeNull(); checks += 2;
      await page.getByRole("button", { name: "Disarm TvT practice" }).click();
      await expect(page.getByRole("link", { name: /Practicing: TvT Reaper expand \(TvZ\)/ })).toBeVisible();
      await page.getByRole("button", { name: "Disarm TvZ practice" }).click();
      await expect(page.getByRole("link", { name: /Practicing:/ })).toHaveCount(0);
      await second.page.evaluate(() => dispatchEvent(new Event("fixture-ghost")));
      await expect(second.page.getByRole("link", { name: /Practicing:/ })).toHaveCount(0);
      await expect(second.page.getByTestId("ghost-preview")).toHaveText(""); checks += 4;
      const writesBeforeAuth = writes.length;
      await page.evaluate(() => { window.fixtureHeldToken = new Promise(resolve => { window.releaseHeldToken = resolve; }); });
      await page.getByRole("button", { name: "Practice in TvT", exact: true }).click();
      await page.evaluate(() => window.fixtureAuth(null, false));
      await page.evaluate(() => window.releaseHeldToken("synthetic-old-session"));
      await page.waitForTimeout(100); expect(writes.length).toBe(writesBeforeAuth); checks++;
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.locator('img[src="/logo-64.webp"]').evaluateAll(nodes => nodes.length > 0 && nodes.every(node => node.complete && node.naturalWidth > 0))).toBe(true);
      expect(errors).toEqual([]); expect(second.errors).toEqual([]); checks += 4;
      await Promise.all(contexts.map(context => context.close())); console.log(JSON.stringify({ width, theme, checks }));
    }
    expect(unexpected).toEqual([]); console.log(JSON.stringify({ checks, syntheticLocalWrites: writes.length, nonlocalTraffic: "blocked" }));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
