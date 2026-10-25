"use client";
import type { LiveGameEnvelope } from "@/components/overlay/types";
import { projectDockScouting } from "@/lib/liveScouting";
import { ScoutingFacts } from "@/components/scouting/ScoutingFacts";

/** Token-authenticated presentation: consume only the explicit public projection. */
export function DockScout({ live }: { live: LiveGameEnvelope | null }) {
  const data = projectDockScouting(live);
  if (!data) return <p className="text-caption text-text-muted">Waiting for your next game.</p>;
  return <div className="space-y-3"><h3 className="break-words text-body font-semibold">{data.name || "Identifying opponent…"}</h3><p className="text-caption text-text-muted">{data.race} · {data.mmr === null ? "MMR unavailable" : `${data.mmr} MMR`}{data.league ? ` · ${data.league}` : ""}</p>{data.enriched ? <ScoutingFacts data={data} /> : <p className="text-caption text-text-muted">Looking up shared history…</p>}</div>;
}
