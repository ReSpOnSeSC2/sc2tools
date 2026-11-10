"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { BarChart3 } from "lucide-react";
import { MapArtwork, MapLabel } from "@/components/maps/MapArtwork";
import { PlayerCopyButton } from "@/components/public-profile/PlayerCopyButton";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { StatCard } from "@/components/ui/Stat";
import { API_BASE } from "@/lib/clientApi";
import { fmtMinutes, macroScoreTone } from "@/lib/format";
import { sharedGameTitle, type SharedGameAnalysis } from "@/lib/sharedGame";

const SharedGameDetails = dynamic(() => import("./SharedGameDetails").then((value) => value.SharedGameDetails), {
  loading: () => <div role="status" aria-label="Loading the game analysis" className="h-96 animate-pulse rounded-xl bg-bg-elevated motion-reduce:animate-none" />,
});

/**
 * The public page of one shared game: what happened (result, matchup,
 * map, builds, macro), then the map replay, league benchmark, timeline,
 * mechanics and both build orders. Everything comes from the share's
 * redacted payload; the opponent is a race and a rounded rating.
 */
export function SharedGameView({ token, data, initialTimeSec = null }: {
  token: string; data: SharedGameAnalysis; initialTimeSec?: number | null;
}) {
  const { game } = data;
  const [seek, setSeek] = useState<{ t: number; seq: number } | null>(null);
  const sequence = useRef(0);
  const onSeek = useCallback((t: number) => setSeek({ t, seq: ++sequence.current }), []);
  useShareViewBeacon(token);
  const resultTone = game.result === "Win" ? "text-success" : game.result === "Loss" ? "text-danger" : "text-text";
  const played = game.playedOn ? new Date(`${game.playedOn}T12:00:00Z`).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : null;
  return (
    <article className="space-y-6">
      <Card variant="feature" padded={false} className="relative overflow-hidden">
        <MapArtwork mapName={game.map} size="hero" eager className="pointer-events-none absolute inset-0 border-0 opacity-35" />
        <span aria-hidden className="absolute inset-0 bg-gradient-to-r from-bg-surface via-bg-surface/95 to-bg-surface/65" />
        <div className="relative space-y-4 p-5 sm:p-7">
          <p className="inline-flex flex-wrap items-center gap-2 text-caption font-semibold text-text-muted">
            <BarChart3 className="h-4 w-4" aria-hidden /> Shared game
            {game.result ? <Badge size="sm" variant={game.result === "Win" ? "success" : game.result === "Loss" ? "danger" : "neutral"}>{game.result}</Badge> : null}
          </p>
          <h1 className="break-words font-display text-h2 font-bold text-text">{sharedGameTitle(game)}</h1>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-text-muted">
            <span>{game.playerLabel} vs {game.opponentLabel}</span>
            {game.map ? <><span aria-hidden>·</span><MapLabel name={game.map} size="xs" /></> : null}
            {played ? <><span aria-hidden>·</span><span>{played}</span></> : null}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="accent" size="md">Player: {game.myBuild || "Unclassified"}</Badge>
            <Badge variant="neutral" size="md">Opponent: {game.oppStrategy || "Unknown strategy"}</Badge>
            <PlayerCopyButton path={`/g/${token}`} label="Copy link" />
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Result" value={<span className={resultTone}>{game.result ?? "Unknown"}</span>} size="sm" />
        <StatCard label="Length" value={fmtMinutes(game.durationSec)} size="sm" />
        <StatCard label="Ratings" value={<span className="tabular-nums">{approx(game.playerMmr)} vs {approx(game.opponentMmr)}</span>} hint="rounded to 100" size="sm" />
        <StatCard label="Macro score" value={<span className={macroScoreTone(game.macroScore)}>{game.macroScore != null ? Math.round(game.macroScore) : "—"}</span>} hint="out of 100" size="sm" />
      </div>

      <SharedGameDetails token={token} data={data} seekRequest={seek} onSeek={onSeek} initialTimeSec={initialTimeSec} />

      <p className="text-center text-micro text-text-dim">
        Shared by the player. Opponents are never named here: ratings are rounded to the nearest 100 and the game is dated to the day.
      </p>
    </article>
  );
}

function approx(mmr: number | null): string {
  return typeof mmr === "number" && Number.isFinite(mmr) ? `~${mmr.toLocaleString("en-US")}` : "—";
}

/** Count one view per page load, from the browser (previews are not views). */
function useShareViewBeacon(token: string) {
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (sent.current === token) return;
    sent.current = token;
    void fetch(`${API_BASE}/v1/shares/${encodeURIComponent(token)}/views`, { method: "POST", keepalive: true, cache: "no-store" })
      .catch(() => undefined);
  }, [token]);
}
