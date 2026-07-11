"use client";

import { useEffect, useState } from "react";
import { Fingerprint } from "lucide-react";
import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
} from "recharts";
import { useApi } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";

/**
 * Skill Fingerprint — the identity artifact at the top of the Trends
 * tab. A radar of the player's skill dimensions (Macro, Mechanics,
 * Spending, Consistency, Aggression, Ladder), each a percentile
 * against players in the same league band + matchup, headlined by the
 * auto-derived playstyle label. Axis formulas + the playstyle decision
 * table live in apps/api/src/services/skillFingerprint.js.
 *
 * Axes the API couldn't compute (no percentile table for the band,
 * metric under the k-anonymity floor) arrive with `percentile: null`
 * and are hidden rather than plotted as fake zeroes. Below 10 games in
 * the selected matchup the API 404s with `not_enough_games` and the
 * card shows a friendly empty state instead.
 */

type FingerprintAxis = {
  key: string;
  label: string;
  percentile: number | null;
  value: number | null;
};

type FingerprintData = {
  matchup: string;
  band: { leagueId: number; label: string } | null;
  games: number;
  axes: FingerprintAxis[];
  playstyle: string;
};

type FingerprintResp = { fingerprint: FingerprintData };

type RaceLetter = "P" | "T" | "Z";

const RACE_LETTERS: ReadonlyArray<RaceLetter> = ["P", "T", "Z"];

const RACE_NAMES: Record<RaceLetter, string> = {
  P: "Protoss",
  T: "Terran",
  Z: "Zerg",
};

const LS_MATCHUP = "analyzer.fingerprint.matchup";

function readStoredMatchup(): string {
  if (typeof window === "undefined") return "PvZ";
  try {
    const v = window.localStorage.getItem(LS_MATCHUP);
    return v && /^[PTZ]v[PTZ]$/.test(v) ? v : "PvZ";
  } catch {
    return "PvZ";
  }
}

