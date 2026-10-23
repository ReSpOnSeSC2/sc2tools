"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { MacroBreakdownData } from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import type { GameBuildOrderResponse, GameSummary } from "./types";
import { matchupLabel } from "./gameTitle";

export function GameExportMenu({ game, buildOrders, macroBreakdown, pending = false }: {
  game: GameSummary; buildOrders?: GameBuildOrderResponse | null; macroBreakdown?: MacroBreakdownData | null; pending?: boolean;
}) {
  const root = useRef<HTMLDetailsElement>(null), summary = useRef<HTMLElement>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (root.current && !root.current.contains(event.target as Node)) root.current.open = false; };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  const download = async (kind: "stats" | "casualties" | "json") => {
    if (root.current) root.current.open = false; summary.current?.focus(); setMessage("");
    try {
      const format = await import("@/lib/gameExport");
      const text = kind === "stats" ? format.statsToCsv(macroBreakdown?.stats_events, macroBreakdown?.opp_stats_events) : kind === "casualties" ? format.casualtiesToCsv(macroBreakdown?.casualty_events) : format.gameToJson({ game, buildOrders, macroBreakdown });
      const filename = format.gameExportFilename(game.date, matchupLabel(game.myRace, game.opponent?.race), game.map);
      const url = URL.createObjectURL(new Blob([text], { type: kind === "json" ? "application/json;charset=utf-8" : "text/csv;charset=utf-8" }));
      const link = document.createElement("a"); link.href = url; link.download = `${filename}.${kind === "json" ? "json" : `${kind}.csv`}`; document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setMessage("Couldn't prepare this download. Please try again."); }
  };
  const actionClass = "block min-h-11 w-full rounded px-3 py-2 text-left text-caption hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50";
  return <div><details ref={root} className="relative" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); if (root.current) root.current.open = false; summary.current?.focus(); } }}>
    <summary ref={summary} className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-lg border border-border px-3 text-caption font-semibold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">Export <ChevronDown className="h-3.5 w-3.5" aria-hidden /></summary>
    <div className="absolute right-0 z-30 mt-1 w-52 rounded-lg border border-border bg-bg-surface p-1 shadow-lg">
      <p className="px-3 py-2 text-micro text-text-muted">Includes available replay data.</p>
      <button type="button" className={actionClass} disabled={!macroBreakdown?.stats_events?.length && !macroBreakdown?.opp_stats_events?.length} onClick={() => void download("stats")}>Stats CSV</button>
      <button type="button" className={actionClass} disabled={!Array.isArray(macroBreakdown?.casualty_events)} onClick={() => void download("casualties")}>Casualties CSV</button>
      <button type="button" className={actionClass} disabled={pending} onClick={() => void download("json")}>Full JSON</button>
    </div>
  </details>{message ? <p role="status" className="text-caption text-danger">{message}</p> : null}</div>;
}
