#!/usr/bin/env node
/**
 * check-perf-budget — fails when a route's first-load JavaScript grows
 * past its budget in perf-budget.json.
 *
 *   npm run build && npm run perf:budget      (from apps/web)
 *
 * "First-load JS" is what the "First Load JS" column of `next build`
 * shows: the gzip size of every script a route's HTML loads before it is
 * interactive (`.next/app-build-manifest.json`: the shared runtime plus
 * the route's own entry chunks). Code behind next/dynamic is not counted:
 * it loads later, only when it is shown.
 *
 * Every route the budget file lists must exist in the build, so a renamed
 * route fails loudly instead of silently dropping out of the check.
 * Routes it does not list are held to its `default`.
 *
 * lib/__tests__/perfBudget.test.ts imports the pure functions below.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The budget file, next to package.json. */
export const PERF_BUDGET_FILE = path.join(webRoot, "perf-budget.json");

/** Where `next build` writes its output. */
export const NEXT_DIST_DIR = path.join(webRoot, ".next");

/** kB as `next build` prints it (1 kB = 1000 bytes). */
const BYTES_PER_KB = 1000;

/**
 * The URL route for an app-build-manifest key, or null for anything that
 * is not a page (route handlers, metadata routes). Route groups and
 * parallel-route slots are dropped, as in the URL.
 *
 * Example: `routeForManifestKey("/reviews/(board)/page")` → "/reviews".
 */
export function routeForManifestKey(key) {
  const segments = key.split("/").filter(Boolean);
  if (segments.at(-1) !== "page") return null;
  const kept = segments
    .slice(0, -1)
    .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")) && !segment.startsWith("@"));
  return `/${kept.join("/")}`;
}

/**
 * Script files each route loads first, keyed by URL route.
 *
 * Example: `routeScripts({ pages: { "/page": ["static/chunks/a.js", "static/css/a.css"] } })`
 * → Map { "/" => ["static/chunks/a.js"] }.
 */
export function routeScripts(appBuildManifest) {
  const routes = new Map();
  for (const [key, files] of Object.entries(appBuildManifest.pages ?? {})) {
    const route = routeForManifestKey(key);
    if (route === null) continue;
    const scripts = files.filter((file) => file.endsWith(".js"));
    routes.set(route, [...new Set([...(routes.get(route) ?? []), ...scripts])]);
  }
  return routes;
}

/**
 * Gzip size in bytes of every route's first-load scripts, read from a
 * build directory. Each file is compressed once however many routes share it.
 *
 * Example: `measureRoutes(".next")` → Map { "/" => 191234, "/app" => 216002, … }.
 */
export function measureRoutes(distDir = NEXT_DIST_DIR) {
  const manifest = JSON.parse(readFileSync(path.join(distDir, "app-build-manifest.json"), "utf8"));
  const sizes = new Map();
  const gzipSize = (file) => {
    if (!sizes.has(file)) {
      sizes.set(file, gzipSync(readFileSync(path.join(distDir, file)), { level: 9 }).length);
    }
    return sizes.get(file);
  };
  const measured = new Map();
  for (const [route, scripts] of routeScripts(manifest)) {
    measured.set(route, scripts.reduce((total, file) => total + gzipSize(file), 0));
  }
  return measured;
}

/**
 * Compare measured sizes with a budget. `rows` is sorted by route;
 * `missing` lists budgeted routes the build does not have.
 *
 * Example:
 *   checkBudgets(new Map([["/", 250000]]), { default: 500, routes: { "/": 215 } })
 *   → { rows: [{ route: "/", kb: 250, budgetKb: 215, over: true }], missing: [], ok: false }
 */
export function checkBudgets(measured, budget) {
  const listed = budget.routes ?? {};
  const rows = [...measured.entries()]
    .map(([route, bytes]) => {
      const budgetKb = listed[route] ?? budget.default;
      const kb = Math.round((bytes / BYTES_PER_KB) * 10) / 10;
      return { route, kb, budgetKb, over: kb > budgetKb };
    })
    .sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));
  const missing = Object.keys(listed).filter((route) => !measured.has(route));
  return { rows, missing, ok: missing.length === 0 && rows.every((row) => !row.over) };
}

/**
 * Plain-text report: routes over budget first, then every listed route.
 *
 * Example: `formatReport(checkBudgets(...), budget)` → "First-load JS budget (kB gzip)\n…".
 */
export function formatReport(result, budget) {
  const listed = new Set(Object.keys(budget.routes ?? {}));
  const line = (row) =>
    `  ${row.over ? "OVER" : "ok  "}  ${row.route.padEnd(40)} ${String(row.kb).padStart(7)} / ${row.budgetKb}`;
  const out = ["First-load JS budget (kB gzip, actual / budget)"];
  const over = result.rows.filter((row) => row.over);
  if (over.length > 0) {
    out.push("", "Over budget:", ...over.map(line));
  }
  if (result.missing.length > 0) {
    out.push(
      "",
      "Listed in perf-budget.json but not in this build (renamed or removed?):",
      ...result.missing.map((route) => `  ${route}`),
    );
  }
  out.push("", "Listed routes:", ...result.rows.filter((row) => listed.has(row.route)).map(line));
  const others = result.rows.filter((row) => !listed.has(row.route));
  out.push("", `${others.length} other routes held to the default of ${budget.default} kB.`);
  return out.join("\n");
}

function main() {
  const budget = JSON.parse(readFileSync(PERF_BUDGET_FILE, "utf8"));
  let measured;
  try {
    measured = measureRoutes();
  } catch (error) {
    console.error(`perf:budget: could not read the build (${error.message}). Run \`npm run build\` first.`);
    process.exit(1);
  }
  const result = checkBudgets(measured, budget);
  console.log(formatReport(result, budget));
  if (!result.ok) {
    console.error(
      "\nperf:budget failed. Load the new code on demand (next/dynamic) or, with a reason in the PR, raise the budget in perf-budget.json.",
    );
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
