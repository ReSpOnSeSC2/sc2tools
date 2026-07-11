"use client";

import { useMemo } from "react";
import { ExternalLink, Radio } from "lucide-react";
import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useApi } from "@/lib/clientApi";
import { Card, Skeleton, Stat } from "@/components/ui/Card";

/**
 * SC2Pulse ladder context for one opponent — the screen players used
 * to open in a separate SC2Pulse tab mid-queue: current league/tier,
 * ladder percentile, season record, peak MMR, a 90-day rating
 * sparkline, and (when the character is linked) the pro identity with
 * stream/social links plus known alternate accounts.
 *
 * Renders nothing when the opponent's SC2Pulse character id hasn't
 * resolved yet (the backfill cron heals that over time) — the dossier
 * must not degrade for unresolved opponents.
 */

type PulseIntel = {
  characterId: string;
  region: string | null;
  current: {
    rating: number;
    wins: number;
    losses: number;
    leagueType: number | null;
    tier: number | null;
    region: string | null;
    season: number | null;
    globalRank: number | null;
    lastPlayed: string | null;
  } | null;
  league: { type: number; label: string; tier: number | null } | null;
  percentile: number | null;
  peakRating: number | null;
  leagueMax: { type: number; label: string } | null;
  totalGamesPlayed: number | null;
  ratingHistory: Array<{ t: string; rating: number }>;
  pro: {
    nickname: string;
    name: string | null;
    country: string | null;
    earnings: number | null;
    team: string | null;
    links: Record<string, string>;
  } | null;
  linkedCharacters: Array<{
    characterId: string;
    name: string | null;
    region: string | null;
    ratingMax: number | null;
    leagueMax: number | null;
  }>;
  pulseProfileUrl: string;
};

type PulseIntelResp = { intel: PulseIntel | null };

// League accent tints, dark/light safe via existing tokens where
// possible. GM gets the warning tint (it IS a warning).
const LEAGUE_TINT: Record<string, string> = {
  Bronze: "rgb(176 141 87)",
  Silver: "rgb(154 163 178)",
  Gold: "rgb(212 175 55)",
  Platinum: "rgb(126 208 205)",
  Diamond: "rgb(96 165 250)",
  Master: "rgb(167 139 250)",
  Grandmaster: "rgb(var(--warning))",
};

export function LadderContextCard({ pulseId }: { pulseId: string }) {
  const { data, isLoading } = useApi<PulseIntelResp>(
    `/v1/opponents/${encodeURIComponent(pulseId)}/pulse-intel`,
    { revalidateOnFocus: false },
  );

  const spark = useMemo(
    () =>
      (data?.intel?.ratingHistory || []).map((p) => ({
        t: p.t,
        rating: p.rating,
      })),
    [data?.intel?.ratingHistory],
  );

  if (isLoading) {
    return (
      <Card title="Ladder context">
        <Skeleton rows={2} />
      </Card>
    );
  }
  const intel = data?.intel;
  if (!intel) return null;

  const league = intel.league;
  const tint = league ? LEAGUE_TINT[league.label] : undefined;
  const seasonRecord = intel.current
    ? `${intel.current.wins}-${intel.current.losses}`
    : "—";

  return (
    <Card
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          Ladder context
          {league ? (
            <span
              className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-caption font-semibold"
              style={{ color: tint, borderColor: tint }}
            >
              {league.label}
              {league.tier ? ` ${league.tier}` : ""}
            </span>
          ) : null}
          {intel.percentile !== null ? (
            <span className="text-caption font-medium text-text-muted">
              top {intel.percentile}%{intel.region ? ` · ${intel.region}` : ""}
            </span>
          ) : null}
        </span>
      }
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_minmax(200px,280px)]">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="Current MMR"
              value={intel.current ? intel.current.rating : "—"}
            />
            <Stat label="Season W-L" value={seasonRecord} />
            <Stat label="Peak MMR" value={intel.peakRating ?? "—"} />
            <Stat
              label="Ranked games"
              value={intel.totalGamesPlayed ?? "—"}
            />
          </div>

          {intel.pro ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
              <Radio className="h-4 w-4 text-warning" aria-hidden />
              <span className="font-semibold text-text">
                Pro player: {intel.pro.nickname}
              </span>
              {intel.pro.name ? (
                <span className="text-text-muted">({intel.pro.name})</span>
              ) : null}
              {intel.pro.team ? (
                <span className="text-text-muted">· {intel.pro.team}</span>
              ) : null}
              {intel.pro.links.twitch ? (
                <a
                  href={intel.pro.links.twitch}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex min-h-[32px] items-center gap-1 text-accent hover:underline"
                >
                  Twitch
                  <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              ) : null}
            </div>
          ) : null}

          {intel.linkedCharacters.length > 0 ? (
            <p className="text-caption text-text-muted">
              Also plays as{" "}
              {intel.linkedCharacters
                .slice(0, 4)
                .map(
                  (c) =>
                    `${c.name || c.characterId}${c.region ? ` (${c.region})` : ""}`,
                )
                .join(", ")}
              {intel.linkedCharacters.length > 4
                ? ` +${intel.linkedCharacters.length - 4} more`
                : ""}
            </p>
          ) : null}

          <a
            href={intel.pulseProfileUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex min-h-[32px] items-center gap-1 text-caption text-accent hover:underline"
          >
            Full profile on SC2Pulse
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        </div>

        {spark.length >= 2 ? (
          <figure
            aria-label={`MMR over the last 90 days, currently ${
              intel.current ? intel.current.rating : "unknown"
            }`}
            className="min-w-0"
          >
            {/* Fixed height on purpose. ``md:h-full`` here created a
                feedback loop: the grid row's height comes from this
                column's content, so ResponsiveContainer measured the
                parent, rendered that tall, the parent grew, it
                re-measured — the card inflated without bound (the
                "infinitely tall dossier" bug). A chart inside a
                percentage-height box must sit under a fixed-height
                ancestor. */}
            <div className="h-24 w-full md:h-28">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={spark}
                  margin={{ top: 6, right: 4, bottom: 2, left: 4 }}
                >
                  {/* Without an XAxis dataKey, recharts labels tooltip
                      points by array index; Date("52") parses as the
                      year 1952, so hovering showed 1950s dates. */}
                  <XAxis dataKey="t" hide />
                  <YAxis domain={["dataMin - 50", "dataMax + 50"]} hide />
                  <Tooltip
                    formatter={(value) => [`${value} MMR`, ""]}
                    labelFormatter={(label) => {
                      const d = new Date(String(label));
                      return Number.isNaN(d.getTime())
                        ? ""
                        : d.toLocaleDateString();
                    }}
                    contentStyle={{
                      background: "rgb(var(--bg-elevated))",
                      border: "1px solid rgb(var(--border))",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="rating"
                    stroke="rgb(var(--accent-cyan))"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <figcaption className="mt-1 text-right text-micro text-text-dim">
              MMR · last 90 days
            </figcaption>
          </figure>
        ) : null}
      </div>
    </Card>
  );
}
