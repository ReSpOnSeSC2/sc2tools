import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { buttonClassName } from "@/components/ui/buttonStyles";
import { ResultBadge } from "@/components/ui/ResultBadge";
import { formatRelative } from "@/lib/i18n/format";
import { PLATFORM_NAMES } from "@/lib/live/streams";
import { lengthLabel, raceName, ratingLabel } from "@/lib/ladder/vods";
import { leagueName, type ProGame, type ProRow } from "@/lib/ladder/proBoard";
import { RACE_TEXT } from "@/components/ladder/raceText";

function GameLine({ game, now }: { game: ProGame; now: number }) {
  return (
    <li className="flex min-h-11 items-center gap-3 py-1.5">
      <span className="flex w-12 shrink-0 justify-center"><ResultBadge result={game.won ? "win" : "loss"} /></span>
      <div className="min-w-0">
        <p className="truncate text-body font-semibold text-text">
          {game.map}
          {game.opponentRace && (
            <span className="font-normal text-text-muted"> vs <span className={RACE_TEXT[game.opponentRace]}>{raceName(game.opponentRace)}</span></span>
          )}
        </p>
        <p className="text-caption text-text-muted">{lengthLabel(game.durationSec)} game · {formatRelative(game.playedAt, now)}</p>
      </div>
    </li>
  );
}

/**
 * One known pro: who and how strong, their last games, and a link to the
 * channel when they are live. The opponents of those games are never named.
 */
export function ProCard({ pro, now }: { pro: ProRow; now: number }) {
  const platform = pro.live ? PLATFORM_NAMES[pro.live.platform] : "";
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-line bg-bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-display text-body-lg font-semibold text-text">{pro.nickname}</h3>
          {pro.team && <p className="truncate text-caption text-text-muted">{pro.team}</p>}
        </div>
        {pro.live && <Badge variant="success" size="sm" className="shrink-0">Live</Badge>}
      </div>
      <p className="text-caption text-text-muted">
        <span className={`font-semibold ${RACE_TEXT[pro.race]}`}>{raceName(pro.race)}</span>
        {" · "}{leagueName(pro.league)} · <span className="font-semibold text-text">{ratingLabel(pro.rating)}</span> · {formatRelative(pro.playedAt, now)}
      </p>
      {pro.games.length > 0 && (
        <div>
          <p className="text-micro font-semibold uppercase tracking-wide text-text-muted">Last games</p>
          <ul className="divide-y divide-line">
            {pro.games.map(game => <GameLine key={game.playedAt} game={game} now={now} />)}
          </ul>
        </div>
      )}
      {pro.live && (
        <a
          href={pro.live.url}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonClassName({ variant: "secondary", fullWidth: true, className: "mt-auto" })}
        >
          <span className="truncate">Watch {pro.live.channel} live</span>
          <span className="sr-only"> on {platform} (opens in a new tab)</span>
          <ExternalLink aria-hidden className="size-4 shrink-0" />
        </a>
      )}
    </li>
  );
}
