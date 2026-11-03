export const PACK_NAME_BYTES = 240;
export const PACK_TEMPLATES = ["date-opponent-map", "date-matchup-map", "game-id", "descriptive"] as const;
export type PackNameTemplate = typeof PACK_TEMPLATES[number];
export type PackNameMetadata = { gameId: string; date?: unknown; map?: unknown; opponent?: unknown; matchup?: unknown; result?: unknown };
const encoder = new TextEncoder();
const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const PRIVATE_VALUE = /[a-z][a-z0-9+.-]*:\/\/|(?:https?|s3|file|data|javascript):|x-amz-|(?:signature|authorization|token)\s*[=:]|bearer\s+|^[a-z]:[\\/]|^\\\\|^\/|^raw-replays\//iu;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3]|conin\$|conout\$)(?:\.|$)/iu;

/** Bound before normalization and drop URL/credential/path values rather than converting them into filenames. */
export function packText(value: unknown, byteLimit: number): string {
  if (typeof value !== "string") return "";
  const bounded = value.slice(0, 1024);
  if (PRIVATE_VALUE.test(bounded)) return "";
  const clean = [...bounded].map(character => {
    const code = character.charCodeAt(0);
    return character.length === 1 && code >= 0xd800 && code <= 0xdfff ? "_" : character;
  }).join("").normalize("NFKC").replace(FORBIDDEN, " ").replace(/\s+/gu, " ").trim();
  if (PRIVATE_VALUE.test(clean)) return "";
  return utf8Prefix(clean, byteLimit);
}

export function validPackUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(++index);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

export function utf8Prefix(value: string, byteLimit: number): string {
  let bytes = 0, result = "";
  for (const character of value) {
    const length = encoder.encode(character).byteLength;
    if (bytes + length > byteLimit) break;
    bytes += length; result += character;
  }
  return result;
}

export const foldPackName = (name: string) => name.normalize("NFKC").toUpperCase().toLowerCase();

/** Only the selected row's recorded result, never a score or download outcome. */
export function recordedReplayResult(value: unknown): "Win" | "Loss" | "Tie" | "Unknown" {
  const normalized = packText(value, 32).toLowerCase();
  if (normalized === "win" || normalized === "victory") return "Win";
  if (normalized === "loss" || normalized === "defeat") return "Loss";
  if (normalized === "draw" || normalized === "tie") return "Tie";
  return "Unknown";
}

function filenameBase(value: string): string {
  let clean = packText(value, 1024).replace(/[<>:"/\\|?*]+/gu, " ").replace(/\s+/gu, " ").trim()
    .replace(/^[. ]+|[. ]+$/gu, "").replace(/\.sc2replay$/iu, "").replace(/[. ]+$/gu, "");
  if (!clean) clean = "replay";
  if (WINDOWS_DEVICE.test(clean)) clean = "_" + clean;
  return clean;
}

export function replayFilenameAllocator() {
  const used = new Set(["manifest.csv", "readme.txt"]);
  return (row: PackNameMetadata, template: PackNameTemplate): string => {
    if (!(PACK_TEMPLATES as readonly string[]).includes(template)) throw new Error("invalid_pack_filename");
    const date = packText(row.date, 32).slice(0, 10) || "replay";
    const selected = template === "game-id" ? packText(row.gameId, 800)
      : template === "descriptive" ? `${date} ${packText(row.matchup, 32) || "Unknown matchup"} ${recordedReplayResult(row.result)} vs ${packText(row.opponent, 100) || "Unknown opponent"} on ${packText(row.map, 120) || "Unknown map"}`
      : [date, packText(template === "date-matchup-map" ? row.matchup : row.opponent, 100), packText(row.map, 120)].filter(Boolean).join("_");
    const base = filenameBase(selected), extension = ".SC2Replay";
    for (let index = 1; index <= 102; index += 1) {
      const suffix = index === 1 ? "" : ` (${index})`;
      const name = utf8Prefix(base, PACK_NAME_BYTES - encoder.encode(suffix + extension).byteLength).replace(/[. ]+$/gu, "") + suffix + extension;
      const folded = foldPackName(name);
      if (!used.has(folded)) { used.add(folded); return name; }
    }
    throw new Error("invalid_pack_filename");
  };
}

export function validReplayFilename(name: string): boolean {
  return typeof name === "string" && name.length <= PACK_NAME_BYTES && validPackUnicode(name) && name === name.normalize("NFKC")
    && encoder.encode(name).byteLength <= PACK_NAME_BYTES && name.endsWith(".SC2Replay")
    && !/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(name)
    && !/^[. ]|[. ]$/u.test(name) && !WINDOWS_DEVICE.test(name) && !PRIVATE_VALUE.test(name);
}
