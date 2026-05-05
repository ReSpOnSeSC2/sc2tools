import Link from "next/link";
import { ArrowUpDown, MessageSquare } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { fmtAgo } from "@/lib/format";
import { coerceRace, raceIconName, raceTint } from "@/lib/race";
import { AuthorChip } from "./AuthorChip";
import type { CommunityBuildListItem } from "./types";

export interface CommunityBuildCardProps {
  build: CommunityBuildListItem;
}

/**
 * CommunityBuildCard — one row in the public /community grid.
 *
 * The card body is a Link to /community/builds/{slug}. The author chip
 * is rendered as a sibling (NOT inside the card link) so the chip's
 * own anchor-to-author can fire without being intercepted by the
 * outer click target. Race-tinted left rail mirrors the private
 * library card to keep the visual language consistent.
 */
export function CommunityBuildCard({ build }: CommunityBuildCardProps) {
  const race = coerceRace(build.build?.race);
  const tint = raceTint(race);
  const matchup = build.matchup || "—";
  const votes = Number.isFinite(build.votes) ? build.votes : 0;
  const description = (build.description || "").trim();

  return (
    <Card
      variant="interactive"
      padded={false}
      className="group relative h-full overflow-hidden"
    >
      <span
        aria-hidden
        className={["absolute left-0 top-0 h-full w-1", tint.rail].join(" ")}
      />
      {/* Author chip lives outside the wrapping link so it can navigate
          independently to the author profile. */}
      <div className="absolute right-3 top-3 z-10">
        <AuthorChip build={build} size="sm" />
      </div>
      <Link
        href={`/community/builds/${encodeURIComponent(build.slug)}`}
        className="flex h-full flex-col gap-3 p-5 pl-6 pr-3 focus-visible:bg-bg-elevated focus-visible:outline-none"
      >
        <div className="flex flex-wrap items-center gap-2 pr-24">
          <Badge
            variant="neutral"
            size="sm"
            className={[tint.bg, tint.border, tint.text].join(" ")}
            iconLeft={
              <Icon
                name={raceIconName(race)}
                kind="race"
                size={14}
                decorative
              />
            }
          >
            {matchup}
          </Badge>
          <span className="text-[11px] uppercase tracking-wider text-text-dim">
            Published {fmtAgo(build.publishedAt)}
          </span>
        </div>
        <h3 className="break-words text-h4 font-semibold leading-tight text-text">
          {build.title}
        </h3>
        {description ? (
          <p className="line-clamp-2 text-caption text-text-muted">
            {description}
          </p>
        ) : null}
        <div className="mt-auto flex items-baseline justify-between pt-2">
          <VoteScore votes={votes} />
          <span className="inline-flex items-center gap-1 text-[11px] text-text-dim">
            <MessageSquare className="h-3 w-3" aria-hidden />
            <span>Open</span>
          </span>
        </div>
      </Link>
    </Card>
  );
}

function VoteScore({ votes }: { votes: number }) {
  const tone =
    votes > 0
      ? "text-success"
      : votes < 0
        ? "text-danger"
        : "text-text-dim";
  const sign = votes > 0 ? "▲" : votes < 0 ? "▼" : "·";
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 font-mono text-caption tabular-nums",
        tone,
      ].join(" ")}
      aria-label={`${votes} net votes`}
    >
      <ArrowUpDown className="h-3 w-3" aria-hidden />
      {sign} {Math.abs(votes)}
    </span>
  );
}
