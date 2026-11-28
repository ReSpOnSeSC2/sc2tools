import { leagueName, type PlayerRow } from "@/lib/ladder/proBoard";
import { raceName, ratingLabel } from "@/lib/ladder/vods";
import { RACE_TEXT } from "@/components/ladder/raceText";

/** A Grandmaster who played lately: race, rating and league, never a name or a time. */
export function PlayerTile({ player }: { player: PlayerRow }) {
  return (
    <li className="flex flex-col gap-0.5 rounded-lg border border-line bg-bg-surface p-3">
      <span className={`truncate text-body font-semibold ${RACE_TEXT[player.race]}`}>{raceName(player.race)}</span>
      <span className="text-body font-semibold text-text">{ratingLabel(player.rating)}</span>
      <span className="text-caption text-text-muted">{leagueName(player.league)}</span>
    </li>
  );
}
