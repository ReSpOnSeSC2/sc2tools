// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SITE_TITLE_TEMPLATE } from "@/lib/siteTitle";

/**
 * Browser-tab titles, checked from the source of every app/**\/page.tsx.
 *
 * The root layout sets `title.template` ("%s · SC2 Tools") and a default
 * title, the site's full name. Without a title of its own a page shows
 * that default, so every tab of the app looks the same. And a page that
 * writes " · SC2 Tools" itself ends up with the brand twice.
 *
 *   1. Every page gets a title from its own `metadata` /
 *      `generateMetadata`, or from a layout between it and the root
 *      (client pages use a small server layout.tsx for this).
 *   2. Titles leave the brand to the template. Search-tuned titles that
 *      carry it themselves use `title: { absolute: … }`; social cards
 *      (openGraph, twitter) get no template, so they may carry it.
 */

const APP_DIR = path.resolve(process.cwd(), "app");

/** Pages that intentionally use the root default title. */
const DEFAULT_TITLE_PAGES = new Set([
  // The landing page: the default title is the site's full name.
  "page.tsx",
]);

/** Object keys whose `title` is not the document title. */
const SOCIAL_KEYS = new Set(["openGraph", "twitter"]);

/** Helpers that turn their `title` into `{ absolute }` (components/guides/guideSeo.ts). */
const ABSOLUTE_TITLE_HELPERS = new Set(["guideMetadata"]);

function listFiles(dir: string, name: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...listFiles(full, name));
    } else if (entry.name === name) {
      out.push(full);
    }
  }
  return out;
}

const read = (file: string) => readFileSync(file, "utf8");
const rel = (file: string) => path.relative(APP_DIR, file).split(path.sep).join("/");

/**
 * The text of `export const metadata = { … }` (balanced braces), or the
 * initializer expression when it is not an object literal.
 */
