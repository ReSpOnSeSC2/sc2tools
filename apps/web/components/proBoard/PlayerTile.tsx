import { formatRelative } from "@/lib/i18n/format";
import { leagueName, type PlayerRow } from "@/lib/ladder/proBoard";
import { raceName, ratingLabel } from "@/lib/ladder/vods";
import { RACE_TEXT } from "@/components/ladder/raceText";

/** A Grandmaster who played lately: race, rating and league, never a name. */
export function PlayerTile({ player, now }: { player: PlayerRow; now: number }) {
  return (
    <li className="flex flex-col gap-0.5 rounded-lg border border-line bg-bg-surface p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className={`truncate text-body font-semibold ${RACE_TEXT[player.race]}`}>{raceName(player.race)}</span>
        <span className="shrink-0 text-caption text-text-muted">{formatRelative(player.playedAt, now)}</span>
      </div>
      <span className="text-body font-semibold text-text">{ratingLabel(player.rating)}</span>
      <span className="text-caption text-text-muted">{leagueName(player.league)}</span>
    </li>
  );
}
