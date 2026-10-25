"use client";

import Link from "next/link";
import Image from "next/image";
import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Button } from "@/components/ui/Button";
import { privateScouting, projectDockScouting } from "@/lib/liveScouting";
import type { LiveGameEnvelope } from "@/components/overlay/types";
import { ScoutingFacts } from "./ScoutingFacts";
import { ScoutingNotePopover } from "./ScoutingNotePopover";

export function ScoutingBriefCard({ live, unavailable = false, large = false, onRetry }: { live: LiveGameEnvelope | null; unavailable?: boolean; large?: boolean; onRetry?: () => void }) {
  const { userId } = useAuth();
  const data = projectDockScouting(live), details = privateScouting(live);
  const [expanded, setExpanded] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  if (!data) return <section aria-label="Live scouting" className="rounded-xl border border-border bg-bg-surface p-5"><h2 className="text-h3 font-semibold">Waiting for your next game</h2><p className="mt-2 text-body text-text-muted">Keep the paired desktop app running. Your brief appears when a human 1v1 loads.</p></section>;
  const compact = live?.phase === "match_in_progress" && !large && !expanded && !noteOpen;
  const race = data.race.toLowerCase();
  const seconds = typeof live?.displayTime === "number" && Number.isFinite(live.displayTime) ? Math.max(0, Math.floor(live.displayTime)) : null;
  const clock = seconds === null ? null : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return <section aria-label="Live scouting" className={`min-w-0 rounded-xl border border-border bg-bg-surface p-4 ${large ? "text-lg sm:p-7 [&_p]:text-lg sm:[&_p]:text-xl [&_li]:text-lg" : ""}`}>
    <div className={`flex min-w-0 items-center gap-2 ${compact ? "" : "flex-wrap"}`}>
      {["terran", "protoss", "zerg", "random"].includes(race) ? <Image src={`/icons/sc2/races/${race}.svg`} alt="" aria-hidden width={24} height={24} className="h-6 w-6 shrink-0" /> : null}
      <h2 className={`min-w-0 flex-1 font-semibold ${compact ? "truncate" : "basis-[calc(100%-2rem)] break-words [overflow-wrap:anywhere] sm:basis-auto"} ${large ? "text-h1" : "text-body-lg"}`}>{data.race ? `${data.race} · ` : ""}{data.name || "Identifying opponent…"}</h2>
      {clock ? <span aria-label="Game time" className={`${compact ? "hidden sm:inline" : ""} shrink-0 font-mono ${large ? "text-body-lg" : "text-caption"} text-text-muted`}>{clock}</span> : null}
      {compact ? <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>Brief</Button> : null}
      {!large ? <Link href="/app/live" className="ml-auto inline-flex min-h-11 shrink-0 items-center px-2 text-caption font-semibold text-accent underline">Second screen</Link> : null}
    </div>
    <div hidden={compact} className="mt-3 space-y-4">
      <div className="flex flex-wrap gap-2 text-caption text-text-muted">{data.aka && data.aka !== data.name ? <span>AKA {data.aka}</span> : null}<span>{data.mmr === null ? "MMR unavailable" : `${data.mmr.toLocaleString("en-US")} MMR`}</span>{data.league ? <span>· {data.league}</span> : null}{data.rival ? <span className="font-semibold text-text">{data.rival}</span> : null}{data.rematch ? <span className="font-semibold text-text">Rematch</span> : null}</div>
      {!data.enriched ? <div role="status" className="space-y-2 text-body text-text-muted"><p>{unavailable ? "Scouting history unavailable. The next update may recover it." : data.name ? "Looking up your shared history…" : "Pulse lookup pending…"}</p>{unavailable && onRetry ? <Button variant="secondary" size="sm" onClick={onRetry}>Retry scouting</Button> : <div aria-label="Loading scouting history" className="h-3 max-w-sm animate-pulse rounded bg-bg-elevated" />}</div> : <ScoutingFacts data={data} compactOnPhone={!large} />}
      {details.note ? <blockquote className="break-words rounded-lg border-l-4 border-accent bg-accent/5 p-3 text-body">{details.note}</blockquote> : null}
      {details.recent.length ? <div className="hidden space-y-2 sm:block"><h3 className="text-caption font-semibold text-text-muted">Last meetings</h3><div className="flex gap-1" aria-label="Last five results">{details.recent.map((row, i) => <span key={i} className="rounded border border-border px-2 py-1 text-caption">{row.result === "Win" ? "W" : row.result === "Loss" ? "L" : "T"}</span>)}</div><ul className="space-y-2">{details.recent.slice(0, 3).map((row, i) => <li key={row.gameId || i} className="rounded-lg border border-border p-2 text-caption">{row.gameId ? <Link href={`/app/game/${encodeURIComponent(row.gameId)}`} className="font-semibold text-accent underline">{row.map || "Previous game"}</Link> : <span>{row.map || "Previous game"}</span>} · {row.length || "Length unknown"}<p className="mt-1 break-words text-text-muted">{row.build || "Your build unknown"} vs {row.opener || "Their opener unknown"}</p></li>)}</ul></div> : null}
      <div className="flex flex-wrap items-center gap-2">{details.pulseId && details.writable ? <><Link href={`/app/opponents/${encodeURIComponent(details.pulseId)}`} className="inline-flex min-h-11 items-center rounded-full border border-border px-4 text-caption font-semibold">Open dossier</Link><ScoutingNotePopover key={`${userId}:${details.pulseId}`} pulseId={details.pulseId} initialNote={details.note} onOpenChange={setNoteOpen} /></> : <p className="text-caption text-text-muted">{details.pulseId ? "Dossier and notes unlock after this account’s first replay syncs." : "Dossier and notes unlock when the exact opponent account is known."}</p>}{expanded && !large ? <Button variant="ghost" size="sm" onClick={() => setExpanded(false)}>Collapse brief</Button> : null}</div>
    </div>
  </section>;
}
