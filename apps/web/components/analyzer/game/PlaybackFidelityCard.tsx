"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { formatClock } from "@/lib/replayHud";
import type { MapReplayController, PlaybackPhase } from "@/lib/useMapReplay";
import { MISSING_PLAYBACK_HINT, RECORDED_PLAYBACK_EXPLAINER } from "@/lib/playbackFidelity";

const STEPS = ["Requested", "Recording in StarCraft", "Uploading", "Ready"];
export function PlaybackFidelityCard({ controller, recorded, missing, upgrade = !recorded }: {
  controller: MapReplayController; recorded: boolean; missing?: boolean; upgrade?: boolean;
}) {
  const { refreshing, refreshMessage, canRefresh, refresh, recordingStartedAt, agentPresence = "unknown" } = controller;
  const phase: PlaybackPhase = controller.phase ?? (refreshing ? "requested" : recorded ? "ready" : "idle");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!refreshing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [refreshing]);
  const step = phase === "recording" ? 1 : phase === "uploading" ? 2 : phase === "ready" ? 3 : 0;
  return <aside aria-label="Playback quality" className="space-y-3 rounded-lg border border-border bg-bg-elevated/40 p-3 text-caption">
    <div className="flex flex-wrap items-center gap-3">
      <Badge variant={recorded ? "success" : "neutral"}>{recorded ? "Recorded playback" : "Standard"}</Badge>
      <span className="text-text-muted">{agentPresence === "online" ? "Desktop app online" : agentPresence === "offline" ? "Desktop app offline" : "Desktop connection not confirmed"}</span>
      {canRefresh && (upgrade || refreshing || Boolean(refreshMessage)) ? <Button variant="secondary" size="sm" disabled={refreshing || agentPresence === "offline"} aria-label={refreshing ? "Recording replay…" : "Generate accurate playback"} onClick={() => void refresh()}>{refreshing ? "Recording replay…" : recorded ? "Refresh recording" : "Upgrade playback"}</Button> : null}
    </div>
    {missing ? <p className="text-text-muted">{MISSING_PLAYBACK_HINT}</p> : null}
    {refreshing || phase === "ready" || phase === "failed" ? <ol aria-label="Recording progress" className="flex flex-wrap gap-x-4 gap-y-2">{STEPS.map((label, index) => <li key={label} aria-current={phase !== "failed" && index === step ? "step" : undefined} className={index === step ? "font-semibold text-text" : "text-text-dim"}>{index + 1}. {label}{index === 1 && phase === "recording" && recordingStartedAt ? ` · ${formatClock(Math.max(0, now - recordingStartedAt) / 1000)} elapsed` : ""}</li>)}</ol> : null}
    {refreshMessage ? <p role="status" className="text-text-muted">{refreshMessage}</p> : null}
    <details data-playback-explainer><summary className="min-h-11 cursor-pointer py-2 font-medium text-accent">What happens?</summary><p>{RECORDED_PLAYBACK_EXPLAINER}</p><p className="mt-2">Desktop app: Settings → Map replay. <LazyHelpLink slug="game-page-accurate-playback">Recorded and standard playback help</LazyHelpLink></p></details>
  </aside>;
}
