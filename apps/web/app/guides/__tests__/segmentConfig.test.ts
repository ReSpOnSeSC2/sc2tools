import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GUIDE_REVALIDATE_SEC } from "@/lib/guides/api";

/**
 * Route segment config of the /guides pages, checked on the source so a
 * new guide page can't silently pick the wrong caching mode.
 *
 * - The pages with dynamic params and no query (build, counter list,
 *   counter, map) are ISR: `revalidate` equal to the API data window and
 *   an empty `generateStaticParams` (rendered on first request, never at
 *   `next build`). They must THROW on an API outage (GuideUnavailableError)
 *   rather than render the unavailable state, so an outage is never
 *   cached (the last good render keeps serving; else an uncached 5xx).
 * - /guides and /guides/maps have no params, so a static prerender would
 *   run at `next build` (where the API is often unreachable), and
 *   /guides/[matchup] reads its band / era query: those render per
 *   request (their API reads stay cached by the fetch's own revalidate).
 */
const GUIDES_DIR = path.resolve(process.cwd(), "app/guides");

const ISR_PAGES = [
  "[matchup]/[build]/page.tsx",
  "[matchup]/counter/[strategy]/page.tsx",
  "[matchup]/counter/page.tsx",
  "maps/[map]/page.tsx",
];
const PER_REQUEST_PAGES = ["[matchup]/page.tsx", "maps/page.tsx", "page.tsx"];

function pageFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === "__tests__" ? [] : pageFiles(full);
    return entry === "page.tsx" ? [full] : [];
  });
}

function source(relative: string): string {
  return readFileSync(path.join(GUIDES_DIR, relative), "utf8");
}

describe("guide route segment config", () => {
  it("classifies every guide page", () => {
    const pages = pageFiles(GUIDES_DIR).map((file) => path.relative(GUIDES_DIR, file)).sort();
    expect(pages).toEqual([...ISR_PAGES, ...PER_REQUEST_PAGES].sort());
  });

  it.each(ISR_PAGES)("%s is ISR over the API data window and never caches an outage", (page) => {
    const text = source(page);
    const match = /^export const revalidate = (\d+);$/m.exec(text);
    expect(Number(match?.[1])).toBe(GUIDE_REVALIDATE_SEC);
    expect(text).not.toMatch(/^export const dynamic\b/m);
    expect(text).toMatch(/^export function generateStaticParams\(\)/m);
    expect(text).toMatch(/throw new GuideUnavailableError\(/);
    expect(text).not.toMatch(/<GuideUnavailable\b/);
    expect(text).not.toMatch(/searchParams/);
  });

  it.each(PER_REQUEST_PAGES)("%s renders per request and never exports an ISR window", (page) => {
    const text = source(page);
    expect(text).toMatch(/^export const dynamic = "force-dynamic";$/m);
    expect(text).not.toMatch(/^export const revalidate\b/m);
  });
});
