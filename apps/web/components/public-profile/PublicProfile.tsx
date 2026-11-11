import { serializeJsonLd } from "@/lib/reviewJsonLd";
import Link from "next/link";
import { ArrowBigDown, ArrowBigUp, MessageSquareText, Swords, Trophy } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { Card, WrBar } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { Icon } from "@/components/ui/Icon";
import { InfoTip } from "@/components/ui/InfoTip";
import { StatCard } from "@/components/ui/Stat";
import { pct, wrColor } from "@/lib/format";
import { raceIconName, type Race } from "@/lib/race";
import { verifiedRegionsLabel } from "@/lib/reviews";
import { GetYourOwnCTA } from "./GetYourOwnCTA";
import { PlayerProfileHero, profileRace } from "./PlayerProfileHero";
import type {
  PublicPlayerProfile,
  PublicProfileFeaturedBuild,
  PublicProfileMatchupSplit,
  PublicProfileSignatureBuild,
  PublicReviewerSection,
} from "./types";
import { formatNumber } from "@/lib/i18n/format";

export interface PublicProfileProps {
  profile: PublicPlayerProfile;
  showHero?: boolean;
  showReviewer?: boolean;
}

/**
 * PublicProfile — the shareable, SSR-rendered public player page body
 * for /p/[handle].
 *
 * Renders only non-sensitive aggregates (headline record, matchup
 * splits, the player's replay-detected signature builds) plus a viral "get your own"
 * CTA. No opponent identities, no per-game rows ever reach this
 * component — the API strips them before the payload leaves the server.
 *
 * Responsive: single column at 360px, two-column content grid from lg.
 * Dark + light via repo tokens. Server-component-safe.
 */
export function PublicProfile({ profile, showHero = true, showReviewer = true }: PublicProfileProps) {
  const race = profileRace(profile.mainRace);
  const { games, wins, losses, winRate } = profile.totals;
  const archive = profile.replayArchive && (profile.sections?.showReplays ?? true)
    ? "/players/" + encodeURIComponent(profile.replayArchive.handle) + "/replays" : undefined;

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
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(personJsonLd) }}
      />

      {showHero ? <PlayerProfileHero profile={profile} /> : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Games" value={formatNumber(games)} />
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
        <MatchupHighlight rows={profile.matchups} games={games} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <MatchupSplits rows={profile.matchups} archive={archive} mainRace={race} />
        <SignatureBuilds rows={profile.signatureBuilds} archive={archive} />
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
                <FeaturedVotes build={profile.featuredBuild} />
              </span>
            </Link>
          </div>
        </Card>
      ) : null}

      {showReviewer && profile.reviewer ? <ReviewerSection reviewer={profile.reviewer} /> : null}

      <GetYourOwnCTA />
    </article>
  );
}

export function ReviewerSection({ reviewer }: { reviewer: PublicReviewerSection }) {
  return (
    <Card>
      <div className="space-y-3">
        <h2 className="text-caption font-semibold uppercase tracking-wider text-text">
          <span className="inline-flex items-center gap-1.5">
            <MessageSquareText className="h-4 w-4 text-accent-cyan" aria-hidden />
            Replay reviewer
          </span>
        </h2>
        <p className="text-body text-text">
          <strong>{reviewer.karma}</strong> karma · {reviewer.reviews} review{reviewer.reviews === 1 ? "" : "s"} ·{" "}
          {reviewer.bestAnswers} best answer{reviewer.bestAnswers === 1 ? "" : "s"} · {reviewer.helpful} marked helpful
        </p>
        <div className="flex flex-wrap gap-1.5">
          {reviewer.verified ? (
            <Badge variant="cyan" size="sm">
              Verified {verifiedRegionsLabel(reviewer.verified)}
            </Badge>
          ) : null}
          {reviewer.flair ? <Badge variant="signal" size="sm">{reviewer.flair}</Badge> : null}
          {reviewer.badges.map((b) => <Badge key={b.key} variant="neutral" size="sm">{b.label}</Badge>)}
        </div>
        {reviewer.matchupsReviewed.length ? (
          <p className="text-caption text-text-muted">
            Matchups reviewed:{" "}
            {reviewer.matchupsReviewed.map((m) => `${m.matchup} (${m.count})`).join(" · ")}
          </p>
        ) : null}
      {reviewer.matchupsSampled ? <p className="text-caption text-text-muted">Matchup totals use up to 2,000 recent review threads.</p> : null}
        <Link href="/reviews" className="inline-flex text-caption font-semibold text-accent-cyan underline underline-offset-2 hover:text-accent-hover">
          Browse replay reviews
        </Link>
      </div>
    </Card>
  );
}

const MIN_BEST_MATCHUP_GAMES = 10;

