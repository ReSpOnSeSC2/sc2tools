/**
 * Record by matchup — W-L and win rate against each opponent race, from
 * `report.recordByMatchup` (the shared season-recap split). Renders
 * nothing when the section is null (no game had a known opponent race).
 *
 * Example:
 *   <RecordByMatchupCard rows={report.recordByMatchup} />
 */
import type { MatchupRow } from "@/lib/instant/report";
import { raceTint, type Race } from "@/lib/race";
import { ReportCard, WinLoss, WinrateBar, WinrateText, gamesLabel } from "./ReportBits";

const RACE_BY_LETTER: Record<MatchupRow["oppRace"], Race> = { P: "Protoss", T: "Terran", Z: "Zerg" };

export interface RecordByMatchupCardProps {
  rows: MatchupRow[] | null;
}

/**
 * One row per opponent race, most played first.
 *
 * Example:
 *   <RecordByMatchupCard rows={[{ matchup: "vs Z", oppRace: "Z", games: 2, wins: 1, losses: 1, winrate: 0.5 }]} />
 */
export function RecordByMatchupCard({ rows }: RecordByMatchupCardProps) {
  if (!rows || rows.length === 0) return null;
  return (
    <ReportCard title="Record by matchup" subtitle="Your wins and losses against each race." testId="report-matchups">
      <ul className="space-y-3">
        {rows.map((row) => {
          const race = RACE_BY_LETTER[row.oppRace];
          return (
            <li key={row.oppRace} className="space-y-1.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="font-semibold text-text">
                  vs <span className={raceTint(race).text}>{race}</span>
                </span>
                <span className="flex items-baseline gap-3 text-caption">
                  <span className="text-text-muted">{gamesLabel(row.games)}</span>
                  <WinLoss wins={row.wins} losses={row.losses} />
                  <WinrateText wins={row.wins} losses={row.losses} />
                </span>
              </div>
              <WinrateBar wins={row.wins} losses={row.losses} />
            </li>
          );
        })}
      </ul>
    </ReportCard>
  );
}
