import Link from "next/link";
import { CheckCircle2, Film, MessageSquare, Star } from "lucide-react";
import { MapArtwork } from "@/components/maps/MapArtwork";
import { Badge } from "@/components/ui/Badge";
import { age, formatClock, tagLabel, type ReviewCard as ReviewCardData } from "@/lib/reviews";
import { ReviewReplayDownload } from "./ReviewReplayDownload";

/**
 * One request on the board: matchup, map thumbnail, result, asker band,
 * the question, age, review count and the "best review" tick. Server-
 * safe (no hooks), so the board ships real HTML to crawlers.
 */
export function ReviewCard({ card, now, variant = "full" }: { card: ReviewCardData; now: number; variant?: "full" | "compact" }) {
  if (variant === "compact") return <li className="relative space-y-2 rounded-xl border border-border bg-bg-surface p-3">
    <div className="flex flex-wrap items-center gap-2 text-micro text-text-muted">{card.matchup ? <Badge variant="accent" size="sm">{card.matchup}</Badge> : null}{card.askerBand ? <span>{card.askerBand.label}</span> : null}<span>{age(card.createdAt, now)}</span><span>{card.reviewCount} {card.reviewCount === 1 ? "review" : "reviews"}</span>{card.replayShared ? <span className="relative z-10 ml-auto"><ReviewReplayDownload requestId={card.id} requestUrl={card.url} variant="card" contextLabel={`${card.matchup ? `[${card.matchup}] ` : ""}${card.question.slice(0, 60)}`} /></span> : null}</div>
    <Link href={card.url} data-testid="review-card" className="font-semibold text-text after:absolute after:inset-0 hover:text-link focus-visible:outline-none focus-visible:after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-accent"><p className="line-clamp-2 break-words">{card.question}</p></Link>
  </li>;
  return (
    <li className="relative">
      <Link
        href={card.url}
        data-testid="review-card"
        className={`group flex min-w-0 gap-3 rounded-xl border-2 border-line bg-bg-surface p-3 shadow-hard transition-colors hover:border-accent-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:p-4 ${card.replayShared ? "pr-14 sm:pr-16" : ""}`}
      >
        <div className="relative hidden h-20 w-32 shrink-0 overflow-hidden rounded-lg border border-border sm:block">
          <MapArtwork mapName={card.map} size="card" alt={card.map ? `${card.map} minimap` : ""} className="border-0" />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {card.matchup ? <Badge variant="accent" size="sm">{card.matchup}</Badge> : null}
            {card.result ? <Badge variant={card.result === "Win" ? "success" : card.result === "Loss" ? "danger" : "neutral"} size="sm">{card.result}</Badge> : null}
            {card.askerBand ? <Badge variant="neutral" size="sm">{card.askerBand.label}</Badge> : null}
            {card.hasPlayback ? <Film className="h-3.5 w-3.5 text-text-dim" aria-label="Map playback available" /> : null}
            {card.visibility === "link" ? <Badge variant="neutral" size="sm">Link only</Badge> : null}
            {card.status === "closed" ? <Badge variant="neutral" size="sm">Closed</Badge> : null}
            {card.hidden ? <Badge variant="warning" size="sm">Hidden pending review</Badge> : null}
          </div>
          <p className="line-clamp-2 break-words font-semibold text-text group-hover:text-accent-cyan">{card.question}</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-text-muted">
            <span>{card.askerLabel}</span>
            {card.map ? <span className="truncate">{card.map}</span> : null}
            {card.durationSec ? <span className="tabular-nums">{formatClock(card.durationSec)}</span> : null}
            <span>{age(card.createdAt, now)}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-caption">
            <span className="inline-flex items-center gap-1 font-semibold text-text">
              <MessageSquare className="h-3.5 w-3.5" aria-hidden />
              {card.reviewCount === 1 ? "1 review" : `${card.reviewCount} reviews`}
            </span>
            {card.hasBest ? (
              <span className="inline-flex items-center gap-1 font-semibold text-success"><Star className="h-3.5 w-3.5" aria-hidden /> Best review</span>
            ) : card.helpfulCount > 0 ? (
              <span className="inline-flex items-center gap-1 font-semibold text-success"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Helpful</span>
            ) : null}
            {card.tags.slice(0, 3).map((t) => <span key={t} className="text-text-dim">#{tagLabel(t).toLowerCase().replace(/\s+/g, "-")}</span>)}
          </div>
        </div>
      </Link>
      {card.replayShared ? (
        // A sibling of the card link (not inside it): its own control.
        <div className="absolute right-3 top-3 sm:right-4 sm:top-4">
          <ReviewReplayDownload
            requestId={card.id}
            requestUrl={card.url}
            variant="card"
            contextLabel={`${card.matchup ? `[${card.matchup}] ` : ""}${card.question.slice(0, 60)}`}
          />
        </div>
      ) : null}
    </li>
  );
}

export { age } from "@/lib/reviews";
