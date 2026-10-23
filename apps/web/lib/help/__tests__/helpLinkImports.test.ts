/**
 * Guard for the help registry's weight.
 *
 * HelpLink reads every help article's text. A static import of it puts
 * all of that into the first load of the page that shows the link (it
 * added ~120 kB to /builds and to every /app route once). Outside the
 * help pages and the report form (itself loaded on demand), links to help
 * go through LazyHelpLink, which loads HelpLink on first render.
 * Test files are not scanned.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WEB_ROOT = path.resolve(__dirname, "../../..");
const SCANNED = ["app", "components", "lib"];
const SOURCE_RE = /\.tsx?$/;
const TEST_FILE_RE = /\.(?:test|spec)\.tsx?$/;

/** Files that may import HelpLink itself, relative to apps/web. */
const ALLOWED = [
  /^components\/help\//,
  /^app\/help\//,
  // Loaded on demand through LazyReportIssueModal.
  /^components\/feedback\/ReportIssueModal\.tsx$/,
  /^components\/feedback\/ReportHelpSuggestions\.tsx$/,
];

// A value import (not `import type`) of the HelpLink module, by alias or path.
const HELP_LINK_IMPORT_RE = /^import\s+(?!type\b)[^;]*from\s+"[^"]*\/HelpLink";/m;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__" && entry.name !== "node_modules") out.push(...sourceFiles(full));
    } else if (SOURCE_RE.test(entry.name) && !TEST_FILE_RE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("HelpLink imports", () => {
  it("only the help pages and the report form import HelpLink; everything else uses LazyHelpLink", () => {
    const offenders = SCANNED.flatMap((dir) => sourceFiles(path.join(WEB_ROOT, dir)))
      .map((file) => path.relative(WEB_ROOT, file).split(path.sep).join("/"))
      .filter((file) => !ALLOWED.some((re) => re.test(file)))
      .filter((file) => HELP_LINK_IMPORT_RE.test(readFileSync(path.join(WEB_ROOT, file), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("recognises the import forms it guards against", () => {
    expect(HELP_LINK_IMPORT_RE.test('import { HelpLink } from "@/components/help/HelpLink";')).toBe(true);
    expect(HELP_LINK_IMPORT_RE.test('import { HelpLink } from "../help/HelpLink";')).toBe(true);
    expect(HELP_LINK_IMPORT_RE.test('import type { HelpLinkProps } from "./HelpLink";')).toBe(false);
    expect(HELP_LINK_IMPORT_RE.test('import { LazyHelpLink } from "@/components/help/LazyHelpLink";')).toBe(false);
  });
});
