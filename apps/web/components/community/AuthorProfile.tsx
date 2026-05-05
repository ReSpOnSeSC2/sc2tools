import Link from "next/link";
import { ArrowLeft, Trophy } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { GlowHalo } from "@/components/ui/GlowHalo";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { fmtAgo } from "@/lib/format";
import { coerceRace, raceIconName, raceTint } from "@/lib/race";
import { AuthorBuildsList } from "./AuthorBuildsList";
import { AuthorStatsStrip } from "./AuthorStatsStrip";
import type { CommunityAuthorProfile } from "./types";

export interface AuthorProfileProps {
  profile: CommunityAuthorProfile;
}

/**
 * AuthorProfile — public page composition for /community/authors/:userId.
 *
 * Two-column layout on lg+: builds grid on the left, sidebar on the
 * right. Mobile collapses to a single column with the sidebar moved
 * below. Cyan halo on the header echoes the brand glow.
 */
export function AuthorProfile({ profile }: AuthorProfileProps) {
  const race = profile.primaryRace
    ? coerceRace(profile.primaryRace)
    : null;
  const tint = race ? raceTint(race) : null;
  const personJsonLd = {
    "@context": "https://schema.org",
    "@type": "Person",
    name: profile.displayName,
    identifier: profile.userId,
    interactionStatistic: [
      {
        "@type": "InteractionCounter",
        interactionType: { "@type": "WriteAction" },
        userInteractionCount: profile.totalBuilds,
      },
    ],
  };

  return (
    <article className="space-y-6">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(personJsonLd),
        }}
      />

      <Link
        href="/community"
        className="inline-flex min-h-[44px] items-center gap-1.5 text-caption font-medium text-text-muted hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back to community
      </Link>

      <Card variant="feature" padded={false} className="relative overflow-hidden">
        <GlowHalo color="cyan" position="top-right" />
        <div className="relative px-5 py-6 sm:px-6 sm:py-8">
          <PageHeader
            eyebrow={
              <span className="inline-flex flex-wrap items-center gap-2">
                <span>Author profile</span>
                {race && tint ? (
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
                    {race}
                  </Badge>
                ) : null}
                <span className="text-[11px] uppercase tracking-wider text-text-dim">
                  Member {fmtAgo(profile.joinedAt)}
                </span>
              </span>
            }
            title={profile.displayName}
            description={
              profile.totalBuilds === 1
                ? "One published community build"
                : `${profile.totalBuilds} published community builds`
            }
          />
        </div>
      </Card>

      <AuthorStatsStrip
        totalBuilds={profile.totalBuilds}
        totalVotes={profile.totalVotes}
        primaryRace={profile.primaryRace}
        joinedAt={profile.joinedAt}
        topMatchup={profile.topMatchup}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <AuthorBuildsList builds={profile.builds} />
        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          {profile.topBuild ? (
            <Card>
              <div className="space-y-2">
                <h2 className="text-caption font-semibold uppercase tracking-wider text-text">
                  <span className="inline-flex items-center gap-1.5">
                    <Trophy className="h-4 w-4 text-accent-cyan" aria-hidden />
                    Most-voted build
                  </span>
                </h2>
                <Link
                  href={`/community/builds/${encodeURIComponent(profile.topBuild.slug)}`}
                  className="group block rounded-lg border border-border bg-bg-elevated p-3 transition-colors hover:border-accent-cyan/60 hover:bg-accent-cyan/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan"
                >
                  <span className="block truncate text-body font-medium text-text group-hover:text-accent-cyan">
                    {profile.topBuild.title}
                  </span>
                  <span className="mt-1 inline-flex items-center gap-2 text-[11px] text-text-muted">
                    <span>{profile.topBuild.matchup || "—"}</span>
                    <span aria-hidden className="text-text-dim">
                      ·
                    </span>
                    <span className="font-mono tabular-nums">
                      {profile.topBuild.votes >= 0 ? "▲" : "▼"}{" "}
                      {Math.abs(profile.topBuild.votes)}
                    </span>
                  </span>
                </Link>
              </div>
            </Card>
          ) : null}
          {profile.recent.length > 0 ? (
            <Card>
              <h2 className="text-caption font-semibold uppercase tracking-wider text-text">
                Recent activity
              </h2>
              <ul className="mt-3 space-y-2">
                {profile.recent.map((b) => (
                  <li key={b.slug}>
                    <Link
                      href={`/community/builds/${encodeURIComponent(b.slug)}`}
                      className="group block rounded-md p-2 transition-colors hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      <span className="block truncate text-body text-text group-hover:text-accent-cyan">
                        {b.title}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-text-dim">
                        Published {fmtAgo(b.publishedAt)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </aside>
      </div>
    </article>
  );
}
