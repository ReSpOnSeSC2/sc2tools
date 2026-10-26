import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { PublicProfile, ReviewerSection } from "./PublicProfile";
import { PlayerSectionNav, type PlayerSection } from "./PlayerSectionNav";
import { PlayerOverviewSections } from "./PlayerOverviewSections";
import type { PublicPlayerProfile } from "./types";

export function PublicPlayerPage({ profile, requestedTab }: { profile: PublicPlayerProfile; requestedTab?: string }) {
  const sections: PlayerSection[] = ["overview"];
  if (profile.publishedBuilds?.length) sections.push("builds");
  if (profile.sections?.showReplays && profile.replayArchive) sections.push("replays");
  if (profile.reviewer) sections.push("reviews");
  const active = sections.includes(requestedTab as PlayerSection) && requestedTab !== "replays" ? requestedTab as PlayerSection : "overview";
  return <article className="min-w-0 space-y-6"><Card variant="feature" padded><PageHeader eyebrow="Player profile" title={<span className="[overflow-wrap:anywhere]">{profile.displayName}</span>} description={profile.mainRace ? `${profile.mainRace} player · SC2 Tools` : "StarCraft II player · SC2 Tools"} /></Card>
    <PlayerSectionNav handle={profile.handle} active={active} sections={sections} />
    {active === "builds" ? <Card title="Published builds" padded>{profile.publishedBuilds?.length ? <ul className="space-y-3">{profile.publishedBuilds.map(build => <li key={build.slug}><Link className="inline-flex min-h-11 items-center font-semibold text-accent underline" href={`/community/builds/${encodeURIComponent(build.slug)}`}>{build.title}</Link><p className="text-caption text-text-muted">{build.matchup || "All matchups"} · {build.votes} votes</p></li>)}</ul> : <EmptyStatePanel title="No published builds" />}</Card>
      : active === "reviews" && profile.reviewer ? <ReviewerSection reviewer={profile.reviewer} />
        : <><PlayerOverviewSections profile={profile} /><PublicProfile profile={profile} showHero={false} showReviewer={false} /></>}
  </article>;
}
