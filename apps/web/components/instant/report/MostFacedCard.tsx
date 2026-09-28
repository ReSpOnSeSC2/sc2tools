/**
 * Most-faced opponent — the player you met most often in these replays
 * (at least twice), with your record against them, from
 * `report.mostFaced`. Renders nothing when the section is null.
 *
 * Example:
 *   <MostFacedCard opponent={report.mostFaced} />
 */
import type { MostFacedOpponent } from "@/lib/instant/report";
import { coerceRace, raceTint, type Race } from "@/lib/race";
import { ReportCard, WinLoss, WinrateText, gamesLabel } from "./ReportBits";

/**
 * The race the payload names, or null when it names none we know — never
 * a guess (`coerceRace` alone would turn "Unknown" into "Random").
 *
 * Example:
 *   knownRace("Zerg");    // -> "Zerg"
 *   knownRace("Unknown"); // -> null
 */
export function knownRace(value: string | null): Race | null {
  if (!value) return null;
  const race = coerceRace(value, "Random");
  return race === "Random" && !/^r/i.test(value.trim()) ? null : race;
}

export interface MostFacedCardProps {
  opponent: MostFacedOpponent | null;
}

/**
 * Name, race, games and W-L against your most frequent opponent.
 *
 * Example:
 *   <MostFacedCard opponent={{ name: "Squirtuoz", race: "Zerg", games: 2, wins: 1, losses: 1 }} />
 */
export function MostFacedCard({ opponent }: MostFacedCardProps) {
  if (!opponent) return null;
  const race = knownRace(opponent.race);
  return (
    <ReportCard title="Most-faced opponent" subtitle="Who you met most often in these replays." testId="report-most-faced">
      <div className="space-y-2">
        <p className="min-w-0 break-words font-display text-h3 text-text">{opponent.name}</p>
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-caption">
          {race ? <span className={["font-semibold", raceTint(race).text].join(" ")}>{race}</span> : null}
          <span className="text-text-muted">{gamesLabel(opponent.games)}</span>
          <WinLoss wins={opponent.wins} losses={opponent.losses} />
          <WinrateText wins={opponent.wins} losses={opponent.losses} />
        </p>
      </div>
    </ReportCard>
  );
}
