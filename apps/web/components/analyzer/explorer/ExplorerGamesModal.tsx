"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { EmptyState } from "@/components/ui/Card";
import { useTrendsApi, useTrendsDataScope } from "@/lib/trendsDataContext";
import { filtersToQuery } from "@/lib/filterContext";
import type { ExplorerGame, ExplorerGamesResponse, ExplorerView } from "@/lib/trendsExplorer";
import type { ExplorerSegment } from "./ExplorerCharts";
import { ACTION_CLASS, ExplorerError, ExplorerLoading, formatCount, formatSeconds } from "./ExplorerPrimitives";

export function ExplorerGamesModal({ view, query, dbRev, segment, onClose }: {
  view: ExplorerView; query: Record<string, unknown>; dbRev: number; segment: ExplorerSegment; onClose: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const { isGlobal } = useTrendsDataScope();
  const { data, isLoading, error, mutate } = useTrendsApi<ExplorerGamesResponse>(`/v1/trends/explorer/${view}/games${filtersToQuery({ ...query, segment: segment.key, offset, limit: 20 })}#${dbRev}`);
  const count = data?.games.length ?? 0;
  const total = data?.total ?? 0;
  return <Modal open onClose={onClose} title={segment.label} description="Games behind this analysis, using the same filters and comparison settings." size="2xl" footer={<div className="flex w-full flex-wrap items-center justify-between gap-2"><p aria-live="polite" className="text-xs tabular-nums text-text-muted">{data ? count ? `${formatCount(offset + 1)}–${formatCount(offset + count)} of ${formatCount(total)} games` : "No matching games" : "Loading games…"}</p><div className="flex gap-2"><button type="button" aria-label="Previous games" className={ACTION_CLASS} onClick={() => setOffset(Math.max(0, offset - 20))} disabled={offset === 0 || isLoading}><ChevronLeft aria-hidden className="h-4 w-4" /><span className="hidden sm:inline">Previous</span></button><button type="button" aria-label="Next games" className={ACTION_CLASS} onClick={() => setOffset(offset + 20)} disabled={!data || offset + count >= total || isLoading}><span className="hidden sm:inline">Next</span><ChevronRight aria-hidden className="h-4 w-4" /></button></div></div>}>
    {error ? <ExplorerError message={error.message} retry={mutate} /> : isLoading ? <ExplorerLoading title="analysis games" /> : !count ? <EmptyState title="No games match this group" sub="The underlying history may have changed. Refresh the analysis to update its counts." /> : <>
      <div className="space-y-3 md:hidden">{data!.games.map((game, index) => <GameCard key={`${game.playerId}:${game.id}:${index}`} game={game} isGlobal={isGlobal} />)}</div>
      <div className="hidden overflow-hidden rounded-xl border border-border md:block"><table aria-label="Games behind the selected analysis" className="w-full table-fixed text-left text-xs"><thead className="bg-bg-elevated text-[11px] text-text-muted"><tr>{["Player / date", "Result", "Opponent", "MMR", "Map / build", "Length"].map((label) => <th key={label} scope="col" className={`px-3 py-3 font-medium ${label === "Result" || label === "Length" ? "w-[11%]" : label === "MMR" ? "w-[14%]" : ""}`}>{label}</th>)}</tr></thead><tbody>{data!.games.map((game, index) => <tr key={`${game.playerId}:${game.id}:${index}`} className="border-t border-border"><td className="px-3 py-3"><p className="truncate font-medium text-text" title={game.playerName || game.playerId || ""}>{game.playerName || (isGlobal ? game.playerId || "Unknown player" : "Your account")}</p><p className="mt-1 text-[10px] text-text-dim">{formatDate(game.date)}</p></td><td className="px-3 py-3"><Result value={game.result} /></td><td className="px-3 py-3"><p className="truncate text-text" title={game.opponent || ""}>{game.opponent || "Unknown opponent"}</p><p className="mt-1 text-[10px] text-text-dim">{game.myRace || "?"} vs {game.oppRace || "?"}</p></td><td className="px-3 py-3 tabular-nums text-text-muted"><p>{formatCount(game.myMmr)}</p><p className="mt-1 text-[10px] text-text-dim">vs {formatCount(game.opponentMmr)}</p></td><td className="px-3 py-3"><p className="truncate text-text-muted" title={game.map || ""}>{game.map || "Unknown map"}</p><p className="mt-1 truncate text-[10px] text-text-dim" title={game.build || ""}>{game.build || "Unclassified build"}</p></td><td className="px-3 py-3 tabular-nums text-text-muted">{formatSeconds(game.durationSec)}</td></tr>)}</tbody></table></div>
    </>}
  </Modal>;
}

function formatDate(value: string | null) { if (!value) return "Date unavailable"; const date = new Date(value); return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); }
function Result({ value }: { value: string | null }) { const win = /^(win|victory)$/i.test(value ?? ""); const loss = /^(loss|defeat)$/i.test(value ?? ""); return <span className={`inline-flex rounded-md px-2 py-1 text-[11px] font-semibold ${win ? "bg-success/10 text-success" : loss ? "bg-danger/10 text-danger" : "bg-bg-elevated text-text-muted"}`}>{value || "Unknown"}</span>; }
function GameCard({ game, isGlobal }: { game: ExplorerGame; isGlobal: boolean }) {
  return <article className="rounded-xl border border-border p-3"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-xs font-semibold text-text">{game.playerName || (isGlobal ? game.playerId || "Unknown player" : "Your account")}</p><p className="mt-1 text-[10px] text-text-dim">{formatDate(game.date)}</p></div><Result value={game.result} /></div><p className="mt-3 break-words text-xs text-text">vs {game.opponent || "Unknown opponent"}<span className="ml-1 text-text-dim">({game.myRace || "?"} vs {game.oppRace || "?"})</span></p><div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] tabular-nums text-text-muted"><span>MMR {formatCount(game.myMmr)} vs {formatCount(game.opponentMmr)}</span><span>{formatSeconds(game.durationSec)}</span></div><p className="mt-2 break-words text-[11px] text-text-dim">{game.map || "Unknown map"} · {game.build || "Unclassified build"}</p></article>;
}
