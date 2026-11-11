import { shareReportPalette } from "@/lib/shareReportPalette";
import { ImageResponse } from "next/og";
import { resultLabel } from "@/components/analyzer/game/types";
import { fmtMinutes } from "@/lib/format";
import { readPublicReplayCard } from "@/lib/publicReplayCard";
import { sharedReplayMap } from "@/lib/sharedReplayTitle";
import ArchiveOpenGraphImage from "../opengraph-image";

export const alt = "Shared StarCraft II replay on SC2 Tools";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const revalidate = 0;
export const dynamic = "force-dynamic";

function truncate(value: string, max: number) {
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}

export default async function ReplayCardImage({ params }: { params: Promise<{ player: string; gameId: string }> }) {
  const { player, gameId } = await params;
  const { data } = await readPublicReplayCard(player, gameId).catch(() => ({ data: null }));
  if (!data) return ArchiveOpenGraphImage({ params: Promise.resolve({ player }) });
  const { profile, game } = data;
  const result = resultLabel(game.result);
  const tone = result === "Win" ? shareReportPalette.replayWin : result === "Loss" ? shareReportPalette.replayLoss : shareReportPalette.replayAccent;
  const details = [result === "Unknown" ? null : result, sharedReplayMap(game.map), game.durationSec === null ? null : fmtMinutes(game.durationSec)]
    .filter(Boolean).join(" · ");
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between",
      padding: "64px 76px", color: shareReportPalette.replayText, backgroundColor: shareReportPalette.replayBackgroundColor,
      backgroundImage: shareReportPalette.replayBackgroundImage,
      fontFamily: "sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <div style={{ width: 14, height: 42, borderRadius: 7, background: tone }} />
        <div style={{ fontSize: 28, color: tone, fontWeight: 800 }}>SC2 TOOLS · SHARED REPLAY</div>
        {game.matchup ? <div style={{ display: "flex", marginLeft: "auto", padding: "8px 16px", border: shareReportPalette.replayBorder,
          borderRadius: 999, fontSize: 26, color: shareReportPalette.replayAccent }}>{game.matchup}</div> : null}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", fontSize: 70, lineHeight: 1.05, fontWeight: 800 }}>{truncate(profile.displayName, 30)}&apos;s replay</div>
        {details ? <div style={{ display: "flex", color: shareReportPalette.replayMuted, fontSize: 30 }}>{truncate(details, 56)}</div> : null}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 25 }}>
        {game.myBuild ? <div style={{ display: "flex" }}>Player build · {truncate(game.myBuild, 50)}</div> : null}
        {game.oppStrategy ? <div style={{ display: "flex" }}>Opponent strategy · {truncate(game.oppStrategy, 45)}</div> : null}
      </div>
    </div>,
    { ...size, headers: { "Cache-Control": "private, no-store, max-age=0" } },
  );
}
