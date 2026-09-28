import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every /guides page can render the noindex "temporarily unavailable"
 * state when the API is down. As an ISR page that state would be cached
 * for the whole 6 h window (and calling noStore() at runtime inside an
 * ISR page is a 500 in Next 15), so every guide page must render per
 * request; the API reads stay cached by the fetch's own revalidate + tag.
 * Checked on the source so a new guide page can't silently opt back in.
 */
const GUIDES_DIR = path.resolve(process.cwd(), "app/guides");

function pageFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === "__tests__" ? [] : pageFiles(full);
    return entry === "page.tsx" ? [full] : [];
  });
}

describe("guide route segment config", () => {
  const pages = pageFiles(GUIDES_DIR);

  it("finds every guide page", () => {
    expect(pages.map((file) => path.relative(GUIDES_DIR, file)).sort()).toEqual([
      "[matchup]/[build]/page.tsx",
      "[matchup]/counter/[strategy]/page.tsx",
      "[matchup]/counter/page.tsx",
      "[matchup]/page.tsx",
      "maps/[map]/page.tsx",
      "maps/page.tsx",
      "page.tsx",
    ]);
  });

  it.each(pageFiles(GUIDES_DIR).map((file) => [path.relative(GUIDES_DIR, file), file]))(
    "%s renders per request and never exports an ISR window",
    (_name, file) => {
      const source = readFileSync(file, "utf8");
      expect(source).toMatch(/^export const dynamic = "force-dynamic";$/m);
      expect(source).not.toMatch(/^export const revalidate\b/m);
    },
  );
});
