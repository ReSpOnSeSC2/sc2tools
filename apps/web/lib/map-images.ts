import manifestJson from "./map-images.generated.json";

export type MapImageEntry = {
  id: string;
  displayName: string;
  aliases: string[];
  seasons: number[];
};

type MapImageManifest = {
  schemaVersion: number;
  generatedAt: string;
  maps: MapImageEntry[];
};

const manifest = manifestJson as MapImageManifest;
const byKey = new Map<string, MapImageEntry>();

for (const entry of manifest.maps) {
  for (const candidate of [entry.id, entry.displayName, ...entry.aliases]) {
    const key = canonicalMapImageKey(candidate);
    if (key && !byKey.has(key)) byKey.set(key, entry);
  }
}

/**
 * Canonicalize only for artwork lookup. Replay map strings remain raw in the
 * data model because they participate in game IDs and exact analytics filters.
 */
export function canonicalMapImageKey(value: string | null | undefined): string {
  const tokens = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length >= 2 && ["le", "te", "ce", "re"].includes(tokens.at(-1)!)) {
    tokens.pop();
  }
  if (tokens.length >= 2 && tokens.slice(-2).join(" ") === "ladder edition") {
    tokens.splice(-2);
  }
  return tokens.join("");
}

export function resolveMapImage(
  mapName: string | null | undefined,
): MapImageEntry | null {
  const key = canonicalMapImageKey(mapName);
  return key ? byKey.get(key) || null : null;
}

export function getMapImageUrl(mapName: string | null | undefined): string | null {
  const entry = resolveMapImage(mapName);
  if (!entry) return null;
  const apiBase = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8080";
  return `${apiBase}/v1/map-image?map=${encodeURIComponent(entry.displayName)}`;
}

export function availableMapImages(): readonly MapImageEntry[] {
  return manifest.maps;
}
