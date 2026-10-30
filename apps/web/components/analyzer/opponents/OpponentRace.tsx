import { Icon } from "@/components/ui/Icon";
import { raceIconName, raceTint } from "@/lib/race";
import { opponentRace } from "@/lib/opponentPresentation";
import type { Opp } from "./types";

export function OpponentRace({ row }: { row: Opp & { identities?: Opp[] } }) {
  const races = [...new Set((row.identities || [row]).flatMap(item => {
    const recorded = Array.isArray(item.races)
      ? item.races.map(opponentRace).filter(race => race !== null)
      : [];
    return recorded.length ? recorded : [opponentRace(item.race)].filter(race => race !== null);
  }))];
  return <span className="inline-flex items-center gap-1" title={races.length ? `Recorded races: ${races.join(", ")}; sorts by most recent game's race` : "Race unknown"}>{races.length ? races.map(race => <span key={race} className={`inline-flex rounded ${raceTint(race).bg} ${raceTint(race).text}`}><Icon kind="race" name={raceIconName(race)} size={18} alt={race} /></span>) : <span className="text-text-dim">—</span>}</span>;
}
