import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { formatRelative } from "@/lib/i18n/format";
import { lengthLabel, raceName, ratingLabel, type LadderVod } from "@/lib/ladder/vods";
import { RACE_TEXT } from "./raceText";

/**
 * One game: the matchup (the streamer's race first), the rating and where it
 * was played, then the channel. The channel link is the card's hit area and
 * opens the VOD at the start of the game; the other player is not named.
 */
export function LadderVodCard({ vod, now }: { vod: LadderVod; now: number }) {
  return (
    <li className="relative flex min-h-11 flex-col gap-2 rounded-xl border border-line bg-bg-surface p-4 transition-colors hover:border-accent/50">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-display text-body-lg font-semibold">
          <span className={RACE_TEXT[vod.streamerRace]}>{raceName(vod.streamerRace)}</span>
          <span className="font-normal text-text-muted"> vs </span>
          <span className={RACE_TEXT[vod.opponentRace]}>{raceName(vod.opponentRace)}</span>
        </p>
        <span className="shrink-0 text-caption font-semibold text-text">{ratingLabel(vod.rating)}</span>
      </div>
      <p className="text-caption text-text-muted">
        {vod.map} · {lengthLabel(vod.durationSec)} game · {formatRelative(vod.playedAt, now)}
      </p>
      <p className="mt-auto flex items-center gap-2 text-body font-semibold text-text">
        <a
          href={vod.vodUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 rounded-sm after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-accent"
        >
          <span className="block truncate">{vod.channel ? `Watch ${vod.channel}` : "Watch the VOD"}</span>
          <span className="sr-only"> on Twitch at the start of this game (opens in a new tab)</span>
        </a>
        {vod.subscribersOnly && <Badge variant="warning" size="sm" className="shrink-0">Subscribers only</Badge>}
        <ExternalLink aria-hidden className="ml-auto size-4 shrink-0 text-text-muted" />
      </p>
    </li>
  );
}
