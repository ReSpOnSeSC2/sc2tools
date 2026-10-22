import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HELP_INDEX_FILE,
  helpArticleIdentifier,
  helpIndexSource,
  listHelpArticleFiles,
} from "@/scripts/gen-help-index.mjs";

describe("lib/help/articles/index.generated.ts", () => {
  it("matches the article files on disk", () => {
    const expected = helpIndexSource(listHelpArticleFiles());
    expect(
      readFileSync(HELP_INDEX_FILE, "utf8"),
      "lib/help/articles/index.generated.ts is stale. Run `npm run help:index` in apps/web and commit the result.",
    ).toBe(expected);
  });

  it("lists <category>/<slug>.ts files in code-point order with unique identifiers", () => {
    const files = listHelpArticleFiles();
    expect(files.length).toBeGreaterThan(0);
    expect([...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(files);
    for (const file of files) expect(file).toMatch(/^[a-z0-9-]+\/[a-z0-9-]+\.ts$/);
    const identifiers = files.map(helpArticleIdentifier);
    expect(new Set(identifiers).size).toBe(identifiers.length);
  });

  it("renders sorted imports and the ALL_HELP_ARTICLES array", () => {
    const source = helpIndexSource(["builds/build-check-in.ts", "getting-started/how-to-use-help.ts"]);
    expect(source.split("\n")[0]).toBe("// generated — run npm run help:index");
    expect(source).toContain('import builds_buildCheckIn from "./builds/build-check-in";');
    expect(source).toContain('import gettingStarted_howToUseHelp from "./getting-started/how-to-use-help";');
    expect(source).toContain(
      "export const ALL_HELP_ARTICLES: readonly HelpArticle[] = [\n  builds_buildCheckIn,\n  gettingStarted_howToUseHelp,\n];\n",
    );
  });
});
