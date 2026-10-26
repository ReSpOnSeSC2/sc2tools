import { ImageResponse } from "next/og";
import { createHash } from "node:crypto";
import { fetchPublicPlayer } from "@/lib/publicPlayer";
import type { PublicPlayerProfile } from "./types";

export type PlayerImageOptions = { style: "record" | "build" | "mmr"; theme: "light" | "dark"; height: 100 | 160; large?: boolean };
const NO_STORE = "private, no-store, max-age=0";
const bitmapCache = new Map<string, { at: number; bytes: Uint8Array }>();
const MAX_BITMAP_BYTES = 8 * 1024 * 1024;
let bitmapBytes = 0;

export function playerImageOptions(search: URLSearchParams): PlayerImageOptions {
  return { style: search.get("style") === "build" ? "build" : search.get("style") === "mmr" ? "mmr" : "record",
    theme: search.get("theme") === "light" ? "light" : "dark", height: search.get("height") === "100" ? 100 : 160 };
}

/** Fresh admission always precedes the bitmap cache, including cache hits.
 * Cached bytes reduce rendering work without letting a CDN bypass opt-out. */
export async function renderPlayerImage(player: string, options: PlayerImageOptions) {
  let profile: PublicPlayerProfile | null = null;
  try {
    const result = await fetchPublicPlayer(player);
    profile = result.data && !result.data.archiveOnly ? result.data.profile : null;
  } catch { /* An unavailable profile always renders the same neutral image. */ }
  const card = playerImageData(profile, options.style);
  const key = createHash("sha256").update(JSON.stringify([card, options])).digest("hex");
  const cached = bitmapCache.get(key);
  if (cached && Date.now() - cached.at < 3_600_000) return imageResponse(cached.bytes);
  const image = new ImageResponse(<PlayerImageCard card={card} options={options} />, { width: options.large ? 1200 : 320, height: options.large ? 630 : options.height });
  const bytes = new Uint8Array(await image.arrayBuffer());
  if (bytes.byteLength <= MAX_BITMAP_BYTES) {
    while (bitmapCache.size >= 48 || bitmapBytes + bytes.byteLength > MAX_BITMAP_BYTES) {
      const oldest = bitmapCache.keys().next().value;
      if (!oldest) break;
      bitmapBytes -= bitmapCache.get(oldest)!.bytes.byteLength; bitmapCache.delete(oldest);
    }
    const previous = bitmapCache.get(key); if (previous) bitmapBytes -= previous.bytes.byteLength;
    bitmapCache.set(key, { at: Date.now(), bytes }); bitmapBytes += bytes.byteLength;
  }
  return imageResponse(bytes);
}

function imageResponse(bytes: Uint8Array) { return new Response(bytes, { headers: { "Content-Type": "image/png", "Cache-Control": NO_STORE, "X-Content-Type-Options": "nosniff" } }); }

/** Only chosen public fields enter image text or its hashed cache identity. */
export function playerImageData(profile: PublicPlayerProfile | null, style: PlayerImageOptions["style"]) {
  if (!profile) return { name: "SC2 Tools", headline: "Your StarCraft II companion", detail: "Public player page unavailable", neutral: true };
  const name = profile.displayName.slice(0, 38);
  if (style === "build") return { name, headline: typeof profile.featuredBuild?.title === "string" ? profile.featuredBuild.title.slice(0, 65) : "No featured build", detail: "Public player builds · SC2 Tools", neutral: false };
  if (style === "mmr") {
    const row = profile.sections?.showMmrHistory ? profile.mmrHistory?.at(-1) : null;
    const latest = row && Number.isFinite(row.mmr) ? row : null;
    return { name, headline: latest ? `${Math.round(latest.mmr)} MMR` : "MMR history not shared", detail: latest ? "Latest weekly average · SC2 Tools" : "Public player page · SC2 Tools", neutral: false };
  }
  const totals = profile.totals;
  const games = Number.isFinite(totals.games) ? Math.max(0, Math.trunc(totals.games)) : 0;
  const wins = Number.isFinite(totals.wins) ? Math.max(0, Math.trunc(totals.wins)) : 0;
  const losses = Number.isFinite(totals.losses) ? Math.max(0, Math.trunc(totals.losses)) : 0;
  return { name, headline: `${wins} wins · ${losses} losses`, detail: `${games.toLocaleString("en-US")} games tracked · SC2 Tools`, neutral: false };
}

type ImageCardData = ReturnType<typeof playerImageData>;
export function PlayerImageCard({ card, options }: { card: ImageCardData; options: PlayerImageOptions }) {
  const scale = options.large ? 3.75 : 1;
  // RGB values mirror the existing global theme tokens; Satori cannot read CSS variables.
  const palette = options.theme === "light" ? { bg: "rgb(255,255,255)", text: "rgb(13,18,26)", muted: "rgb(63,72,86)", accent: "rgb(14,125,140)" }
    : { bg: "rgb(12,16,23)", text: "rgb(231,237,240)", muted: "rgb(154,163,178)", accent: "rgb(60,224,214)" };
  return <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 16 * scale, background: palette.bg, color: palette.text, fontFamily: "sans-serif", borderTop: `${4 * scale}px solid ${palette.accent}` }}>
    <div style={{ display: "flex", color: palette.accent, fontSize: 12 * scale, fontWeight: 700 }}>SC2 TOOLS · PLAYER PAGE</div>
    <div style={{ display: "flex", flexDirection: "column", gap: 6 * scale }}><div style={{ display: "flex", fontSize: (options.height === 100 ? 16 : 22) * scale, fontWeight: 700 }}>{clip(card.name, options.large ? 38 : 26)}</div><div style={{ display: "flex", fontSize: (options.height === 100 ? 13 : 17) * scale }}>{clip(card.headline, options.large ? 65 : options.height === 100 ? 30 : 42)}</div></div>
    <div style={{ display: "flex", color: palette.muted, fontSize: 12 * scale }}>{clip(card.detail, options.large ? 65 : 46)}</div>
  </div>;
}
function clip(value: string, max: number) { return value.length > max ? `${value.slice(0, max - 1)}…` : value; }
