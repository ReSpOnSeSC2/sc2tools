"use client";

import { isLowSample } from "@/lib/charts/theme";
import { ChartFrame } from "./ChartFrame";

/** The endpoint supplies newest-first outcomes, not timestamps. Keep that
 * order explicit without inventing dates or a continuous performance curve. */
export function FormSparkline({ results, title = "Recent form" }: { results?: ("win" | "loss")[]; title?: string }) {
  if (!results?.length) return <span className="text-micro text-text-dim">no recent</span>;
  const rows = [...results].reverse().map((result, index) => ({ result, game: index + 1 }));
  const summary = `Recent form, oldest to newest: ${rows.map(row => row.result).join(", ")}`;
  const small = isLowSample(rows.length);
  return <ChartFrame title={title} summary={summary} rows={rows} columns={[
    { key: "game", label: "Game, oldest first", render: row => row.game },
    { key: "result", label: "Result", render: row => row.result === "win" ? "Win" : "Loss" },
  ]}>
    <div className="flex flex-wrap items-center gap-1" role="img" aria-label={summary} data-small-sample={small}>
      {rows.map(row => <span key={row.game} aria-hidden="true" data-hollow={small} title={`${row.game}: ${row.result}`} style={{ width: 12, height: 12,
        border: `2px ${row.result === "win" ? "solid" : "dashed"} rgb(var(--${row.result === "win" ? "success" : "danger"}))`, borderRadius: row.result === "win" ? 9999 : 2,
        background: small ? "rgb(var(--bg-surface))" : `rgb(var(--${row.result === "win" ? "success" : "danger"}))` }} />)}
    </div>
  </ChartFrame>;
}