function metadataInitializer(src: string): string | null {
  const match = /export\s+const\s+metadata\b[^=]*=\s*/.exec(src);
  if (!match) return null;
  const start = match.index + match[0].length;
  if (src[start] !== "{") return src.slice(start, src.indexOf(";", start));
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

/** True when an object literal's own (depth-1) keys include `title`. */
function hasTopLevelTitle(objectText: string): boolean {
  let depth = 0;
  for (let i = 0; i < objectText.length; i += 1) {
    const ch = objectText[i];
    if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
    else if (depth === 1 && /\btitle\s*[:,}]/y.test(objectText.slice(i, i + 12))) {
      if (i === 0 || /[\s{,]/.test(objectText[i - 1])) return true;
    }
  }
  return false;
}

/** The file sets a document title: generateMetadata, or metadata with a title. */
function providesTitle(src: string): boolean {
  if (/export\s+(async\s+)?function\s+generateMetadata\b/.test(src)) return true;
  const init = metadataInitializer(src);
  if (init === null) return false;
  // A computed initializer (e.g. a helper call): trust it when it mentions a title.
  return init.startsWith("{") ? hasTopLevelTitle(init) : /\btitle\b/.test(src);
}

/** page.tsx plus every layout.tsx between it and the root layout. */
function titleSources(page: string): string[] {
  const sources = [page];
  for (let dir = path.dirname(page); dir !== APP_DIR; dir = path.dirname(dir)) {
    const layout = path.join(dir, "layout.tsx");
    try {
      read(layout);
      sources.push(layout);
    } catch {
      // No layout at this level.
    }
  }
  return sources;
}

/** Name before the `{` that opens the object enclosing `pos` (`openGraph`, `guideMetadata`, …). */
function enclosingObjectKey(src: string, pos: number): string | null {
  let depth = 0;
  for (let i = pos - 1; i >= 0; i -= 1) {
    if (src[i] === "}") depth += 1;
    else if (src[i] === "{") {
      if (depth === 0) {
        const before = src.slice(Math.max(0, i - 80), i);
        return /([A-Za-z_$][\w$]*)\s*[:=(]\s*$/.exec(before)?.[1] ?? null;
      }
      depth -= 1;
    }
  }
  return null;
}

/** A string or template literal starting at `pos`, quotes included. */
function literalAt(src: string, pos: number): string | null {
  const quote = src[pos];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  for (let i = pos + 1; i < src.length; i += 1) {
    if (src[i] === "\\") i += 1;
    else if (src[i] === quote) return src.slice(pos, i + 1);
  }
  return null;
}

/** The literal a `const name = …` in the same file starts with, if any. */
function constLiteral(src: string, name: string): string | null {
  const match = new RegExp(`const\\s+${name}\\s*(?::[^=]+)?=\\s*`).exec(src);
  return match ? literalAt(src, match.index + match[0].length) : null;
}

const BRAND = /SC2 Tools|\$\{(?:GUIDE_)?SITE_NAME\}/;

/** Document-title values in a file that already carry the brand. */
function brandedTitles(src: string): string[] {
  const found: string[] = [];
  for (const match of src.matchAll(/(?<![\w$.])title\b(\s*:\s*|\s*(?=[,}]))/g)) {
    const at = match.index ?? 0;
    const key = enclosingObjectKey(src, at);
    if (key === null && !/[{,]\s*$/.test(src.slice(Math.max(0, at - 40), at))) continue;
    if (key && (SOCIAL_KEYS.has(key) || ABSOLUTE_TITLE_HELPERS.has(key))) continue;
    const valueAt = at + match[0].length;
    const shorthand = !match[1].includes(":");
    let literal: string | null;
    if (shorthand) literal = constLiteral(src, "title");
    else if (src[valueAt] === "{") continue; // { absolute: … } / { default, template }
    else {
      literal = literalAt(src, valueAt);
      const ident = /^[A-Za-z_$][\w$]*/.exec(src.slice(valueAt))?.[0];
      if (!literal && ident) literal = constLiteral(src, ident);
    }
    if (literal && BRAND.test(literal)) found.push(literal);
  }
  return found;
}

const PAGES = listFiles(APP_DIR, "page.tsx").sort();
const PAGES_AND_LAYOUTS = [
  ...PAGES,
  ...listFiles(APP_DIR, "layout.tsx").filter((file) => path.dirname(file) !== APP_DIR),
].sort();

describe("page titles", () => {
  it("finds the app's pages", () => {
    expect(PAGES.length).toBeGreaterThan(40);
    expect(PAGES.map(rel)).toContain("settings/page.tsx");
  });

  it("gives every page a title of its own instead of the site default", () => {
    const untitled = PAGES.filter(
      (page) => !DEFAULT_TITLE_PAGES.has(rel(page)) && !titleSources(page).some((file) => providesTitle(read(file))),
    ).map(rel);
    expect(untitled, "Add `metadata.title` (or a server layout.tsx with one, for a client page)").toEqual([]);
  });

  it("leaves the brand to the root title template", () => {
    const offenders = PAGES_AND_LAYOUTS.flatMap((file) =>
      brandedTitles(read(file)).map((title) => `${rel(file)}: ${title}`),
    );
    expect(
      offenders,
      'Drop the " · SC2 Tools" suffix (the template adds it) or use title: { absolute } for a search-tuned title',
    ).toEqual([]);
  });

  it("gives the game page a title from the game and Settings one per tab", () => {
    expect(read(path.join(APP_DIR, "app/game/[gameId]/page.tsx"))).toMatch(/export async function generateMetadata/);
    expect(read(path.join(APP_DIR, "settings/layout.tsx"))).toMatch(/title: "Settings"/);
  });
});

describe("root title template", () => {
  it("is wired into the root layout", () => {
    const layout = read(path.join(APP_DIR, "layout.tsx"));
    expect(layout).toMatch(/title:\s*\{\s*default:\s*SITE_TITLE,\s*template:\s*SITE_TITLE_TEMPLATE\s*\}/);
    expect(SITE_TITLE_TEMPLATE).toBe("%s · SC2 Tools");
  });
});

describe("the checks themselves", () => {
  it("spot a page without a title and accept the usual shapes", () => {
    expect(providesTitle('export const metadata = { description: "x", openGraph: { title: "y" } };')).toBe(false);
    expect(providesTitle('export const metadata: Metadata = {\n  title: "Devices",\n};')).toBe(true);
    expect(providesTitle("export async function generateMetadata() { return {}; }")).toBe(true);
    expect(providesTitle("export default function Page() { return null; }")).toBe(false);
  });

  it("flag a hand-written brand but not social cards, absolute titles or guide helpers", () => {
    expect(brandedTitles('export const metadata = { title: "Devices · SC2 Tools" };')).toEqual(['"Devices · SC2 Tools"']);
    expect(brandedTitles("const title = `${name} — ${SITE_NAME}`;\nreturn { title, description };")).toHaveLength(1);
    expect(brandedTitles('const TITLE = "Help · SC2 Tools";\nexport const metadata = { title: TITLE };')).toHaveLength(1);
    expect(
      brandedTitles(
        'export const metadata = { title: { absolute: "X | SC2 Tools" }, openGraph: { title: "Y — SC2 Tools" }, twitter: { title: "Z · SC2 Tools" } };',
      ),
    ).toEqual([]);
    expect(brandedTitles('return guideMetadata({ title: "Videos | SC2 Tools", description: "d" });')).toEqual([]);
    expect(brandedTitles('export const metadata = { title: "Devices" };')).toEqual([]);
  });
});
