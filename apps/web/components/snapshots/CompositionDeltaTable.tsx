"use client";

import { useMemo, useState } from "react";
import { Card } from "@/components/ui/Card";
import { fmtTick, type DeltaRow, type GameTick } from "./shared/snapshotTypes";

// Sortable per-unit delta table. Defaults to sorting by absolute
// delta (matches the API response). Click headers to flip. On
// mobile collapses to two columns (unit + delta); desktop shows
// all four.

type SortKey = "unit" | "mine" | "median" | "delta";
type SortDir = "asc" | "desc";

export interface CompositionDeltaTableProps {
  focusedTick: number | null;
  ticks: GameTick[];
  side: "my" | "opp";
}

export function CompositionDeltaTable({
  focusedTick,
  ticks,
  side,
}: CompositionDeltaTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("delta");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const focusRow = useMemo(() => {
    if (focusedTick === null) return null;
    return ticks.find((t) => t.t === focusedTick) || null;
  }, [focusedTick, ticks]);

  const rows = useMemo(() => {
    const list: DeltaRow[] = focusRow?.compositionDelta?.[side] || [];
    const copy = [...list];
    copy.sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      if (sortKey === "unit") {
        return sortDir === "asc"
          ? String(av).localeCompare(String(bv))
          : String(bv).localeCompare(String(av));
      }
      return sortDir === "asc" ? Number(av) - Number(bv) : Number(bv) - Number(av);
    });
    return copy;
  }, [focusRow, side, sortKey, sortDir]);

  function toggleSort(k: SortKey) {
    if (sortKey === k) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(k);
      setSortDir(k === "unit" ? "asc" : "desc");
    }
  }

  if (focusedTick === null) {
    return (
      <Card title={`Composition vs winners — ${side === "my" ? "you" : "opponent"}`}>
        <p className="py-3 text-center text-caption text-text-dim">
          Tap a tick on the timeline to compare composition.
        </p>
      </Card>
    );
  }
  if (!focusRow || !focusRow.compositionDelta) {
    return (
      <Card title={`Composition vs winners — ${side === "my" ? "you" : "opponent"}`}>
        <p className="py-3 text-center text-caption text-text-dim">
          No composition data at {fmtTick(focusedTick)} for this cohort.
        </p>
      </Card>
    );
  }

  return (
    <Card
      title={`Composition vs winners @ ${fmtTick(focusedTick)} — ${
        side === "my" ? "you" : "opponent"
      }`}
    >
      <table className="w-full text-caption" aria-label="Per-unit deltas">
        <thead>
          <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-text-dim">
            <ThSortable label="Unit" k="unit" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} />
            <ThSortable label="You" k="mine" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
            <ThSortable label="Winners (median)" k="median" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" className="hidden sm:table-cell" />
            <ThSortable label="Δ" k="delta" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className="py-3 text-center text-text-dim">
                No units recorded at this tick.
              </td>
            </tr>
          ) : (
            rows.slice(0, 25).map((r) => (
              <tr key={r.unit} className="border-b border-border/40 last:border-b-0">
                <td className="py-2 font-medium text-text">{r.unit}</td>
                <td className="py-2 text-right tabular-nums text-text">
                  {Math.round(r.mine)}
                </td>
                <td className="hidden py-2 text-right tabular-nums text-text-muted sm:table-cell">
                  {round1(r.cohortWinnerMedian)}
                </td>
                <td
                  className="py-2 text-right tabular-nums font-semibold"
                  style={{ color: deltaColor(r.delta) }}
                >
                  {r.delta > 0 ? "+" : ""}
                  {round1(r.delta)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-text-dim">
        Similarity to winner deck:{" "}
        <span className="font-semibold text-text">
          {Math.round((focusRow.compositionDelta?.[side === "my" ? "mySimilarity" : "oppSimilarity"] ?? 0) * 100)}%
        </span>
      </p>
    </Card>
  );
}

function ThSortable({
  label,
  k,
  sortKey,
  sortDir,
  onClick,
  align,
  className,
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onClick: (k: SortKey) => void;
  align?: "left" | "right";
  className?: string;
}) {
  const active = sortKey === k;
  return (
    <th
      scope="col"
      className={[
        "px-2 py-2 font-medium",
        align === "right" ? "text-right" : "text-left",
        className || "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        type="button"
        onClick={() => onClick(k)}
        className={[
          "inline-flex items-center gap-1",
          active ? "text-text" : "text-text-dim hover:text-text",
        ].join(" ")}
      >
        {label}
        {active ? <span aria-hidden>{sortDir === "asc" ? "▲" : "▼"}</span> : null}
      </button>
    </th>
  );
}

function sortValue(r: DeltaRow, k: SortKey): number | string {
  if (k === "unit") return r.unit;
  if (k === "mine") return r.mine;
  if (k === "median") return r.cohortWinnerMedian;
  return Math.abs(r.delta);
}

function deltaColor(d: number): string {
  if (d > 1) return "#22c55e";
  if (d > 0) return "#4ade80";
  if (d < -1) return "#ef4444";
  if (d < 0) return "#fb923c";
  return "#9aa3b2";
}

function round1(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(1);
}
