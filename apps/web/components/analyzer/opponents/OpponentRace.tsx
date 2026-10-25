import { Icon } from "@/components/ui/Icon";
import { raceIconName } from "@/lib/race";
import { opponentRace } from "@/lib/opponentPresentation";
import type { Opp } from "./types";

export function OpponentRace({ row }: { row: Opp & { identities?: Opp[] } }) {
  const races = [...new Set((row.identities || [row]).map(item => opponentRace(item.race)).filter(race => race !== null))];
  return <span className="inline-flex items-center gap-1" title={races.length ? `Recorded races: ${races.join(", ")}; sorts by most recent account's race` : "Race unknown"}>{races.length ? races.map(race => <Icon key={race} kind="race" name={raceIconName(race)} size={18} alt={race} />) : <span className="text-text-dim">—</span>}</span>;
}
