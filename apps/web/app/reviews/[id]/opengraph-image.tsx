import { ImageResponse } from "next/og";
import { getMapImageUrl, getMapLayoutUrl } from "@/lib/map-images";

/**
 * Dynamic OG card for a replay review: matchup, question snippet,
 * review count and the map thumbnail. Built from ``/v1/reviews/:id/og``,
 * the same redacted payload as the page (no opponent identity). A
 * missing, private or removed review renders a neutral branded card, so
 * the image never reveals whether a request exists.
 *
 * Satori: inline hex colours only, ``display:flex`` on every multi-child
 * div.
 */

export const alt = "SC2 Tools replay review";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BG = "#06090e";
const SURFACE = "#0c1017";
const TEXT = "#e7edf0";
const MUTED = "#9aa3b2";
const CYAN = "#3ce0d6";
const TEAL = "#157d8c";
const GOLD = "#f0c43c";
const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ||
  process.env.SC2TOOLS_API_BASE ||
  "http://localhost:8080";

type OgSummary = {
  question: string;
  matchup: string | null;
  map: string | null;
  result: string | null;
  askerBand: string | null;
  reviewCount: number;
  hasBest: boolean;
};

export default async function OpenGraphImage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const review = /^[A-Za-z0-9_-]{16}$/.test(id) ? await load(id) : null;
  const thumb = review?.map ? await mapThumbnail(review.map) : null;
  const count = review?.reviewCount ?? 0;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: `radial-gradient(1000px 500px at 100% 0%, ${TEAL}44 0%, ${BG} 55%), ${BG}`,
          padding: "56px 72px",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ width: 14, height: 40, borderRadius: 6, background: CYAN, display: "flex" }} />
          <div style={{ display: "flex", fontSize: 28, letterSpacing: 4, color: CYAN, fontWeight: 700, textTransform: "uppercase" }}>
            SC2 Tools · Replay review
          </div>
          {review?.matchup ? (
            <div style={{ display: "flex", marginLeft: 8, padding: "6px 18px", borderRadius: 999, border: `2px solid ${TEAL}`, color: TEXT, fontSize: 28, fontWeight: 700 }}>
              {review.matchup}
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", gap: 36, alignItems: "center" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, flex: 1 }}>
            <div style={{ display: "flex", fontSize: 58, fontWeight: 800, color: TEXT, lineHeight: 1.1 }}>
              {review ? truncate(review.question, 120) : "Timestamped replay reviews from verified players"}
            </div>
            <div style={{ display: "flex", fontSize: 28, color: MUTED }}>
              {review
                ? [review.map, review.askerBand ? `${review.askerBand} asker` : null, review.result].filter(Boolean).join(" · ")
                : "Ask about any moment of your game — get answers pinned to the replay."}
            </div>
          </div>
          {thumb ? (
            <img src={thumb} alt="" width={300} height={169} style={{ borderRadius: 18, border: "2px solid #1c2430", objectFit: "cover" }} />
          ) : null}
        </div>

        <div style={{ display: "flex", gap: 24 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "20px 30px", borderRadius: 20, background: SURFACE, border: "2px solid #1c2430", minWidth: 280 }}>
            <div style={{ display: "flex", fontSize: 22, letterSpacing: 2, textTransform: "uppercase", color: MUTED }}>Reviews</div>
            <div style={{ display: "flex", fontSize: 52, fontWeight: 800, color: CYAN }}>{review ? String(count) : "—"}</div>
          </div>
          {review?.hasBest ? (
            <div style={{ display: "flex", alignItems: "center", padding: "20px 30px", borderRadius: 20, background: SURFACE, border: `2px solid ${GOLD}`, color: GOLD, fontSize: 34, fontWeight: 800 }}>
              ★ Best answer chosen
            </div>
          ) : null}
          <div style={{ display: "flex", alignItems: "center", marginLeft: "auto", color: CYAN, fontSize: 30, fontWeight: 700 }}>sc2tools.com/reviews</div>
        </div>
      </div>
    ),
    { ...size },
  );
}

async function load(id: string): Promise<OgSummary | null> {
  try {
    const res = await fetch(`${API_BASE}/v1/reviews/${encodeURIComponent(id)}/og`, {
      headers: { accept: "application/json" },
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return (await res.json()) as OgSummary;
  } catch {
    return null;
  }
}

/**
 * Pre-fetch into a data URL so a slow/missing thumbnail can't fail the
 * card. Satori only decodes PNG, JPEG and GIF — the 16:9 thumbnails are
 * WebP — so fall back to the JPEG layout render, and drop anything else
 * rather than crash the image.
 */
async function mapThumbnail(map: string): Promise<string | null> {
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
function sniffImageType(bytes: Buffer): string | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes.toString("ascii", 1, 4) === "PNG") return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 6 && bytes.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  return null;
}

function truncate(value: string, max: number) {
  const v = value.replace(/\s+/g, " ").trim();
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}
