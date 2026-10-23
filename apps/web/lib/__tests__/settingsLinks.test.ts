/**
 * Guard for links into Settings across the web app and the API (the API
 * hands out links too: the doctor banner's CTAs, the OAuth return page).
 *
 * Settings opens a tab from `?tab=<id>`. Hash-only links
 * (`/settings#overlay`) only work through SettingsShell's legacy
 * fallback and used to land on the wrong tab, so new ones fail here, as
 * does a `?tab=` value that isn't a tab id or a registered alias.
 * Test files are not scanned.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SETTINGS_TAB_ALIASES,
  isSettingsTabId,
  settingsTabFromParam,
  settingsTabForLegacyHash,
} from "@/components/analyzer/settings/SettingsShell";

const WEB_ROOT = path.resolve(__dirname, "../..");
const API_ROOT = path.resolve(WEB_ROOT, "../api");

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "coverage",
  "public",
  "__tests__",
  // Playwright end-to-end specs.
  "tests",
]);
const SOURCE_RE = /\.(?:[cm]?js|tsx?)$/;
const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** Where the legacy hash fallback lives (and is documented). */
const LEGACY_HASH_HOME = path.join(WEB_ROOT, "components/analyzer/settings/SettingsShell.tsx");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...sourceFiles(full));
    } else if (
      (SOURCE_RE.test(entry.name) && !TEST_FILE_RE.test(entry.name)) ||
      entry.name === ".env.example"
    ) {
      out.push(full);
    }
  }
  return out;
}

const FILES = [...sourceFiles(WEB_ROOT), ...sourceFiles(API_ROOT)];

/** Stable diagnostic paths on Windows and POSIX checkouts. */
function sourcePath(file: string): string {
  return path.relative(path.dirname(WEB_ROOT), file).split(path.sep).join("/");
}

/** Every match of `re` as "file:line  match". */
function findAll(re: RegExp, keep: (match: RegExpExecArray) => boolean = () => true): string[] {
  const hits: string[] = [];
  for (const file of FILES) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(re)) {
        if (keep(match)) {
          hits.push(`${sourcePath(file)}:${index + 1}  ${match[0]}`);
        }
      }
    });
  }
  return hits;
}

describe("links into Settings", () => {
  it("scans both apps' source", () => {
    const rel = FILES.map(sourcePath);
    expect(rel).toContain("web/app/streaming/page.tsx");
    expect(rel).toContain("api/src/routes/me.js");
    expect(rel).toContain("api/src/config/loader.js");
    expect(rel.some((file) => file.includes("__tests__"))).toBe(false);
  });

  it("never links to /settings#<tab>: use /settings?tab=<tab>", () => {
    const hits = findAll(/\/settings#[\w-]*/g).filter(
      (hit) => !hit.startsWith(sourcePath(LEGACY_HASH_HOME)),
    );
    expect(hits).toEqual([]);
  });

  it("only names real tabs (or registered aliases) in ?tab=", () => {
    const hits = findAll(
      /\/settings\?tab=([\w-]+)/g,
      (match) => settingsTabFromParam(match[1]) === null,
    );
    expect(hits).toEqual([]);
  });

  it("keeps every alias pointing at a real tab, never shadowing one", () => {
    for (const [alias, tab] of Object.entries(SETTINGS_TAB_ALIASES)) {
      expect(isSettingsTabId(tab), alias).toBe(true);
      expect(isSettingsTabId(alias), alias).toBe(false);
    }
  });
});

describe("legacy hash links", () => {
  it.each([
    ["#overlay", "overlay"],
    ["#profile", "profile"],
    ["#voice", "voice"],
    ["#randomizer", "randomizer"],
    ["#backups", "backups"],
    ["#misc", "misc"],
    ["#help", "help"],
    ["#import", "import"],
    ["#checkin", "checkin"],
    ["#Overlay", "overlay"],
    ["#streaming", "overlay"],
  ])("%s opens the %s tab", (hash, tab) => {
    expect(settingsTabForLegacyHash(hash)).toBe(tab);
  });

  it.each(["", "#", "#platform-connections", "#build-check-in", "#nope", "#constructor", "#__proto__"])(
    "%j names no tab",
    (hash) => {
      expect(settingsTabForLegacyHash(hash)).toBeNull();
    },
  );
});
