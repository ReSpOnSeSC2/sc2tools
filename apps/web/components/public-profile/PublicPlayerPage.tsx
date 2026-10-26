import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { AuthorBuildsList } from "@/components/community/AuthorBuildsList";
import { publicDate } from "@/lib/seo/publicDate";
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
    {active === "builds" ? <PublishedBuilds profile={profile} />
      : active === "reviews" && profile.reviewer ? <ReviewerSection reviewer={profile.reviewer} />
        : <><PlayerOverviewSections profile={profile} /><PublicProfile profile={profile} showHero={false} showReviewer={false} /></>}
  </article>;
}

function PublishedBuilds({ profile }: { profile: PublicPlayerProfile }) {
  // Explicit public fields only; no author/owner hint is needed on this page.
  const builds = (profile.publishedBuilds ?? []).map(row => ({ slug: row.slug, title: row.title,
    description: row.description ?? "", matchup: row.matchup ?? undefined, votes: row.votes,
    publishedAt: row.publishedAt ?? "", updatedAt: row.updatedAt ?? undefined,
  }));
  const sampled = profile.publishedBuildCount > builds.length;
  const firstPublished = builds.map(row => row.publishedAt).filter(value => Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const matchupCount = new Set(builds.map(row => row.matchup).filter(Boolean)).size;
  return <div className="space-y-4">
    <section aria-label="Publishing summary" className="flex flex-wrap gap-x-5 gap-y-2 text-caption text-text-muted">
      <p>Publication sample from <span className="text-text">{publicDate(sampled ? profile.joinedAt : firstPublished || profile.joinedAt)}</span></p>
      <p>Across {matchupCount} matchup{matchupCount === 1 ? "" : "s"}</p>
      {sampled ? <p>Showing the latest {builds.length} build{builds.length === 1 ? "" : "s"} in this recent publication sample.</p> : null}
    </section>
    <AuthorBuildsList builds={builds} />
  </div>;
}
