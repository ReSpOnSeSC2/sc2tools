import type { ReplayLibraryResponse } from "@/components/analyzer/replays/types";
import { fmtMinutes, pct, wrColor } from "@/lib/format";
import { archiveFilterLabels, type PublicReplayQuery } from "./archiveQuery";

export function ArchiveSummary({ data, query }: { data: ReplayLibraryResponse; query: PublicReplayQuery }) {
  const summary = data.summary; const decided = summary ? summary.wins + summary.losses : 0;
  const labels = archiveFilterLabels(query).filter((filter) => filter.key !== "sort").map((filter) => filter.label);
  const page = query.cursor ? query.page : 1;
  const first = ((page ?? 1) - 1) * 25 + 1; const last = first + data.items.length - 1;
  return <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-bg-elevated/35 px-4 py-2.5 text-caption text-text-muted">
    {summary && summary.total > 0 ? <p aria-label="Filtered replay record">
      {labels.length ? `${labels.join(" · ")}: ` : ""}<span className="font-semibold text-text">{summary.total}</span> replay{summary.total === 1 ? "" : "s"}
      {!query.result && decided > 0 ? <> · <span className="text-success">{summary.wins}</span>–<span className="text-danger">{summary.losses}</span> · <span style={{ color: wrColor(summary.wins / decided, decided) }}>{pct(summary.wins / decided)}</span></> : null}
      {summary.ties > 0 ? ` · ${summary.ties} ${summary.ties === 1 ? "tie" : "ties"}` : ""}{summary.avgDurationSec !== null ? ` · avg ${fmtMinutes(Math.round(summary.avgDurationSec))}` : ""}
    </p> : <span />}
    {data.items.length ? <p>{page === undefined ? "Showing more" : `Page ${page} · Showing ${first}–${last}`}</p> : null}
  </div>;
}
