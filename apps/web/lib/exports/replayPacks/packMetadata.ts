import { packText, recordedReplayResult, validReplayFilename, type PackNameMetadata } from "./packNames";

export const MANIFEST_BYTES = 256 * 1024;
export const README_BYTES = 16 * 1024;
export type PackFileStatus = "saved" | "unavailable" | "failed" | "cancelled";
export type PackManifestRow = PackNameMetadata & { filename: string; status: PackFileStatus };
const encoder = new TextEncoder();
const STATUSES = new Set<PackFileStatus>(["saved", "unavailable", "failed", "cancelled"]);

function cell(value: string): string {
  const safe = /^[\s]*[=+\-@]/u.test(value) ? "'" + value : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}

/** Closed allowlist only: extra row properties such as URLs, tokens and storage keys are never serialized. */
export function replayPackManifest(rows: readonly PackManifestRow[]): Uint8Array {
  if (rows.length > 100) throw new Error("invalid_pack_manifest");
  const lines = rows.map(row => {
    if (!STATUSES.has(row.status) || (row.filename !== "" && !validReplayFilename(row.filename))
      || (row.status === "saved" && row.filename === "")) throw new Error("invalid_pack_manifest");
    return [packText(row.gameId, 800), row.filename, packText(row.date, 32), packText(row.map, 120),
      packText(row.opponent, 100), packText(row.matchup, 32), recordedReplayResult(row.result), row.status].map(cell).join(",");
  });
  const bytes = encoder.encode("\ufeffgameId,filename,date,map,opponent,matchup,recordedResult,status\r\n" + lines.join("\r\n") + "\r\n");
  if (bytes.byteLength > MANIFEST_BYTES) throw new Error("invalid_pack_manifest");
  return bytes;
}

export function replayPackReadme(counts: { requested: number; saved: number; failed: number; cancelled: number }): Uint8Array {
  const { requested, saved, failed, cancelled } = counts;
  if (![requested, saved, failed, cancelled].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 100)
    || saved + failed + cancelled !== requested) throw new Error("invalid_pack_summary");
  return encoder.encode([
    "SC2 Tools private replay pack", "",
    `Selected: ${requested}. Replay files saved: ${saved}. Unavailable or failed: ${failed}. Cancelled: ${cancelled}.`,
    "Only successfully downloaded originals are included. See manifest.csv for each selected game's result.",
    "Replay files and game metadata can reveal player names and game history. Keep this archive private and review it before sharing.",
    "The pack reads records and original files in sequence. Changes during the download may affect which files are available.",
    "This archive is a collection of original replay files, not a restorable account snapshot or a redacted support bundle.", "",
  ].join("\r\n"));
}
