#!/usr/bin/env node
/**
 * gen-help-index — writes lib/help/articles/index.generated.ts, the
 * registry of every help article.
 *
 *   npm run help:index        (from apps/web)
 *
 * Articles are one file each, lib/help/articles/<category>/<slug>.ts,
 * with a default export typed HelpArticle. Many changes add articles at
 * the same time, so nobody edits a shared list by hand: this script
 * scans the folder and writes sorted imports plus ALL_HELP_ARTICLES.
 * Re-run it after adding, renaming or removing an article file.
 *
 * lib/help/__tests__/indexGenerated.test.ts imports the pure functions
 * below, renders the registry in memory and fails when the committed
 * file is stale; the per-article checks (file path matches category and
 * slug, unique slugs, links resolve) live in lib/help/__tests__/articles.test.ts.
 */
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Folder holding <category>/<slug>.ts article files. */
export const HELP_ARTICLES_DIR = path.join(webRoot, "lib", "help", "articles");

/** The registry this script writes. */
export const HELP_INDEX_FILE = path.join(HELP_ARTICLES_DIR, "index.generated.ts");

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ARTICLE_FILE_RE = /^([a-z0-9-]+)\.ts$/;

/**
 * Article files as "<category>/<slug>.ts" paths relative to the
 * articles folder, sorted by code point so the output never depends on
 * the platform's directory order or locale.
 *
 * Example: `listHelpArticleFiles()` → ["builds/build-check-in.ts", "getting-started/getting-started.ts", …].
 */
export function listHelpArticleFiles(dir = HELP_ARTICLES_DIR) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    if (!NAME_RE.test(entry.name)) {
      throw new Error(`help:index: category folder "${entry.name}" must be lowercase words joined by hyphens`);
    }
    for (const file of readdirSync(path.join(dir, entry.name), { withFileTypes: true })) {
      if (!file.isFile() || file.name.endsWith(".test.ts") || file.name.endsWith(".d.ts")) continue;
      const match = ARTICLE_FILE_RE.exec(file.name);
      if (!match) continue;
      if (!NAME_RE.test(match[1])) {
        throw new Error(`help:index: article file "${entry.name}/${file.name}" must be named <slug>.ts in lowercase-hyphen form`);
      }
      files.push(`${entry.name}/${file.name}`);
    }
  }
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function camel(name) {
  return name.replace(/-([a-z0-9])/g, (_, ch) => ch.toUpperCase());
}

/**
 * The import identifier for an article file.
 *
 * Example: `helpArticleIdentifier("getting-started/how-to-use-help.ts")` → "gettingStarted_howToUseHelp".
 */
export function helpArticleIdentifier(file) {
  const [category, name] = file.replace(/\.ts$/, "").split("/");
  return `${camel(category)}_${camel(name)}`;
}

/**
 * The registry source for the given article files.
 *
 * Example: `helpIndexSource(["builds/build-check-in.ts"])` → a module that
 * imports `builds_buildCheckIn` and exports `ALL_HELP_ARTICLES = [builds_buildCheckIn]`.
 */
export function helpIndexSource(files) {
  const lines = [
    "// generated — run npm run help:index",
    "//",
    "// Written by scripts/gen-help-index.mjs from every",
    "// lib/help/articles/<category>/<slug>.ts file. Do not edit by hand.",
    "",
    'import type { HelpArticle } from "../types";',
    ...files.map((file) => `import ${helpArticleIdentifier(file)} from "./${file.replace(/\.ts$/, "")}";`),
    "",
    "export const ALL_HELP_ARTICLES: readonly HelpArticle[] = [",
    ...files.map((file) => `  ${helpArticleIdentifier(file)},`),
    "];",
    "",
  ];
  return lines.join("\n");
}

/** Scan the articles folder and write the registry. */
export function writeHelpIndex() {
  const files = listHelpArticleFiles();
  writeFileSync(HELP_INDEX_FILE, helpIndexSource(files));
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const files = writeHelpIndex();
  console.log(`${path.relative(webRoot, HELP_INDEX_FILE)}: ${files.length} articles`);
}