/** 72 → "72nd", 41 → "41st", 100 → "100th". */
function ordinal(n: number): string {
  const rem = n % 100;
  if (rem >= 11 && rem <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/**
 * Screen-reader sentence for the radar (role="img"). Only computed
 * axes appear; Consistency is phrased as a score (it isn't a
 * percentile — see the API service docs).
 */
function ariaSummary(fp: FingerprintData): string {
  const parts = fp.axes
    .filter((a) => a.percentile != null)
    .map((a) =>
      a.key === "consistency"
        ? `${a.label} score ${a.percentile} of 100`
        : `${a.label} ${ordinal(a.percentile as number)} percentile`,
    );
  const vsBand = fp.band ? ` versus ${fp.band.label} opposition` : "";
  return (
    `Skill fingerprint for ${fp.matchup}${vsBand} across ${fp.games} games: ` +
    `${parts.join(", ")}. Playstyle: ${fp.playstyle}.`
  );
}

export function FingerprintCard() {
  const [matchup, setMatchup] = useState<string>(readStoredMatchup);
  useEffect(() => {
    try {
      window.localStorage.setItem(LS_MATCHUP, matchup);
    } catch {
      /* non-fatal */
    }
  }, [matchup]);

  const { data, isLoading, error } = useApi<FingerprintResp>(
    `/v1/me/fingerprint?matchup=${matchup}`,
    { revalidateOnFocus: false },
  );

  const my = matchup[0] as RaceLetter;
  const vs = matchup[2] as RaceLetter;
  const picker = (
    <MatchupPicker
      my={my}
      vs={vs}
      onChange={(m, v) => setMatchup(`${m}v${v}`)}
    />
  );

  const fp = data?.fingerprint;
  const notEnough = error?.status === 404;

  return (
    <Card title="Skill fingerprint" right={picker}>
      {isLoading ? (
        <Skeleton rows={3} />
      ) : notEnough ? (
        <EmptyStatePanel
          size="md"
          icon={<Fingerprint className="h-5 w-5" aria-hidden />}
          title={`Not enough ${matchup} games yet`}
          description={`Play at least 10 ${matchup} games and your fingerprint appears here — each axis is your percentile against players facing the same league of opposition.`}
        />
      ) : error ? (
        <EmptyStatePanel
          size="sm"
          title="Couldn't load your fingerprint"
          description="Try again in a moment."
        />
      ) : fp ? (
        <FingerprintBody fp={fp} />
      ) : null}
    </Card>
  );
}

function FingerprintBody({ fp }: { fp: FingerprintData }) {
  const visible = fp.axes.filter((a) => a.percentile != null);
  const radarData = visible.map((a) => ({
    axis: a.label,
    pct: a.percentile as number,
  }));

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(180px,1fr)_minmax(260px,1.4fr)]">
      <div className="flex flex-col justify-center gap-1">
        <span className="text-micro uppercase tracking-wider text-text-dim">
          Playstyle
        </span>
        <span className="font-display text-xl font-bold text-text">
          {fp.playstyle}
        </span>
        <p className="text-caption text-text-muted">
          {fp.games} games
          {fp.band ? <> · vs {fp.band.label} opposition</> : null}
        </p>
        <p className="text-micro text-text-dim">
          Percentiles vs. players facing the same league in {fp.matchup}.
        </p>
      </div>

      {radarData.length >= 3 ? (
        <div
          role="img"
          aria-label={ariaSummary(fp)}
          className="mx-auto h-[260px] w-full min-w-0 max-w-md sm:h-[300px]"
        >
          <ResponsiveContainer width="100%" height="100%">
            <RadarChart data={radarData} outerRadius="72%">
              <PolarGrid stroke="rgb(var(--border-strong))" />
              <PolarAngleAxis
                dataKey="axis"
                tick={{ fill: "rgb(var(--text-muted))", fontSize: 11 }}
              />
              <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
              <Radar
                dataKey="pct"
                stroke="rgb(var(--accent-cyan))"
                strokeWidth={2}
                fill="rgb(var(--accent-cyan))"
                fillOpacity={0.25}
                isAnimationActive={false}
              />
            </RadarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        // Fewer than 3 computable axes (band table still filling in):
        // a radar would collapse to a line, so list what we have.
        <ul
          role="img"
          aria-label={ariaSummary(fp)}
          className="flex flex-col justify-center gap-2"
        >
          {visible.map((a) => (
            <li
              key={a.key}
              className="flex items-baseline justify-between gap-3 text-sm"
            >
              <span className="text-text-muted">{a.label}</span>
              <span className="font-semibold tabular-nums text-text">
                {a.key === "consistency"
                  ? `${a.percentile}/100`
                  : `${ordinal(a.percentile as number)} pct`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Compact two-sided matchup picker: "I play [P T Z] vs [P T Z]".
 * Mirrors the settings randomizer's chip idiom scaled down to fit a
 * card header.
 */
function MatchupPicker({
  my,
  vs,
  onChange,
}: {
  my: RaceLetter;
  vs: RaceLetter;
  onChange: (my: RaceLetter, vs: RaceLetter) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <ChipGroup
        side="I play"
        active={my}
        onPick={(letter) => onChange(letter, vs)}
      />
      <span className="text-micro font-bold text-text-dim">vs</span>
      <ChipGroup
        side="Versus"
        active={vs}
        onPick={(letter) => onChange(my, letter)}
      />
    </div>
  );
}

function ChipGroup({
  side,
  active,
  onPick,
}: {
  side: string;
  active: RaceLetter;
  onPick: (letter: RaceLetter) => void;
}) {
  return (
    <div role="group" aria-label={side} className="flex items-center gap-1">
      {RACE_LETTERS.map((letter) => {
        const isActive = letter === active;
        return (
          <button
            key={letter}
            type="button"
            aria-label={`${side} ${RACE_NAMES[letter]}`}
            aria-pressed={isActive}
            onClick={() => onPick(letter)}
            className={[
              "flex h-8 w-8 items-center justify-center rounded-lg border text-caption font-bold",
              "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
              isActive
                ? "border-accent bg-accent/15 text-accent"
                : "border-border bg-bg-elevated text-text-muted hover:bg-bg-surface hover:text-text",
            ].join(" ")}
          >
            {letter}
          </button>
        );
      })}
    </div>
  );
}
