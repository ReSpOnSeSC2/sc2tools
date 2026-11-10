"use client";

import { Card, Skeleton } from "@/components/ui/Card";
import { formatApm } from "@/lib/apm";
import { formatSigned } from "@/components/analyzer/macro/timelineMetrics";
import type { CompareMechanics } from "@/lib/gameCompare";
import type { CompareSide } from "./useCompareSide";

interface MechanicRow {
  key: string;
  label: string;
  value: (m: CompareMechanics) => number | null;
  show: (m: CompareMechanics) => string;
  /** Whether a higher number is the better one (decides nothing visual
   *  beyond the sr-only wording; the delta keeps its sign). */
  higherIsBetter: boolean;
}

const ROWS: readonly MechanicRow[] = [
  { key: "macro", label: "Macro score", value: (m) => m.macroScore, show: (m) => (m.macroScore === null ? "—" : String(Math.round(m.macroScore))), higherIsBetter: true },
  { key: "sq", label: "SQ (Spending Quotient)", value: (m) => m.sq, show: (m) => (m.sq === null ? "—" : String(Math.round(m.sq))), higherIsBetter: true },
  { key: "blocked", label: "Supply blocked", value: (m) => m.supplyBlockedSec, show: (m) => (m.supplyBlockedSec === null ? "—" : `${m.supplyBlockedSec} s`), higherIsBetter: false },
  {
    key: "mechanic", label: "Injects / chronos / MULEs", value: (m) => m.mechanic?.actual ?? null,
    show: (m) => (m.mechanic ? `${m.mechanic.label}: ${Math.round(m.mechanic.actual)}${m.mechanic.expected !== null ? ` of ${Math.round(m.mechanic.expected)}` : ""}` : "—"),
    higherIsBetter: true,
  },
  { key: "apm", label: "APM", value: (m) => m.apm, show: (m) => (m.apm === null ? "—" : formatApm(m.apm)), higherIsBetter: true },
];

function sideStatus(side: CompareSide): "loading" | "ready" | "missing" {
  if (side.macroState === "loading" || side.gameState === "loading") return "loading";
  return side.macroState === "ready" || side.game ? "ready" : "missing";
}

/**
 * The game page's Mechanics numbers for both games in one table, with
 * A − B. A value one game didn't measure shows a dash — never zero —
 * and the race mechanic compares only when both games used the same one.
 */
export function MechanicsCompare({ a, b }: { a: CompareSide; b: CompareSide }) {
  const loading = sideStatus(a) === "loading" || sideStatus(b) === "loading";
  return (
    <Card title="Mechanics" data-testid="compare-mechanics">
      {loading ? <Skeleton rows={3} /> : (
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- The named overflow region must accept keyboard scrolling.
        <div role="region" aria-label="Mechanics comparison table" tabIndex={0} className="max-w-full overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <table className="w-full min-w-[20rem] border-collapse text-caption">
            <caption className="sr-only">Mechanics of game A and game B, with the difference A minus B.</caption>
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="py-2 pr-3 text-left font-semibold text-text">Measure</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold text-text">A</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold text-text">B</th>
                <th scope="col" className="py-2 pl-3 text-right font-semibold text-text">A − B</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {ROWS.map((row) => {
                const av = row.value(a.mechanics), bv = row.value(b.mechanics);
                const comparable = row.key !== "mechanic" || a.mechanics.mechanic?.label === b.mechanics.mechanic?.label;
                const delta = av !== null && bv !== null && comparable ? av - bv : null;
                const better = delta === null || delta === 0 ? null : (delta > 0) === row.higherIsBetter;
                return (
                  <tr key={row.key} data-testid={`compare-mechanic-${row.key}`}>
                    <th scope="row" className="py-2 pr-3 text-left font-normal text-text">{row.label}</th>
                    <td className="px-3 py-2 text-right tabular-nums text-text">{row.show(a.mechanics)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-text">{row.show(b.mechanics)}</td>
                    <td className="py-2 pl-3 text-right tabular-nums text-text-muted">
                      {delta === null ? "—" : row.key === "blocked" ? `${formatSigned(delta)} s` : formatSigned(delta)}
                      {better === null ? null : <span className="sr-only">, {better ? "better" : "worse"} in game A</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {sideStatus(a) === "missing" || sideStatus(b) === "missing" ? (
            <p className="mt-2 text-caption text-text-muted">A game without a macro breakdown shows dashes; nothing is counted as zero.</p>
          ) : null}
        </div>
      )}
    </Card>
  );
}
