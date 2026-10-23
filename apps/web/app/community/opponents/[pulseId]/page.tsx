import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Map as MapIcon, Swords, Users } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/Stat";
import { pct1, wrColor } from "@/lib/format";
import { raceIconName } from "@/lib/race";
import { getJsonWithStatus } from "@/lib/serverApi";
import {
  OPPONENT_PROFILE_MIN_PLAYERS,
  mapRows,
  meetsPlayerFloor,
  opponentHeading,
  opponentMetaTitle,
  opponentRace,
  strategyShares,
  type CommunityOpponentAggregate,
} from "@/lib/communityOpponent";

/**
 * Public scouting profile for one opponent, combined from every SC2
 * Tools player who has faced them.
 *
 *   - API 404 (fewer than the minimum number of players): a real 404,
 *     noindex. The page never hints at what is below the floor.
 *   - API unreachable or 5xx: thrown to the error boundary, noindex,
 *     so an outage never reads as "not enough data".
 *   - Otherwise the aggregate, indexable. Every win/loss is from the
 *     opponent's side, and the title names the race and the SC2Pulse
 *     character id, never the toon handle in the URL.
 */

interface PageProps {
  params: Promise<{ pulseId: string }>;
}

/** generateMetadata and the page make the same request; Next dedupes it. */
function loadOpponent(pulseId: string) {
  return getJsonWithStatus<CommunityOpponentAggregate>(
    `/v1/community/opponents/${encodeURIComponent(pulseId)}`,
  );
}

const THEIR_SIDE = "From the opponent's side";

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { pulseId } = await params;
  const { data, status } = await loadOpponent(pulseId);
  if (status === 404 || (data && !meetsPlayerFloor(data))) notFound();
  if (!data) {
    return {
      title: "Opponent profile unavailable · Community",
      robots: { index: false, follow: false },
    };
  }
  return {
    title: `${opponentMetaTitle(data)} · Community`,
    description: `How this StarCraft II opponent plays, combined from ${data.contributors} SC2 Tools players' games: record, strategies and maps. Names and battle tags are never shown.`,
    robots: { index: true, follow: true },
  };
}

export default async function CommunityOpponentPage({ params }: PageProps) {
  const { pulseId } = await params;
  const { data, status } = await loadOpponent(pulseId);
  if (status === 404 || (data && !meetsPlayerFloor(data))) notFound();
  if (!data) {
    // The error boundary offers Try again; the metadata above is noindex.
    throw new Error("community_opponent_unavailable");
  }

  const race = opponentRace(data.race);
  const strategies = strategyShares(data.strategies);
  const maps = mapRows(data.byMap);
  const total = data.wins + data.losses;

  return (
    <article className="space-y-6">
      <Link
        href="/community"
        className="inline-flex min-h-[44px] items-center gap-1.5 text-caption font-medium text-text-muted hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back to community
      </Link>

      <PageHeader
        eyebrow="Community · Opponent profile"
        title={opponentHeading(data.race)}
        description={`Combined from ${data.contributors} SC2 Tools players who have faced this opponent. Names and battle tags are never shown.`}
      />

      <section aria-label="Overview" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          size="sm"
          label="Race"
          value={
            race ? (
              <span className="inline-flex items-center gap-2">
                <Icon name={raceIconName(race)} kind="race" size={20} decorative />
                {race}
              </span>
            ) : (
              "Unknown"
            )
          }
        />
        <StatCard size="sm" label="Games" value={data.games.toLocaleString()} hint={`${data.contributors} players`} />
        <StatCard
          size="sm"
          label="Wins – losses"
          value={<span className="font-mono">{`${data.wins}–${data.losses}`}</span>}
          hint={THEIR_SIDE}
        />
        <StatCard
          size="sm"
          label="Win rate"
          value={<span className="font-mono">{total > 0 ? pct1(data.winRate) : "—"}</span>}
          hint={THEIR_SIDE}
        />
      </section>

      <Card
        title={
          <span className="inline-flex items-center gap-2">
            <Swords className="h-4 w-4 text-text-muted" aria-hidden />
            Strategies seen
          </span>
        }
      >
        {strategies.length === 0 ? (
          <p className="text-caption text-text-muted">
            None of these games have a recognised strategy yet.
          </p>
        ) : (
          <ul className="space-y-3">
            {strategies.map((row) => (
              <li key={row.name} className="space-y-1">
                <div className="flex items-baseline justify-between gap-3 text-body">
                  <span className="min-w-0 break-words text-text">{row.name}</span>
                  <span className="shrink-0 font-mono text-caption tabular-nums text-text-muted">
                    {Math.round(row.share * 100)}%
                    <span className="text-text-dim"> · {row.games} {row.games === 1 ? "game" : "games"}</span>
                  </span>
                </div>
                <div aria-hidden className="h-2 w-full overflow-hidden rounded-full bg-bg-elevated">
                  <div className="h-full rounded-full bg-accent-cyan" style={{ width: `${row.share * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title={
          <span className="inline-flex items-center gap-2">
            <MapIcon className="h-4 w-4 text-text-muted" aria-hidden />
            Maps
          </span>
        }
      >
        {maps.length === 0 ? (
          <p className="text-caption text-text-muted">No map data yet.</p>
        ) : (
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[420px] text-caption">
              <caption className="px-1 pb-3 text-left text-caption text-text-muted">
                Wins, losses and win rate are from the opponent&apos;s side. Most-played maps first.
              </caption>
              <thead className="bg-bg-elevated text-left text-micro uppercase tracking-wider text-text-dim">
                <tr>
                  <th scope="col" className="px-3 py-2 font-semibold">Map</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">Games</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">Their W–L</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">Their win rate</th>
                </tr>
              </thead>
              <tbody>
                {maps.map((row) => (
                  <tr key={row.map} className="border-t border-border">
                    <th scope="row" className="px-3 py-2 text-left font-medium text-text">{row.map}</th>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-text">{row.games}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-text-muted">
                      <span className="text-success">{row.wins}</span>–<span className="text-danger">{row.losses}</span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-2">
                        <div aria-hidden className="h-1.5 w-16 overflow-hidden rounded-full bg-bg-elevated">
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${row.winRate * 100}%`, backgroundColor: wrColor(row.winRate, row.games) }}
                          />
                        </div>
                        <span className="w-12 text-right font-mono tabular-nums text-text">{pct1(row.winRate)}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="flex items-start gap-2 text-caption text-text-muted">
        <Users className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>
          A profile is public only once at least {OPPONENT_PROFILE_MIN_PLAYERS} different SC2 Tools
          players have faced this opponent, so no one player&apos;s games can be picked out.
        </span>
      </p>
    </article>
  );
}
