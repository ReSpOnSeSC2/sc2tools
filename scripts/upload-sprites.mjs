#!/usr/bin/env node
/**
 * Upload the baked SC2 sprite sheets to Cloudflare R2.
 *
 * Reads credentials from apps/api/.env (or the process env) — the same
 * R2_* variables the alert-media store already uses. Nothing is printed
 * that would leak a key.
 *
 *   node scripts/upload-sprites.mjs [--bucket sc2tools-sprites] [--dry-run]
 *
 * The same script uploads the replay background score:
 *
 *   node scripts/upload-sprites.mjs \\
 *     --source apps/web/public/audio/replay \\
 *     --bucket sc2tools-audio --prefix audio/v1
 *
 * NOTE on the audio bucket: the first upload was done by hand through
 * the R2 dashboard, which left the two Protoss takes under a
 * ``protoss/`` prefix and the other three at the root. Running the
 * command above normalises everything under ``audio/v1/`` -- after
 * which the ``path`` fields in lib/replayMusic.ts TRACKS should drop
 * the ``protoss/`` segment.
 *
 * Source tree (produced by the Blender bake):
 *   apps/web/public/sprites/{units,buildings}/<Race>/<Name>_<color>[_Walk].webp
 *   ...plus the matching .json sidecars and sprite-manifest.json
 *
 * Objects land at  <prefix>/<same relative path>  with a 1-year
 * immutable cache header; sheets are content-addressed by name, so a
 * re-bake should change the filename rather than overwrite in place.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep, posix } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// The AWS SDK is a dependency of apps/api, not of the repo root, and this
// script is run from the root (it resolves asset paths off process.cwd()).
// A bare import therefore fails. Try the normal resolution first -- so this
// keeps working if the SDK is ever hoisted or added at the root -- then fall
// back to resolving it out of apps/api/node_modules.
const { S3Client, PutObjectCommand, HeadObjectCommand } = await (async () => {
  try {
    return await import("@aws-sdk/client-s3");
  } catch {
    try {
      const reqFromApi = createRequire(
        join(process.cwd(), "apps", "api", "package.json"),
      );
      return await import(
        pathToFileURL(reqFromApi.resolve("@aws-sdk/client-s3")).href
      );
    } catch {
      console.error("Cannot find @aws-sdk/client-s3.");
      console.error("Run this from the repo root, and make sure apps/api has");
      console.error("its dependencies installed:  npm --prefix apps/api install");
      process.exit(1);
    }
  }
})();

const ROOT = process.cwd();
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SRC = join(ROOT, ...arg("--source", "apps/web/public/sprites").split("/"));
const DRY = args.includes("--dry-run");
const BUCKET = arg("--bucket", process.env.R2_SPRITE_BUCKET || "sc2tools-sprites");
const PREFIX = arg("--prefix", process.env.R2_SPRITE_PREFIX || "sprites/v1");

// --- credentials -----------------------------------------------------
function loadEnvFile(p) {
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}
const fileEnv = loadEnvFile(join(ROOT, "apps", "api", ".env"));
const pick = (k) => process.env[k] || fileEnv[k] || "";
const ENDPOINT = pick("R2_ENDPOINT");
const KEY_ID = pick("R2_SPRITE_ACCESS_KEY_ID") || pick("R2_ACCESS_KEY_ID");
const SECRET = pick("R2_SPRITE_SECRET_ACCESS_KEY") || pick("R2_SECRET_ACCESS_KEY");

if (!ENDPOINT || !KEY_ID || !SECRET) {
  console.error("Missing R2 credentials. Need R2_ENDPOINT + R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY");
  console.error("(set them in apps/api/.env or the environment).");
  console.error("NOTE: R2 tokens are bucket-scoped — the replay-store token may not");
  console.error("      have write access to the sprite bucket. Create a token scoped");
  console.error(`      to "${BUCKET}" and set R2_SPRITE_ACCESS_KEY_ID / _SECRET_ACCESS_KEY.`);
  process.exit(1);
}
if (!existsSync(SRC)) { console.error(`No sprite tree at ${SRC}`); process.exit(1); }

const s3 = new S3Client({
  region: pick("R2_REGION") || "auto",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: KEY_ID, secretAccessKey: SECRET },
});

// --- walk ------------------------------------------------------------
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p); else yield p;
  }
}
const TYPES = {
  ".webp": "image/webp", ".json": "application/json", ".png": "image/png",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
};
const files = [...walk(SRC)].filter((f) => TYPES[f.slice(f.lastIndexOf("."))]);
files.sort();

let done = 0, skipped = 0, bytes = 0;
const CONCURRENCY = 8;

async function put(file) {
  const rel = relative(SRC, file).split(sep).join(posix.sep);
  const Key = `${PREFIX}/${rel}`;
  const body = readFileSync(file);
  if (DRY) { console.log(`[dry] ${Key}  ${(body.length / 1024).toFixed(0)} KB`); done++; bytes += body.length; return; }
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key }));
    skipped++; return;                       // already uploaded, immutable
  } catch { /* not present — upload below */ }
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key, Body: body,
    ContentType: TYPES[file.slice(file.lastIndexOf("."))],
    CacheControl: "public, max-age=31536000, immutable",
  }));
  done++; bytes += body.length;
  if (done % 25 === 0) console.log(`  ${done}/${files.length} uploaded (${(bytes / 1048576).toFixed(0)} MB)`);
}

console.log(`${DRY ? "[DRY RUN] " : ""}${files.length} files -> r2://${BUCKET}/${PREFIX}/`);
const queue = files.slice();
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  for (let f = queue.shift(); f; f = queue.shift()) await put(f);
}));
console.log(`Done. uploaded=${done} skipped=${skipped} bytes=${(bytes / 1048576).toFixed(1)} MB`);
const envVar = BUCKET.includes("audio")
  ? "NEXT_PUBLIC_AUDIO_BASE"
  : "NEXT_PUBLIC_SPRITE_BASE";
console.log(`Set ${envVar} to your public bucket URL + /${PREFIX}`);
