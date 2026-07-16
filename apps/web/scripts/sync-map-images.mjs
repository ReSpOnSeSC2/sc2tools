#!/usr/bin/env node

/**
 * One-time/resumable StarCraft II map-art importer.
 *
 * The source page already publishes a season selector and direct static map
 * thumbnails.  This script deliberately stays on that contract: it discovers
 * season IDs from the selector, requests pages and previously-unseen images
 * serially, honours robots.txt, backs off on 429/5xx responses, and keeps a
 * disk cache under the repo's ignored tmp/ directory so interrupted runs do
 * not repeat traffic.
 *
 * Output:
 *   - replay-engine/data/map-images/*.webp (640x360 UI renditions)
 *   - replay-engine/data/map-images/manifest.json (full provenance)
 *   - web/lib/map-images.generated.json (small browser lookup registry)
 *
 * Usage:
 *   npm run maps:sync
 *   npm run maps:sync -- --refresh-pages
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_DIR = path.resolve(WEB_DIR, "../..");
const OUTPUT_DIR = path.join(REPO_DIR, "apps", "replay-engine", "data", "map-images");
const CACHE_DIR = path.join(REPO_DIR, "tmp", "map-image-import");
const PAGE_CACHE_DIR = path.join(CACHE_DIR, "pages");
const ORIGINAL_CACHE_DIR = path.join(CACHE_DIR, "originals");
const API_MANIFEST_PATH = path.join(OUTPUT_DIR, "manifest.json");
const WEB_MANIFEST_PATH = path.join(WEB_DIR, "lib", "map-images.generated.json");

const SOURCE_PAGE =
  process.env.SC2_MAP_SOURCE_PAGE ||
  "https://sc2replaystats.com/account/maps/30690/0/1991244/1v1/AutoMM/67/";
const SOURCE_ORIGIN = new URL(SOURCE_PAGE).origin;
const MIN_SEASON = 36;
const USER_AGENT =
  process.env.SC2_MAP_IMPORT_USER_AGENT ||
  "SC2ToolsMapImporter/1.0 (+https://sc2tools.com; one-time cached asset sync)";
const REQUEST_DELAY_MS = Math.max(
  1_000,
  Number.parseInt(process.env.SC2_MAP_IMPORT_DELAY_MS || "2000", 10) || 2_000,
);
const REQUEST_TIMEOUT_MS = 30_000;
const ROBOTS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const REFRESH_PAGES = process.argv.includes("--refresh-pages");

let lastNetworkRequestAt = 0;

await main();

async function main() {
  await Promise.all([
    mkdir(OUTPUT_DIR, { recursive: true }),
    mkdir(PAGE_CACHE_DIR, { recursive: true }),
    mkdir(ORIGINAL_CACHE_DIR, { recursive: true }),
  ]);
  const previouslyGeneratedFiles = await previousGeneratedImageFilenames();

  const robotsCachePath = path.join(CACHE_DIR, "robots.txt");
  const robots = await getText(new URL("/robots.txt", SOURCE_ORIGIN), {
    cachePath: robotsCachePath,
    refresh:
      REFRESH_PAGES || !(await cacheIsFresh(robotsCachePath, ROBOTS_CACHE_MAX_AGE_MS)),
  });
  assertRobotsAllows(robots, new URL(SOURCE_PAGE).pathname);

  const seedSeason = seasonFromUrl(SOURCE_PAGE);
  const seedHtml = await getSeasonPage(seedSeason);
  const seasonIds = extractSeasonIds(seedHtml).filter((id) => id >= MIN_SEASON);
  if (seasonIds.length === 0) {
    throw new Error(`No seasons >= ${MIN_SEASON} were found in #seasons_id.`);
  }

  console.log(
    `[maps] Discovered ${seasonIds.length} published seasons (${Math.min(...seasonIds)}-${Math.max(...seasonIds)}).`,
  );

  /** @type {Map<string, ImportedMap>} */
  const byKey = new Map();
  const skippedPlaceholderMaps = new Map();
  const emptySeasonIds = [];
  for (let index = 0; index < seasonIds.length; index += 1) {
    const season = seasonIds[index];
    const html = season === seedSeason ? seedHtml : await getSeasonPage(season);
    const rows = extractMapRows(html);
    if (rows.length === 0) {
      emptySeasonIds.push(season);
      console.warn(
        `[maps] Season ${season}: the published page has no map rows; recorded as empty and continuing.`,
      );
      continue;
    }
    for (const row of rows) {
      const key = canonicalMapKey(row.name);
      if (!key) continue;
      const current = byKey.get(key);
      if (isPlaceholderImageUrl(row.sourceUrl)) {
        if (current) {
          current.seasons.add(season);
          current.aliases.add(row.name);
          continue;
        }
        const skipped = skippedPlaceholderMaps.get(key) || {
          displayName: row.name,
          aliases: new Set(),
          seasons: new Set(),
          sourceUrl: row.sourceUrl,
          reason: "Source archive exposes only its generic missing-image placeholder",
        };
        skipped.aliases.add(row.name);
        skipped.seasons.add(season);
        skippedPlaceholderMaps.set(key, skipped);
        continue;
      }
      if (current) {
        current.seasons.add(season);
        current.aliases.add(row.name);
        if (current.sourceUrl !== row.sourceUrl) current.sourceUrls.add(row.sourceUrl);
      } else {
        const skipped = skippedPlaceholderMaps.get(key);
        byKey.set(key, {
          key,
          name: row.name,
          aliases: new Set([
            row.name,
            stripEdition(row.name),
            ...(skipped?.aliases || []),
          ]),
          seasons: new Set([season, ...(skipped?.seasons || [])]),
          sourceUrl: row.sourceUrl,
          sourceUrls: new Set([row.sourceUrl]),
        });
      }
    }
    console.log(
      `[maps] Season ${season}: ${rows.length} images (${index + 1}/${seasonIds.length}); ${byKey.size} unique.`,
    );
  }

  const imported = [];
  const maps = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (let index = 0; index < maps.length; index += 1) {
    const entry = maps[index];
    const filename = `${filenameSlug(entry.name)}.webp`;
    const outputPath = path.join(OUTPUT_DIR, filename);
    const originalName = safeSourceFilename(entry.sourceUrl, entry.key);
    const originalPath = path.join(ORIGINAL_CACHE_DIR, originalName);
    const hadCachedOriginal = await cacheIsFresh(originalPath, Number.POSITIVE_INFINITY);
    const sourceBuffer = await getBuffer(new URL(entry.sourceUrl), {
      cachePath: originalPath,
    });
    const networkSource = !hadCachedOriginal;

    const sourceMeta = await sharp(sourceBuffer).metadata();
    const outputBuffer = await sharp(sourceBuffer)
      .autoOrient()
      .resize(640, 360, { fit: "cover", position: "centre" })
      .webp({ quality: 82, effort: 5, smartSubsample: true })
      .toBuffer();
    await atomicWrite(outputPath, outputBuffer);
    const outputMeta = await sharp(outputBuffer).metadata();
    const sha256 = createHash("sha256").update(outputBuffer).digest("hex");

    imported.push({
      id: entry.key,
      displayName: entry.name,
      aliases: [...entry.aliases].filter(Boolean).sort((a, b) => a.localeCompare(b)),
      seasons: [...entry.seasons].sort((a, b) => a - b),
      image: {
        filename,
        width: outputMeta.width || 640,
        height: outputMeta.height || 360,
        bytes: outputBuffer.byteLength,
        sha256,
        sourceWidth: sourceMeta.width || null,
        sourceHeight: sourceMeta.height || null,
      },
      source: {
        provider: "Sc2ReplayStats",
        url: entry.sourceUrl,
        alternateUrls: [...entry.sourceUrls]
          .filter((url) => url !== entry.sourceUrl)
          .sort(),
        copyrightOwner: "Blizzard Entertainment",
      },
    });
    console.log(
      `[maps] ${index + 1}/${maps.length} ${entry.name} -> ${filename} (${Math.round(outputBuffer.byteLength / 1024)} KiB${networkSource ? ", fetched" : ", cached"})`,
    );
  }

  const generatedAt = new Date().toISOString();
  const manifest = {
    schemaVersion: 1,
    generatedAt,
    source: {
      provider: "Sc2ReplayStats",
      page: SOURCE_PAGE,
      robots: new URL("/robots.txt", SOURCE_ORIGIN).href,
      requestPolicy: {
        concurrency: 1,
        minimumDelayMs: REQUEST_DELAY_MS,
        cached: true,
        retries: "429 and 5xx only; Retry-After honoured",
      },
      copyrightOwner: "Blizzard Entertainment",
    },
    seasonRange: {
      min: Math.min(...seasonIds),
      max: Math.max(...seasonIds),
      publishedSeasonIds: [...seasonIds].sort((a, b) => a - b),
      emptySeasonIds: [...emptySeasonIds].sort((a, b) => a - b),
    },
    skippedArtwork: [...skippedPlaceholderMaps.entries()]
      .filter(([key]) => !byKey.has(key))
      .map(([, entry]) => ({
        displayName: entry.displayName,
        seasons: [...entry.seasons].sort((a, b) => a - b),
        sourceUrl: entry.sourceUrl,
        reason: entry.reason,
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    maps: imported,
  };
  const webManifest = {
    schemaVersion: manifest.schemaVersion,
    generatedAt,
    maps: imported.map(({ id, displayName, aliases, seasons }) => ({
      id,
      displayName,
      aliases,
      seasons,
    })),
  };

  await pruneObsoleteGeneratedImages(previouslyGeneratedFiles, imported);
  await Promise.all([
    atomicWrite(API_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`),
    atomicWrite(WEB_MANIFEST_PATH, `${JSON.stringify(webManifest, null, 2)}\n`),
  ]);
  const totalBytes = imported.reduce((sum, row) => sum + row.image.bytes, 0);
  console.log(
    `[maps] Complete: ${imported.length} optimized maps, ${seasonIds.length} seasons, ${(totalBytes / 1024 / 1024).toFixed(1)} MiB.`,
  );
}

async function previousGeneratedImageFilenames() {
  try {
    const manifest = JSON.parse(await readFile(API_MANIFEST_PATH, "utf8"));
    return new Set(
      (Array.isArray(manifest?.maps) ? manifest.maps : [])
        .map((entry) => String(entry?.image?.filename || ""))
        .filter(
          (filename) =>
            filename &&
            filename === path.basename(filename) &&
            filename.toLowerCase().endsWith(".webp"),
        ),
    );
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return new Set();
    throw error;
  }
}

async function pruneObsoleteGeneratedImages(previousFilenames, imported) {
  const currentFilenames = new Set(imported.map((entry) => entry.image.filename));
  for (const filename of previousFilenames) {
    if (currentFilenames.has(filename)) continue;
    try {
      await unlink(path.join(OUTPUT_DIR, filename));
      console.log(`[maps] Removed obsolete generated image: ${filename}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function getSeasonPage(season) {
  const url = seasonUrl(season);
  return getText(url, {
    cachePath: path.join(PAGE_CACHE_DIR, `season-${season}.html`),
    refresh: REFRESH_PAGES,
  });
}

function seasonUrl(season) {
  const url = new URL(SOURCE_PAGE);
  const parts = url.pathname.split("/").filter(Boolean);
  const current = parts.at(-1);
  if (!/^\d+$/.test(current || "")) {
    throw new Error(`Source page must end in a numeric season: ${SOURCE_PAGE}`);
  }
  parts[parts.length - 1] = String(season);
  url.pathname = `/${parts.join("/")}/`;
  return url;
}

function seasonFromUrl(value) {
  const parts = new URL(value).pathname.split("/").filter(Boolean);
  const season = Number.parseInt(parts.at(-1) || "", 10);
  if (!Number.isFinite(season)) throw new Error(`No season in source URL: ${value}`);
  return season;
}

function extractSeasonIds(html) {
  const select = /<select\b[^>]*\bid=["']seasons_id["'][^>]*>([\s\S]*?)<\/select>/i.exec(html)?.[1];
  if (!select) return [];
  const ids = [];
  for (const match of select.matchAll(/<option\b[^>]*\bvalue=["'](\d+)["'][^>]*>/gi)) {
    const id = Number.parseInt(match[1], 10);
    if (Number.isFinite(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function extractMapRows(html) {
  const rows = [];
  const pattern = /<img\b[^>]*\bsrc=(["'])(.*?\/images\/maps\/large\/.*?)\1[^>]*>[\s\S]{0,1200}?<span\b[^>]*>([^<]+)<\/span>/gi;
  for (const match of html.matchAll(pattern)) {
    const name = decodeHtml(match[3]).replace(/\s+/g, " ").trim();
    if (!name) continue;
    const sourceUrl = new URL(decodeHtml(match[2]), SOURCE_ORIGIN);
    sourceUrl.protocol = "https:";
    rows.push({ name, sourceUrl: sourceUrl.href });
  }
  return rows;
}

function isPlaceholderImageUrl(value) {
  try {
    return path.basename(new URL(value).pathname).toLowerCase() === "missing_image.jpg";
  } catch {
    return false;
  }
}

function decodeHtml(value) {
  return String(value)
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_m, value) => String.fromCodePoint(Number(value)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, value) => String.fromCodePoint(Number.parseInt(value, 16)));
}

function stripEdition(value) {
  return String(value)
    .replace(/\s+(?:ladder\s+edition|(?:le|te|ce|re))\s*$/i, "")
    .trim();
}

function canonicalMapKey(value) {
  return stripEdition(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");
}

function filenameSlug(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[,'’]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function safeSourceFilename(sourceUrl, fallback) {
  let decoded = "";
  try {
    decoded = decodeURIComponent(new URL(sourceUrl).pathname.split("/").at(-1) || "");
  } catch {
    // Fall through to a canonical local name.
  }
  const ext = path.extname(decoded).toLowerCase();
  const safeExt = [".jpg", ".jpeg", ".png", ".webp"].includes(ext) ? ext : ".img";
  return `${filenameSlug(decoded.slice(0, decoded.length - ext.length) || fallback)}${safeExt}`;
}

async function getText(url, options) {
  return (await getBuffer(url, options)).toString("utf8");
}

async function cacheIsFresh(filePath, maxAgeMs) {
  try {
    const metadata = await stat(filePath);
    return metadata.isFile() && Date.now() - metadata.mtimeMs <= maxAgeMs;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function getBuffer(url, { cachePath, refresh = false }) {
  if (!refresh) {
    try {
      const cached = await readFile(cachePath);
      if (cached.byteLength > 0) return cached;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const buffer = await requestBuffer(url);
  await mkdir(path.dirname(cachePath), { recursive: true });
  await atomicWrite(cachePath, buffer);
  return buffer;
}

async function requestBuffer(url) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await politeDelay();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      lastNetworkRequestAt = Date.now();
      response = await fetch(url, {
        headers: {
          accept: "text/html,image/avif,image/webp,image/jpeg,image/png,*/*;q=0.8",
          "user-agent": USER_AGENT,
        },
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      if (attempt >= 3) throw error;
      await sleep(2_000 * 2 ** attempt);
      continue;
    }
    clearTimeout(timeout);
    if (response.ok) return Buffer.from(await response.arrayBuffer());

    if (response.status === 403) {
      throw new Error(`Source refused ${url} with HTTP 403; stopping without retries.`);
    }
    if (response.status !== 429 && response.status < 500) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    if (attempt >= 3) throw new Error(`HTTP ${response.status} for ${url} after retries.`);
    const retryAfter = retryAfterMs(response.headers.get("retry-after"));
    await sleep(retryAfter ?? Math.min(120_000, 5_000 * 2 ** attempt));
  }
  throw new Error(`Request failed: ${url}`);
}

async function politeDelay() {
  const elapsed = Date.now() - lastNetworkRequestAt;
  if (lastNetworkRequestAt > 0 && elapsed < REQUEST_DELAY_MS) {
    await sleep(REQUEST_DELAY_MS - elapsed);
  }
}

function retryAfterMs(value) {
  if (!value) return null;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds)) return Math.max(1_000, seconds * 1_000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(1_000, at - Date.now()) : null;
}

function assertRobotsAllows(robots, targetPath) {
  const groups = parseRobots(robots);
  const matching = groups.filter((group) =>
    group.agents.some((agent) => agent === "*" || USER_AGENT.toLowerCase().startsWith(agent)),
  );
  for (const group of matching) {
    const matchingRules = group.rules
      .filter((rule) => rule.path && targetPath.startsWith(rule.path))
      .sort((a, b) => b.path.length - a.path.length);
    if (matchingRules[0]?.type === "disallow") {
      throw new Error(`robots.txt disallows ${targetPath}; import aborted.`);
    }
  }
}

function parseRobots(text) {
  const groups = [];
  let current = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim().toLowerCase();
    if (field === "user-agent") {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value);
    } else if ((field === "allow" || field === "disallow") && current) {
      current.rules.push({ type: field, path: value });
    }
  }
  return groups;
}

async function atomicWrite(target, contents) {
  const tmp = `${target}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(tmp, contents);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rename(tmp, target);
      return;
    } catch (error) {
      const transientWindowsLock = ["EPERM", "EACCES"].includes(error?.code);
      if (!transientWindowsLock) throw error;
      if (attempt < 4) {
        await sleep(250 * 2 ** attempt);
        continue;
      }
      // Windows antivirus/indexers can temporarily deny rename-over-existing.
      // The generated file is checksum-verified by tests, so a final direct
      // overwrite is safer than abandoning an otherwise resumable import.
      await writeFile(target, contents);
      await unlink(tmp);
      return;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @typedef {{ key: string, name: string, aliases: Set<string>, seasons: Set<number>, sourceUrl: string, sourceUrls: Set<string> }} ImportedMap */
