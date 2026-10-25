"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { useApi } from "@/lib/clientApi";
import { gameAnalysisHref, type OpponentNavigationContext } from "@/lib/opponentNavigation";
import { isGameNeighborScope, type GameNeighborScope, type GameSource } from "@/lib/gameNavigation";
import type { GameSummary } from "./types";

const SCOPE_KEY = "sc2tools:game-neighbor-scope:v1";
const FILTER_KEYS = new Set(["since", "until", "patch_era", "race", "opp_race", "map", "mmr_min", "mmr_max", "opp_strategy", "group_by_race_played", "build", "leak", "macro_min", "macro_max", "min_minutes", "max_minutes", "exclude_too_short", "regions", "map_pool", "game_size", "result", "matchup", "q"]);
type Neighbors = { prev: GameSummary | null; next: GameSummary | null; h2h?: { wins: number; losses: number } | null };

export function ownerNeighborPath(gameId: string, scope: GameNeighborScope, source?: GameSource | null): string {
  const query = new URLSearchParams({ scope });
  if (source) for (const [key, value] of new URL(source.href, "https://sc2tools.invalid").searchParams) {
    if (FILTER_KEYS.has(key) && value.length <= 256) query.append(key, value);
  }
  return `/v1/games/${encodeURIComponent(gameId)}/neighbors?${query}`;
}

export function GameNavigation({ game, source, opponentContext, buildLabel }: {
  buildLabel?: string | null;
  game: GameSummary; source?: GameSource | null; opponentContext?: OpponentNavigationContext | null;
}) {
  const router = useRouter();
  const [scope, setScope] = useState<GameNeighborScope>(opponentContext ? "opponent" : "all");
  const selectId = useId();
  useEffect(() => {
    try { const saved = localStorage.getItem(SCOPE_KEY); if (isGameNeighborScope(saved)) setScope(saved); } catch { /* Optional device preference. */ }
  }, []);
  const request = useApi<Neighbors>(`${ownerNeighborPath(game.gameId, scope, source)}${scope === "build" ? `#${encodeURIComponent(buildLabel ?? game.myBuild ?? "")}` : ""}`, { revalidateOnFocus: false, keepPreviousData: false });
  const data = request.isPreviousData || request.error ? undefined : request.data;
  const href = (neighbor?: GameSummary | null) => neighbor ? gameAnalysisHref(neighbor.gameId, opponentContext, source) : null;
  const olderHref = href(data?.prev); const newerHref = href(data?.next);
  useEffect(() => { if (newerHref) router.prefetch?.(newerHref); }, [newerHref, router]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented || event.isComposing || !(event.target instanceof Element) || event.target.closest("input,textarea,select,[contenteditable]:not([contenteditable='false'])") || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const target = event.key === "ArrowLeft" ? olderHref : event.key === "ArrowRight" ? newerHref : null;
      if (target) { event.preventDefault(); router.push(target); }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [olderHref, newerHref, router]);
  const record = data?.h2h;
  return <nav aria-label="Move between games" className="flex flex-wrap items-center gap-2 text-caption">
    {([["‹ Older", olderHref, "Alt+ArrowLeft"], ["Newer ›", newerHref, "Alt+ArrowRight"]] as const).map(([label, target, shortcut]) => target ? <Link key={label} href={target} prefetch={false} title={`${label} (${shortcut.replace("Arrow", "")})`} aria-keyshortcuts={shortcut} className="inline-flex min-h-11 items-center rounded-md border border-border bg-bg-surface px-3 font-semibold hover:border-accent">{label}</Link> : <span key={label} aria-disabled="true" className="inline-flex min-h-11 items-center rounded-md border border-border px-3 text-text-dim">{label}</span>)}
    <label htmlFor={selectId} className="sr-only">Games to step through</label>
    <select id={selectId} value={scope} onChange={(event) => {
      if (!isGameNeighborScope(event.target.value)) return;
      setScope(event.target.value); try { localStorage.setItem(SCOPE_KEY, event.target.value); } catch { /* Navigation still works. */ }
    }} className="min-h-11 max-w-full rounded-md border border-border bg-bg-surface px-3 text-text">
      <option value="all">All games</option><option value="opponent">Same opponent</option><option value="matchup">Same matchup</option><option value="build">Same build</option>
    </select>
    {record && Number.isInteger(record.wins) && Number.isInteger(record.losses) && record.wins >= 0 && record.losses >= 0 ? <span className="rounded-full border border-border bg-bg-surface px-3 py-1 tabular-nums" title="Your recorded wins and losses against this opponent, across all time">H2H {record.wins}–{record.losses} all-time</span> : null}
    {request.error ? <p role="status" className="text-text-muted">Couldn't load nearby games. <button type="button" onClick={() => { void request.mutate(); }} className="inline-flex min-h-11 items-center text-accent underline">Retry</button></p> : request.isLoading ? <span role="status" className="text-text-dim">Finding nearby games…</span> : null}
  </nav>;
}
