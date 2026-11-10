import { getMapImageUrl, getMapLayoutUrl } from "@/lib/map-images";

/**
 * A map thumbnail for a Satori OG card, as a data URL, or null.
 *
 * Pre-fetched so a slow or missing image can't fail the card. Satori only
 * decodes PNG, JPEG and GIF (the 16:9 thumbnails are WebP), so it falls back
 * to the JPEG layout render and drops anything else rather than crash.
 */
export async function mapThumbnail(map: string): Promise<string | null> {
  for (const url of [getMapImageUrl(map), getMapLayoutUrl(map)]) {
    if (!url) continue;
    const embedded = await embeddable(url);
    if (embedded) return embedded;
  }
  return null;
}

async function embeddable(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { next: { revalidate: 86_400 } });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > 1_500_000) return null;
    const type = sniffImageType(bytes);
    return type ? `data:${type};base64,${bytes.toString("base64")}` : null;
  } catch {
    return null;
  }
}

/** Trust the bytes, not the header: only formats Satori can draw. */
export function sniffImageType(bytes: Buffer): string | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes.toString("ascii", 1, 4) === "PNG") return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 6 && bytes.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  return null;
}

/** Collapse whitespace and cut to ``max`` characters with an ellipsis. */
export function truncate(value: string, max: number): string {
  const v = value.replace(/\s+/g, " ").trim();
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}
