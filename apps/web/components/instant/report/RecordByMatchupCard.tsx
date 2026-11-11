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
  onMatchupChange?: (race: MatchupRow["oppRace"]) => void;
}

/**
 * One row per opponent race, most played first.
 *
 * Example:
 *   <RecordByMatchupCard rows={[{ matchup: "vs Z", oppRace: "Z", games: 2, wins: 1, losses: 1, winrate: 0.5 }]} />
 */
export function RecordByMatchupCard({ rows, onMatchupChange }: RecordByMatchupCardProps) {
  if (!rows || rows.length === 0) return null;
  return (
    <ReportCard title="Record by matchup" subtitle="Your wins and losses against each race." testId="report-matchups">
      <ul className="space-y-3">
        {rows.map((row) => {
          const race = RACE_BY_LETTER[row.oppRace];
          const details = (
            <>
              <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="font-semibold text-text">
                  vs <span className={raceTint(race).text}>{race}</span>
                </span>
                <span className="flex items-baseline gap-3 text-caption">
                  <span className="text-text-muted">{gamesLabel(row.games)}</span>
                  <WinLoss wins={row.wins} losses={row.losses} />
                  <WinrateText wins={row.wins} losses={row.losses} />
                </span>
              </span>
              <WinrateBar wins={row.wins} losses={row.losses} />
            </>
          );
          return (
            <li key={row.oppRace}>
              {onMatchupChange ? <button type="button" aria-label={"Show only vs " + race + " games"}
                onClick={() => onMatchupChange(row.oppRace)}
                className="min-h-11 w-full space-y-1.5 rounded-lg px-2 py-1 text-left hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                {details}
              </button> : <div className="space-y-1.5">{details}</div>}
            </li>
          );
        })}
      </ul>
    </ReportCard>
  );
}
