import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { fmtAgo } from "@/lib/format";
import { SKILL_LEVELS } from "@/lib/build-rules";
import { coerceRace, raceIconName, raceTint } from "@/lib/race";
import { AuthorChip } from "./AuthorChip";
import { CommunityBuildOwnerControls } from "./CommunityBuildOwnerControls";
import { CommunityOwnerReplayCount } from "./CommunityOwnerReplayCount";
import { KeySteps } from "./KeySteps";
import { VoteScore } from "./VoteScore";
import type { CommunityBuildListItem } from "./types";

export interface CommunityBuildCardProps { build: CommunityBuildListItem; hideAuthor?: boolean }

/** Stretched title link, with independently reachable author and owner actions. */
export function CommunityBuildCard({ build, hideAuthor = false }: CommunityBuildCardProps) {
  const race = coerceRace(build.build?.race);
  const tint = raceTint(race);
  const level = SKILL_LEVELS.find((item) => item.id === build.build?.skillLevel);
  return <Card variant="interactive" padded={false} className="group relative h-full overflow-hidden">
    <span aria-hidden className={`absolute left-0 top-0 h-full w-1 ${tint.rail}`} />
    <div className="flex h-full min-w-0 flex-col gap-3 p-5 pl-6">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="neutral" size="sm" className={`${tint.bg} ${tint.border} ${tint.text}`} iconLeft={<Icon name={raceIconName(race)} kind="race" size={14} decorative />}>{build.matchup || "—"}</Badge>
        {level ? <Badge size="sm" variant="neutral">{level.label}</Badge> : null}
      </div>
      <h3 className="break-words text-h4 font-semibold leading-tight text-text">
        <Link href={`/community/builds/${encodeURIComponent(build.slug)}`} className="after:absolute after:inset-0 focus-visible:outline-none after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-accent">{build.title}</Link>
      </h3>
      {build.description?.trim() ? <p className="line-clamp-2 break-words text-caption text-text-muted">{build.description.trim()}</p> : null}
      <KeySteps build={build.build} />
      <footer className="relative z-10 mt-auto flex flex-wrap items-center gap-x-3 gap-y-2 pt-2">
        {!hideAuthor ? <span className="min-w-0 max-w-[50%]"><AuthorChip build={build} size="sm" /></span> : null}
        <VoteScore votes={build.votes} />
        <span className="text-micro text-text-dim">Updated {fmtAgo(build.updatedAt || build.publishedAt)}</span>
        <CommunityBuildOwnerControls slug={build.slug} title={build.title} compact />
        <CommunityOwnerReplayCount publicSlug={build.slug} />
      </footer>
    </div>
  </Card>;
}
