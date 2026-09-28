/**
 * Your openers — W-L per build the classifier detected for you, from
 * `report.openers`. Shows the most played few and says how many more
 * exist. Renders nothing when the section is null (no detected build).
 *
 * Example:
 *   <OpenersCard rows={report.openers} />
 */
import type { OpenerRow } from "@/lib/instant/report";
import { ReportCard, WinLoss, WinrateText, gamesLabel } from "./ReportBits";

/** Openers listed before the "+N more" note. */
export const OPENERS_SHOWN = 5;

export interface OpenersCardProps {
  rows: OpenerRow[] | null;
}

/**
 * Most-played openers with their records.
 *
 * Example:
 *   <OpenersCard rows={[{ name: "PvZ - Adept Glaives (Robo)", games: 3, wins: 2, losses: 1, winrate: 0.67 }]} />
 */
export function OpenersCard({ rows }: OpenersCardProps) {
  if (!rows || rows.length === 0) return null;
  const shown = rows.slice(0, OPENERS_SHOWN);
  const hidden = rows.length - shown.length;
  return (
    <ReportCard title="Your openers" subtitle="The builds we detected for you, and how they went." testId="report-openers">
      <ul className="divide-y divide-border">
        {shown.map((row) => (
          <li key={row.name} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0">
            <span className="min-w-0 break-words font-semibold text-text">{row.name}</span>
            <span className="flex items-baseline gap-3 text-caption">
              <span className="text-text-muted">{gamesLabel(row.games)}</span>
              <WinLoss wins={row.wins} losses={row.losses} />
              <WinrateText wins={row.wins} losses={row.losses} />
            </span>
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <p className="pt-3 text-caption text-text-muted">
          +{hidden} more {hidden === 1 ? "opener" : "openers"} — save your games to see them all.
        </p>
      ) : null}
    </ReportCard>
  );
}
