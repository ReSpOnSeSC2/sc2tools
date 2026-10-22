import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  PERF_BUDGET_FILE,
  checkBudgets,
  formatReport,
  measureRoutes,
  routeForManifestKey,
  routeScripts,
} from "@/scripts/check-perf-budget.mjs";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fake `.next` with an app-build-manifest and the chunk files it names. */
function fakeBuild(files: Record<string, string>, pages: Record<string, string[]>): string {
  const dist = mkdtempSync(path.join(tmpdir(), "perf-budget-"));
  dirs.push(dist);
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dist, file)), { recursive: true });
    writeFileSync(path.join(dist, file), body);
  }
  writeFileSync(path.join(dist, "app-build-manifest.json"), JSON.stringify({ pages }));
  return dist;
}

describe("routeForManifestKey", () => {
  it("maps page entries to URL routes and skips everything else", () => {
    expect(routeForManifestKey("/page")).toBe("/");
    expect(routeForManifestKey("/app/[section]/page")).toBe("/app/[section]");
    expect(routeForManifestKey("/reviews/(board)/page")).toBe("/reviews");
    expect(routeForManifestKey("/dashboard/@modal/page")).toBe("/dashboard");
    expect(routeForManifestKey("/api/ping/route")).toBeNull();
    expect(routeForManifestKey("/manifest.webmanifest/route")).toBeNull();
    expect(routeForManifestKey("/layout")).toBeNull();
  });
});

describe("routeScripts", () => {
  it("keeps each route's script files once, without stylesheets", () => {
    const routes = routeScripts({
      pages: {
        "/page": ["static/chunks/main.js", "static/css/a.css", "static/chunks/home.js", "static/chunks/main.js"],
        "/api/ping/route": ["static/chunks/main.js"],
      },
    });
    expect([...routes.entries()]).toEqual([["/", ["static/chunks/main.js", "static/chunks/home.js"]]]);
  });
});

describe("measureRoutes", () => {
  it("sums the gzip size of each route's first-load scripts", () => {
    const shared = "console.log('shared runtime');".repeat(40);
    const home = "export const home = 1;";
    const dist = fakeBuild(
      { "static/chunks/shared.js": shared, "static/chunks/home.js": home, "static/css/x.css": "a{}" },
      {
        "/page": ["static/chunks/shared.js", "static/chunks/home.js", "static/css/x.css"],
        "/settings/page": ["static/chunks/shared.js"],
      },
    );
    const gz = (text: string) => gzipSync(Buffer.from(text), { level: 9 }).length;
    const measured = measureRoutes(dist);
    expect(measured.get("/")).toBe(gz(shared) + gz(home));
    expect(measured.get("/settings")).toBe(gz(shared));
  });
});

describe("checkBudgets", () => {
  const budget = { default: 300, routes: { "/": 200, "/app/[section]": 260 } };

  it("passes when every route is within its budget and every listed route exists", () => {
    const result = checkBudgets(
      new Map([
        ["/", 199_000],
        ["/app/[section]", 150_000],
        ["/donate", 120_000],
      ]),
      budget,
    );
    expect(result.ok).toBe(true);
    expect(result.rows.map((row) => [row.route, row.kb, row.budgetKb])).toEqual([
      ["/", 199, 200],
      ["/app/[section]", 150, 260],
      ["/donate", 120, 300],
    ]);
  });

  it("fails a listed route over its budget and an unlisted route over the default", () => {
    const result = checkBudgets(
      new Map([
        ["/", 200_100],
        ["/app/[section]", 150_000],
        ["/admin", 300_500],
      ]),
      budget,
    );
    expect(result.ok).toBe(false);
    expect(result.rows.filter((row) => row.over).map((row) => row.route)).toEqual(["/", "/admin"]);
    const report = formatReport(result, budget);
    expect(report).toContain("Over budget:");
    expect(report).toMatch(/OVER\s+\/admin\s+300\.5 \/ 300/);
  });

  it("fails when a listed route is missing from the build", () => {
    const result = checkBudgets(new Map([["/", 100_000]]), budget);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["/app/[section]"]);
    expect(formatReport(result, budget)).toContain("not in this build");
  });
});

describe("perf-budget.json", () => {
  it("has a default and positive kB budgets for real-looking routes", () => {
    const budget = JSON.parse(readFileSync(PERF_BUDGET_FILE, "utf8")) as {
      default: number;
      routes: Record<string, number>;
    };
    expect(budget.default).toBeGreaterThan(0);
    for (const [route, kb] of Object.entries(budget.routes)) {
      expect(route).toMatch(/^\/[^\s?#]*$/);
      expect(kb).toBeGreaterThan(0);
      expect(kb).toBeLessThanOrEqual(budget.default);
    }
    // The routes this budget exists to protect.
    expect(budget.routes["/app/[section]"]).toBeDefined();
    expect(budget.routes["/settings"]).toBeDefined();
  });
});
