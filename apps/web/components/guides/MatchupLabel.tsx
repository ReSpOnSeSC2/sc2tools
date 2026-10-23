import { raceTint, coerceRace } from "@/lib/race";

const RACES: Record<string, string> = { P: "Protoss", T: "Terran", Z: "Zerg" };
export function MatchupLabel({ matchup }: { matchup: string }) {
  return <span><span className={raceTint(coerceRace(RACES[matchup[0]])).text}>{matchup[0]}</span>v<span className={raceTint(coerceRace(RACES[matchup[2]])).text}>{matchup[2]}</span></span>;
}
