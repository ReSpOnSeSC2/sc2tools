import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import sharp from "sharp";

export const sha = bytes => createHash("sha256").update(bytes).digest("hex");

async function readBounded(path, maxBytes) {
  const entry = await stat(path);
  if (!entry.isFile() || entry.size <= 0 || entry.size > maxBytes) throw new Error("Playback file has an invalid size.");
  const bytes = await readFile(path);
  if (bytes.length !== entry.size) throw new Error("Playback file changed while reading it.");
  return bytes;
}

export async function readManifest(path, { sanitizePlaybackManifest }) {
  const body = await readBounded(path, 200_000);
  const manifest = sanitizePlaybackManifest({ ok: true, artifactId: sha(body), manifest: JSON.parse(body.toString("utf8")) });
  if (!manifest) throw new Error("Provide a complete Recorded playback manifest from the desktop Agent.");
  return manifest;
}

export async function readSegment(path, manifest, entry, { decodePlaybackSegment, MAX_SEGMENT_BYTES }) {
  const bytes = await readBounded(join(dirname(path), entry.sha256 + ".json"), MAX_SEGMENT_BYTES);
  return decodePlaybackSegment(bytes, manifest, entry);
}

export function resolveRecording(planDirectory, entry) {
  if (!entry || typeof entry.manifest !== "string" || !entry.manifest ||
      typeof entry.layout !== "string" || !entry.layout || !["before", "after"].includes(entry.era)) {
    throw new Error("Each source needs a Recorded manifest, its map layout image, and a before/after patch era.");
  }
  return { manifest: resolve(planDirectory, entry.manifest), layout: resolve(planDirectory, entry.layout), era: entry.era };
}

export async function cropTerrain(path, whole, crop) {
  const image = sharp(path);
  const { width, height } = await image.metadata();
  if (!width || !height) throw new Error("Map layout has no dimensions.");
  const x = world => (world - whole.minX) / (whole.maxX - whole.minX) * width;
  const y = world => (whole.maxY - world) / (whole.maxY - whole.minY) * height;
  const left = Math.max(0, Math.floor(x(crop.minX))), top = Math.max(0, Math.floor(y(crop.maxY)));
  const right = Math.min(width, Math.ceil(x(crop.maxX))), bottom = Math.min(height, Math.ceil(y(crop.minY)));
  return image.extract({ left, top, width: right - left, height: bottom - top })
    .resize({ width: 640, withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
}

export async function* recordingFights(source, helpers) {
  const manifest = await readManifest(source.manifest, helpers);
  const seed = Number.parseInt(manifest.replaySha256.slice(0, 6), 16);
  for (const entry of manifest.segments) {
    const playback = await readSegment(source.manifest, manifest, entry, helpers);
    const drafts = helpers.selectFights(playback, entry, source.era, seed);
    for (const [slot, draft] of drafts.entries()) {
      yield {
        key: [manifest.replaySha256, entry.index, slot].join(":"),
        fight: { ...draft.fight, terrain: true },
        terrain: () => cropTerrain(source.layout, playback.bounds, draft.bounds),
      };
    }
  }
}
