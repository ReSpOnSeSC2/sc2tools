import Link from "next/link";
import { Swords, Trophy } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card, WrBar } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { GlowHalo } from "@/components/ui/GlowHalo";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/Stat";
import { fmtAgo, pct, wrColor } from "@/lib/format";
import { coerceRace, raceIconName, raceTint } from "@/lib/race";
import { GetYourOwnCTA } from "./GetYourOwnCTA";
import type {
  PublicPlayerProfile,
  PublicProfileMatchupSplit,
  PublicProfileSignatureBuild,
} from "./types";

export interface PublicProfileProps {
  profile: PublicPlayerProfile;
}

/**
 * PublicProfile — the shareable, SSR-rendered public player page body
 * for /p/[handle].
 *
 * Renders only non-sensitive aggregates (headline record, matchup
 * splits, the player's own signature builds) plus a viral "get your own"
 * CTA. No opponent identities, no per-game rows ever reach this
 * component — the API strips them before the payload leaves the server.
 *
 * Responsive: single column at 360px, two-column content grid from lg.
 * Dark + light via repo tokens. Server-component-safe.
 */
export function PublicProfile({ profile }: PublicProfileProps) {
  const race = profile.mainRace ? coerceRace(profile.mainRace) : null;
  const tint = race ? raceTint(race) : null;
  const { games, wins, losses, winRate } = profile.totals;
  const hasGames = games > 0;

  const personJsonLd = {
    "@context": "https://schema.org",
    "@type": "Person",
    name: profile.displayName,
    identifier: profile.handle,
    interactionStatistic: [
      {
        "@type": "InteractionCounter",
        interactionType: { "@type": "PlayGameAction" },
        userInteractionCount: games,
      },
    ],
  };

  return (
    <article className="space-y-6">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(personJsonLd) }}
      />

      <Card variant="feature" padded={false} className="relative overflow-hidden">
        <GlowHalo color="cyan" position="top-right" />
        <div className="relative px-5 py-6 sm:px-6 sm:py-8">
          <PageHeader
            eyebrow={
              <span className="inline-flex flex-wrap items-center gap-2">
                <span>Player profile</span>
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
                {profile.joinedAt ? (
                  <span className="text-micro uppercase tracking-wider text-text-dim">
                    Member {fmtAgo(profile.joinedAt)}
                  </span>
                ) : null}
              </span>
            }
            title={profile.displayName}
            description={
              hasGames
                ? `${games.toLocaleString()} games tracked · ${wins}–${losses} · ${pct(winRate)} win rate`
                : "Public build library on SC2 Tools"
            }
          />
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Games" value={games.toLocaleString()} />
        <StatCard
          label="Record"
          value={
            <span className="tabular-nums">
              <span className="text-success">{wins}</span>
              <span className="text-text-dim">–</span>
              <span className="text-danger">{losses}</span>
            </span>
          }
          hint="Wins–Losses"
        />
        <StatCard
          label="Win rate"
          value={
            <span style={{ color: wrColor(winRate, wins + losses) }}>
              {pct(winRate)}
            </span>
          }
        />
        <StatCard
          label="Main race"
          value={
            race ? (
              <span className="inline-flex items-center gap-2">
                <Icon
                  name={raceIconName(race)}
                  kind="race"
                  size={20}
                  decorative
                />
                {race}
              </span>
            ) : (
              <span className="text-text-muted">Mixed</span>
            )
          }
          hint={
            profile.publishedBuildCount > 0
              ? `${profile.publishedBuildCount} published build${profile.publishedBuildCount === 1 ? "" : "s"}`
              : undefined
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <MatchupSplits rows={profile.matchups} />
        <SignatureBuilds rows={profile.signatureBuilds} />
      </div>

      {profile.featuredBuild ? (
        <Card>
          <div className="space-y-2">
            <h2 className="text-caption font-semibold uppercase tracking-wider text-text">
              <span className="inline-flex items-center gap-1.5">
                <Trophy className="h-4 w-4 text-accent-cyan" aria-hidden />
                Featured build
              </span>
            </h2>
            <Link
              href={`/community/builds/${encodeURIComponent(profile.featuredBuild.slug)}`}
              className="group block rounded-lg border border-border bg-bg-elevated p-3 transition-colors hover:border-accent-cyan/60 hover:bg-accent-cyan/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan"
            >
              <span className="block truncate text-body font-medium text-text group-hover:text-accent-cyan">
                {profile.featuredBuild.title}
              </span>
              <span className="mt-1 inline-flex items-center gap-2 text-micro text-text-muted">
                <span>{profile.featuredBuild.matchup || "—"}</span>
                <span aria-hidden className="text-text-dim">
                  ·
                </span>
                <span className="font-mono tabular-nums">
                  {profile.featuredBuild.votes >= 0 ? "▲" : "▼"}{" "}
                  {Math.abs(profile.featuredBuild.votes)}
                </span>
              </span>
            </Link>
          </div>
        </Card>
      ) : null}

      <GetYourOwnCTA />
    </article>
  );
}

function MatchupSplits({ rows }: { rows: PublicProfileMatchupSplit[] }) {
  return (
    <Card>
      <div className="space-y-3">
        <h2 className="text-caption font-semibold uppercase tracking-wider text-text">
          <span className="inline-flex items-center gap-1.5">
            <Swords className="h-4 w-4 text-accent-cyan" aria-hidden />
            Matchup splits
          </span>
        </h2>
        {rows.length === 0 ? (
          <EmptyStatePanel
            size="sm"
            title="No matchup data yet"
            description="Stats appear once games have been synced."
          />
        ) : (
          <ul role="list" className="space-y-3">
            {rows.map((m) => (
              <li key={m.matchup} className="space-y-1">
                <div className="flex items-baseline justify-between gap-3 text-body">
                  <span className="font-medium text-text">{m.matchup}</span>
                  <span className="tabular-nums text-text-muted">
                    <span className="text-success">{m.wins}</span>
                    <span className="text-text-dim">–</span>
                    <span className="text-danger">{m.losses}</span>
                    <span
                      className="ml-2 font-mono"
                      style={{ color: wrColor(m.winRate, m.wins + m.losses) }}
                    >
                      {pct(m.winRate)}
                    </span>
                  </span>
                </div>
                <WrBar wins={m.wins} losses={m.losses} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function SignatureBuilds({ rows }: { rows: PublicProfileSignatureBuild[] }) {
  return (
    <Card>
      <div className="space-y-3">
        <h2 className="text-caption font-semibold uppercase tracking-wider text-text">
          Signature builds
        </h2>
        {rows.length === 0 ? (
          <EmptyStatePanel
            size="sm"
            title="No signature builds yet"
            description="A build shows up here once it's been played a few times."
          />
        ) : (
          <ul role="list" className="space-y-3">
            {rows.map((b) => (
              <li key={b.name} className="space-y-1">
                <div className="flex items-baseline justify-between gap-3 text-body">
                  <span className="min-w-0 truncate font-medium text-text">
                    {b.name}
                  </span>
                  <span className="shrink-0 tabular-nums text-text-muted">
                    <span
                      className="font-mono"
                      style={{ color: wrColor(b.winRate, b.wins + b.losses) }}
                    >
                      {pct(b.winRate)}
                    </span>
                    <span className="ml-2 text-micro text-text-dim">
                      {b.games} game{b.games === 1 ? "" : "s"}
                    </span>
                  </span>
                </div>
                <WrBar wins={b.wins} losses={b.losses} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