function MatchupHighlight({ rows, games }: { rows: PublicProfileMatchupSplit[]; games: number }) {
  const ranked = rows.filter((row) => profileRace(row.matchup));
  const best = ranked.filter((row) => row.wins + row.losses >= MIN_BEST_MATCHUP_GAMES)
    .sort((a, b) => b.winRate - a.winRate || (b.wins + b.losses) - (a.wins + a.losses))[0];
  if (games > 0 && best) return <StatCard label="Best matchup"
    value={<span style={{ color: wrColor(best.winRate, best.wins + best.losses) }}>
      {"vs " + profileRace(best.matchup) + " · " + pct(best.winRate)}
    </span>} />;
  const most = [...ranked].sort((a, b) => b.games - a.games)[0];
  return <StatCard label="Most played" value={games > 0 && most
    ? "vs " + profileRace(most.matchup) + " · " + pct(most.games / games) + " of games" : "—"} />;
}

function FeaturedVotes({ build }: { build: PublicProfileFeaturedBuild }) {
  const { votes, voteCounts } = build;
  if (voteCounts) {
    const { upvotes, downvotes } = voteCounts;
    return <span className="inline-flex items-center gap-2 tabular-nums">
      <span className="inline-flex items-center gap-1" aria-hidden>
        <ArrowBigUp className="h-4 w-4" />{formatNumber(upvotes)}
      </span>
      <span className="inline-flex items-center gap-1" aria-hidden>
        <ArrowBigDown className="h-4 w-4" />{formatNumber(downvotes)}
      </span>
      <span className="sr-only">{formatNumber(upvotes)} upvote{upvotes === 1 ? "" : "s"}, {formatNumber(downvotes)} downvote{downvotes === 1 ? "" : "s"}</span>
    </span>;
  }
  const Icon = votes < 0 ? ArrowBigDown : ArrowBigUp;
  return <span className="inline-flex items-center gap-1 tabular-nums">
    <Icon className="h-4 w-4" aria-hidden />
    <span aria-hidden>{Math.abs(votes)}</span>
    <span className="sr-only">{Math.abs(votes)} net {votes < 0 ? "downvotes" : "upvotes"}</span>
  </span>;
}

function ReplayDrilldown({ href, children }: { href?: string; children: ReactNode }) {
  return href ? <Link href={href} className="group block min-h-11 space-y-1 rounded-md px-2 py-1 hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
    {children}
    <span className="block text-micro font-semibold text-link sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-visible:opacity-100">View replays →</span>
  </Link> : <div className="space-y-1">{children}</div>;
}

function matchupArchiveHref(archive: string | undefined, mainRace: Race | null, opponent: Race | null) {
  if (!archive || !mainRace || mainRace === "Random" || !opponent || opponent === "Random") return undefined;
  return archive + "?matchup=" + mainRace[0] + "v" + opponent[0];
}

function MatchupSplits({ rows, archive, mainRace }: { rows: PublicProfileMatchupSplit[]; archive?: string; mainRace: Race | null }) {
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
          <ul className="space-y-3">
            {rows.map((m) => (
              <li key={m.matchup}>
                <ReplayDrilldown href={matchupArchiveHref(archive, mainRace, profileRace(m.matchup))}>
                <div className="flex flex-wrap items-baseline justify-between gap-3 text-body">
                  <ProfileMatchupLabel value={m.matchup} />
                  <span className="tabular-nums text-text-muted">
                    <span className="text-success">{m.wins}</span>
                    <span className="text-text-dim">–</span>
                    <span className="text-danger">{m.losses}</span>
                    <span
                      className="ml-2 font-mono text-text"
                    >
                      {pct(m.winRate)}
                    </span>
                  </span>
                </div>
                <WrBar wins={m.wins} losses={m.losses} />
                </ReplayDrilldown>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function ProfileMatchupLabel({ value }: { value: string }) {
  const race = profileRace(value);
  return <span className="inline-flex items-center gap-1.5 font-medium text-text">{race ? <Icon name={raceIconName(race)} kind="race" size={14} decorative /> : null}vs {race || "Unknown race"}</span>;
}

function SignatureBuilds({ rows, archive }: { rows: PublicProfileSignatureBuild[]; archive?: string }) {
  return (
    <Card>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-caption font-semibold uppercase tracking-wider text-text">Signature builds</h2>
          {archive ? <InfoTip termId="detected-build-counts" label="detected build counts" /> : null}
        </div>
        <p className="text-caption text-text-muted">Builds detected from recorded replays.</p>
        {rows.length === 0 ? (
          <EmptyStatePanel
            size="sm"
            title="No signature builds yet"
            description="A build shows up here once it's been played a few times."
          />
        ) : (
          <ul className="space-y-3">
            {rows.map((b) => (
              <li key={b.name}>
                <ReplayDrilldown href={archive ? archive + "?build=" + encodeURIComponent(b.name) : undefined}>
                <div className="flex flex-wrap items-baseline justify-between gap-3 text-body">
                  <span className="min-w-0 break-words font-medium text-text">
                    {b.name}
                  </span>
                  <span className="shrink-0 tabular-nums text-text-muted">
                    <span
                      className="font-mono text-text"
                    >
                      {pct(b.winRate)}
                    </span>
                    <span className="ml-2 text-micro text-text-dim">
                      {b.games} game{b.games === 1 ? "" : "s"}
                    </span>
                  </span>
                </div>
                <WrBar wins={b.wins} losses={b.losses} />
                </ReplayDrilldown>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
