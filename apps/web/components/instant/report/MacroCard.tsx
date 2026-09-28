/**
 * Macro — your average macro score (over games that carry one) and the
 * leaks that most often made a game's top 3, with their reported mineral
 * cost, from `report.macro`. Each half hides itself when its data is
 * missing; the whole card renders nothing when the section is null.
 *
 * Example:
 *   <MacroCard macro={report.macro} />
 */
import type { LeakRow, MacroSummary } from "@/lib/instant/report";
import { scoreToneTextClass } from "@/lib/macro";
import { ReportCard, gamesLabel } from "./ReportBits";

export interface MacroCardProps {
  macro: MacroSummary | null;
}

const MINERALS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function AverageScore({ score, games }: { score: number; games: number }) {
  const rounded = Math.round(score);
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className={["font-display text-display-lg leading-none tabular-nums", scoreToneTextClass(rounded)].join(" ")}>
        {rounded}
      </span>
      <span className="text-caption text-text-muted">
        average macro score (0–100) over {gamesLabel(games)}
      </span>
    </div>
  );
}

function LeakList({ leaks }: { leaks: LeakRow[] }) {
  return (
    <div className="space-y-2">
      <h4 className="text-caption font-semibold text-text">Your most frequent leaks</h4>
      <ul className="space-y-2">
        {leaks.map((leak) => (
          <li key={leak.name} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-caption">
            <span className="min-w-0 break-words font-semibold text-text">{leak.name}</span>
            <span className="text-text-muted">
              top 3 in {gamesLabel(leak.occurrences)}
              {leak.totalMineralCost !== null && leak.totalMineralCost > 0
                ? ` · ${MINERALS.format(leak.totalMineralCost)} minerals`
                : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Average macro score + most frequent leaks.
 *
 * Example:
 *   <MacroCard macro={{ averageScore: 72, games: 3, topLeaks: [] }} />
 */
export function MacroCard({ macro }: MacroCardProps) {
  if (!macro) return null;
  const hasScore = macro.averageScore !== null && macro.games > 0;
  const hasLeaks = macro.topLeaks.length > 0;
  if (!hasScore && !hasLeaks) return null;
  return (
    <ReportCard title="Macro" subtitle="How well you spent, produced and stayed out of supply blocks." testId="report-macro">
      <div className="space-y-4">
        {hasScore && macro.averageScore !== null ? <AverageScore score={macro.averageScore} games={macro.games} /> : null}
        {hasLeaks ? <LeakList leaks={macro.topLeaks} /> : null}
      </div>
    </ReportCard>
  );
}
