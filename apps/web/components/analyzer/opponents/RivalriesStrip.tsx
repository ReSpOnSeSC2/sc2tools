"use client";
import { chooseRivalries, type RivalryRow } from "@/lib/opponentRivalries";
import { pct1 } from "@/lib/format";
import { OpponentLink } from "./OpponentTableRows";
import type { OpenOpponent } from "./types";

export function RivalriesStrip({ rows, onOpen, incomplete, recentAvailable }: { rows: RivalryRow[]; onOpen: OpenOpponent; incomplete: boolean; recentAvailable: boolean }) {
  const selected = chooseRivalries(rows);
  return <section aria-label="Rivalries"><h2 className="mb-1 text-sm font-semibold">Rivalries</h2><p className="mb-2 text-xs text-text-dim">Current filters and grouping. Nemesis and favourite use 95% Wilson bounds on decided games.</p><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{([
    ["nemesis", "Nemesis", "At least 4 decided games"], ["favourite", "Favourite opponent", "Highest Wilson lower bound"], ["most-played", "Most played", "Most meetings"], ["hot-rematch", "Hot rematch", "At least 2 meetings in 7 days"],
  ] as const).map(([kind, label, hint]) => {
    const row = selected[kind];
    return <div key={kind} className="rounded-xl border-2 border-line bg-bg-surface p-3"><h3 className="text-micro uppercase tracking-wider text-text-dim">{label}</h3>{incomplete ? <p className="mt-1 text-caption text-text-muted">Waiting for complete history</p> : kind === "hot-rematch" && !recentAvailable ? <p className="mt-1 text-caption text-text-muted">Recent meeting counts unavailable</p> : row ? <OpponentLink opponent={row} onOpen={onOpen} className="mt-1 block min-h-11 rounded focus-visible:ring-2 focus-visible:ring-accent"><span className="block truncate font-semibold">{row.name || "unnamed"}</span><span className="text-caption text-text-muted">{row.wins}–{row.losses} · {pct1(row.wins / Math.max(1, row.wins + row.losses))} · {row.games} games</span></OpponentLink> : <p className="mt-1 text-caption text-text-muted">No qualifying opponent</p>}<p className="mt-1 text-micro text-text-dim">{hint}</p></div>;
  })}</div></section>;
}
