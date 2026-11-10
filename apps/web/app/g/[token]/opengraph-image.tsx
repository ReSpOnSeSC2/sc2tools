import { ImageResponse } from "next/og";
import { SHARE_TOKEN_RE } from "@/lib/gameShares";
import { mapThumbnail, truncate } from "@/lib/og/mapThumbnail";
import { sharedResultWord, type SharedGameAnalysis } from "@/lib/sharedGame";

/**
 * Link preview card for a shared game: result, matchup, map art, both
 * builds and the macro score, from the same redacted payload as the page
 * (no names, rounded ratings). A missing or turned-off link renders a
 * neutral card, so the image never reveals whether a link exists. Cached
 * for a minute at most, so a turned-off link stops previewing soon.
 *
 * Satori: inline colours, ``display:flex`` on every multi-child div.
 */

export const alt = "A StarCraft II game shared on SC2 Tools";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BG = "rgb(6, 9, 14)";
const SURFACE = "rgb(12, 16, 23)";
const LINE = "rgb(28, 36, 48)";
const TEXT = "rgb(231, 237, 240)";
const MUTED = "rgb(154, 163, 178)";
const CYAN = "rgb(60, 224, 214)";
const TEAL = "rgb(21, 125, 140)";
const WIN = "rgb(40, 160, 107)";
const LOSS = "rgb(218, 65, 80)";
const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ||
  process.env.SC2TOOLS_API_BASE ||
  "http://localhost:8080";

export default async function SharedGameOpenGraphImage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const share = SHARE_TOKEN_RE.test(token) ? await load(token) : null;
  const game = share?.game ?? null;
  const thumb = game?.map ? await mapThumbnail(game.map) : null;
  const result = game ? sharedResultWord(game.result) : null;
  const accent = game?.result === "Win" ? WIN : game?.result === "Loss" ? LOSS : CYAN;
  const builds = game ? [game.myBuild || "Unclassified", game.oppStrategy || "Unknown strategy"].join("  vs  ") : null;

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between",
        background: `radial-gradient(1000px 500px at 100% 0%, rgba(21, 125, 140, 0.3) 0%, ${BG} 55%), ${BG}`, padding: "56px 72px", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ width: 14, height: 40, borderRadius: 6, background: accent, display: "flex" }} />
          <div style={{ display: "flex", fontSize: 28, letterSpacing: 4, color: CYAN, fontWeight: 700, textTransform: "uppercase" }}>
            SC2 Tools · Shared game
          </div>
          {game?.matchup ? (
            <div style={{ display: "flex", marginLeft: 8, padding: "6px 18px", borderRadius: 999, border: `2px solid ${TEAL}`, color: TEXT, fontSize: 28, fontWeight: 700 }}>
              {game.matchup}
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", gap: 36, alignItems: "center" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, flex: 1 }}>
            <div style={{ display: "flex", fontSize: 76, fontWeight: 800, color: accent, lineHeight: 1.05 }}>
              {game ? (result ?? "Game") : "A shared StarCraft II game"}
            </div>
            <div style={{ display: "flex", fontSize: 34, fontWeight: 700, color: TEXT }}>
              {game ? truncate(game.map ? `on ${game.map}` : "Replay analysis", 48) : "Map replay and analysis, no account needed"}
            </div>
            {builds ? <div style={{ display: "flex", fontSize: 26, color: MUTED }}>{truncate(builds, 80)}</div> : null}
          </div>
          {thumb ? (
            // Satori draws plain <img> elements only; next/image does not apply.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumb} alt="" width={300} height={169} style={{ borderRadius: 18, border: `2px solid ${LINE}`, objectFit: "cover" }} />
          ) : null}
        </div>

        <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
          {game && typeof game.macroScore === "number" ? <Stat label="Macro score" value={String(Math.round(game.macroScore))} /> : null}
          {game && typeof game.durationSec === "number" ? <Stat label="Length" value={clock(game.durationSec)} /> : null}
          <div style={{ display: "flex", alignItems: "center", marginLeft: "auto", color: CYAN, fontSize: 30, fontWeight: 700 }}>sc2tools.com</div>
        </div>
      </div>
    ),
    { ...size },
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "18px 28px", borderRadius: 20, background: SURFACE, border: `2px solid ${LINE}`, minWidth: 220 }}>
    <div style={{ display: "flex", fontSize: 22, letterSpacing: 2, textTransform: "uppercase", color: MUTED }}>{label}</div>
    <div style={{ display: "flex", fontSize: 48, fontWeight: 800, color: TEXT }}>{value}</div>
  </div>;
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

async function load(token: string): Promise<SharedGameAnalysis | null> {
  try {
    const res = await fetch(`${API_BASE}/v1/shares/${encodeURIComponent(token)}`, {
      headers: { accept: "application/json" },
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return (await res.json()) as SharedGameAnalysis;
  } catch {
    return null;
  }
}
