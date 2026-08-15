"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, CircleHelp, Fingerprint } from "lucide-react";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { longLabelFor } from "@/lib/datePresets";
import { Card, Skeleton } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";

type FingerprintAxis = {
  key: string;
  label: string;
  position: number | null;
  value: number | null;
  category: string | null;
  categoryLabel: string | null;
  sampleSize: number;
  detail: AxisDetail | null;
  /** Population-calibrated naming score; independent from marker position. */
  distinctiveness?: number;
  calibration?: {
    method?: "two_sided_percentile" | "tier_rarity" | string;
    populationSize?: number;
    percentile?: number;
    tierFrequency?: number;
    distinctiveness?: number;
  } | null;
  /** Why an unrated track is unrated. Null once the track has a category. */
  reason: AxisReason | string | null;
  have: number | null;
  needed: number | null;
};

/** Per-axis derived measures. `value` stays the axis's headline unit. */
type AxisDetail = {
  method?: string;
  formula?: string;
  effectiveBuilds?: number;
  distinctBuilds?: number;
  topBuildShare?: number | null;
  averageSec?: number | null;
  earlyShare?: number | null;
  midShare?: number | null;
  lateShare?: number | null;
  medianSec?: number | null;
  meanSec?: number;
  belowFive?: CountShare;
  fiveToTen?: CountShare;
  aboveTen?: CountShare;
  tenToFifteen?: CountShare;
  aboveFifteen?: CountShare;
  winRate?: number;
  comparatorWinRate?: number;
  comparedAgainst?: string[];
  signedEdge?: number;
  tierScore?: -2 | -1 | 0 | 1 | 2;
  allMatchupSpread?: number | null;
  classificationMethod?: string;
};

type AxisReason =
  | "needs_more_classified_builds"
  | "needs_more_timed_games"
  | "needs_more_decided_games"
  | "no_comparison_matchup";

type FingerprintStatus = "complete" | "partial" | "insufficient";

/**
 * The trait vocabulary, served with every response. Nothing about thresholds
 * or archetype names is hardcoded in this file — the API is the single source
 * of truth, so the two can never drift.
 */
type TaxonomyCategory = {
  key: string;
  label: string;
  noun: string;
  adjective: string;
  blurb: string;
  thresholdText: string;
  score?: -2 | -1 | 0 | 1 | 2;
  trackPosition?: number;
};

type TaxonomyAxis = {
  key: string;
  label: string;
  description: string;
  leftLabel: string;
  centerLabel: string;
  rightLabel: string;
  categories: TaxonomyCategory[];
};

type ArchetypeComponent = {
  axis: string;
  category: string;
  distinctiveness: number;
  role: "core" | "modifier" | "supporting";
};

type FingerprintData = {
  matchup: string;
  race: string;
  games: number;
  windowGames: number;
  /** "recent" = latest N games; "range" = the caller supplied a date range. */
  windowMode: "recent" | "range";
  windowTruncated: boolean;
  /** Wire names of global filters the fingerprint deliberately ignored. */
  strippedFilters: string[];
  status: FingerprintStatus;
  axes: FingerprintAxis[];
  playstyle: string;
  archetype: {
    key: string;
    name: string;
    description: string;
    complete: boolean;
    components: ArchetypeComponent[];
  };
  taxonomy: { axes: TaxonomyAxis[] };
  populationCalibration?: {
    status: "ready" | "unavailable";
    method: "player_population" | string;
    matchup?: string | null;
    populationSize?: number | null;
    updatedAt?: string | null;
    reference?: {
      windowGames?: number;
      windowMode?: string;
      filters?: string;
    } | null;
    version?: number | null;
  };
  buildOrders: Array<{ name: string; games: number }>;
  repertoireSummary?: {
    method?: string;
    formula?: string;
    distinctBuilds: number;
    effectiveBuilds: number;
    topBuildShare?: number | null;
  };
  paceSummary?: {
    averageSec: number | null;
    meanSec?: number | null;
    medianSec: number | null;
    earlyShare?: number | null;
    midShare?: number | null;
    lateShare?: number | null;
    belowFive: CountShare;
    fiveToTen: CountShare;
    aboveTen: CountShare;
    tenToFifteen: CountShare;
    aboveFifteen: CountShare;
  };
  matchupWinRates: MatchupWinRate[];
  matchupSummary: {
    spread: number | null;
    leaderGap: number | null;
    weakGap: number | null;
    strongestMatchup: string | null;
    weakestMatchup: string | null;
    signedEdge?: number | null;
    tierScore?: -2 | -1 | 0 | 1 | 2 | null;
  };
};

type FingerprintResp = { fingerprint: FingerprintData };

type RaceLetter = "P" | "T" | "Z";

type MatchupWinRate = {
  matchup: string;
  games: number;
  decidedGames: number;
  wins: number;
  losses: number;
  ties: number;
  winRate: number | null;
};

type CountShare = {
  games: number;
  percent: number | null;
};
const RACE_LETTERS: ReadonlyArray<RaceLetter> = ["P", "T", "Z"];

const RACE_NAMES: Record<RaceLetter, string> = {
  P: "Protoss",
  T: "Terran",
  Z: "Zerg",
};

/**
 * Purely presentational. Every label, threshold and category name now comes
 * from the response's `taxonomy`; only the gradient is a styling decision, and
 * an unknown axis key falls back to a neutral track rather than breaking.
 */
const TRACK_CLASS: Record<string, string> = {
  repertoire: "from-text-dim/45 via-accent/45 to-accent-cyan/70",
  pace: "from-warning/60 via-accent/40 to-accent-cyan/70",
  matchup_edge: "from-accent-cyan/70 via-accent/30 to-danger/65",
};
const DEFAULT_TRACK_CLASS = "from-text-dim/40 via-accent/40 to-accent-cyan/60";

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

export function FingerprintCard() {
  const { filters, setFilters, dbRev, seasons } = useFilters();
  const [matchup, setMatchup] = useState<string>(readStoredMatchup);
  useEffect(() => {
    try {
      window.localStorage.setItem(LS_MATCHUP, matchup);
    } catch {
      /* non-fatal */
    }
  }, [matchup]);

  // The fingerprint reads the same cohort as every other analyzer card. The
  // SWR key is the path string (lib/clientApi.ts), so the filter state has to
  // live in the path — and `#dbRev` makes the card refresh on new replays,
  // which it never did before.
  const query = useMemo(() => {
    const rest = filtersToQuery(filters);
    return rest ? `&${rest.slice(1)}` : "";
  }, [filters]);
  const { data, isLoading, error } = useApi<FingerprintResp>(
    `/v1/me/fingerprint?matchup=${matchup}${query}#${dbRev}`,
    { revalidateOnFocus: false },
  );

  const my = matchup[0] as RaceLetter;
  const vs = matchup[2] as RaceLetter;
  const fp = data?.fingerprint;
  const noGames = error?.status === 404;
  const rangeLabel = longLabelFor(filters.preset ?? "all", seasons);
  const isAllTime = (filters.preset ?? "all") === "all";
  const useAllTime = () =>
    setFilters({ ...filters, preset: "all", since: undefined, until: undefined });

  return (
    <Card padded={false} aria-labelledby="skill-fingerprint-title">
      <Card.Header className="flex-col items-stretch gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0">
          <h3
            id="skill-fingerprint-title"
            className="text-caption font-semibold text-text"
          >
            Skill fingerprint
          </h3>
          <p className="mt-0.5 text-micro text-text-dim">
            Your 1v1 playstyle · {rangeLabel}
          </p>
        </div>
        <MatchupPicker
          my={my}
          vs={vs}
          onChange={(nextMy, nextVs) => setMatchup(`${nextMy}v${nextVs}`)}
        />
      </Card.Header>

      <Card.Body>
        {isLoading ? (
          <Skeleton rows={3} />
        ) : noGames ? (
          <div data-testid="fingerprint-no-games">
            <EmptyStatePanel
              size="md"
              icon={<Fingerprint className="h-5 w-5" aria-hidden />}
              title={`No ${matchup} games in this range`}
              description={`Nothing matched ${matchup} 1v1 for ${rangeLabel.toLowerCase()}. Widen the date range or clear the ladder filter to see your fingerprint.`}
            />
            {!isAllTime ? <UseAllTimeButton onClick={useAllTime} /> : null}
          </div>
        ) : error ? (
          <EmptyStatePanel
            size="sm"
            title="Couldn't load your fingerprint"
            description="Try again in a moment."
          />
        ) : fp ? (
          <FingerprintBody
            fp={fp}
            rangeLabel={rangeLabel}
            onUseAllTime={isAllTime ? null : useAllTime}
          />
        ) : null}
      </Card.Body>
    </Card>
  );
}

/**
 * Recovery affordance for a range too narrow to rate. Without it, a user who
 * has picked "last 7 days" hits a dead end with no hint that their games exist
 * just outside the window.
 */
function UseAllTimeButton({ onClick }: { onClick: () => void }) {
  return (
    <div className="mt-3 flex justify-center">
      <button
        type="button"
        data-testid="fingerprint-use-all-time"
        onClick={onClick}
        className="min-h-[44px] rounded-lg border border-accent/45 bg-accent/10 px-4 py-2 text-caption font-semibold text-accent-cyan transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        Use all time instead
      </button>
    </div>
  );
}

function FingerprintBody({
  fp,
  rangeLabel,
  onUseAllTime,
}: {
  fp: FingerprintData;
  rangeLabel: string;
  onUseAllTime: (() => void) | null;
}) {
  const axes = new Map(fp.axes.map((axis) => [axis.key, axis]));
  const taxonomyAxes = fp.taxonomy?.axes ?? [];
  const trackCount = taxonomyAxes.length;
  const readyCount = fp.axes.filter((axis) => axis.category).length;
  const repertoire = axes.get("repertoire");
  const pace = axes.get("pace");
  const edge = axes.get("matchup_edge");

  return (
    <div className="space-y-5">
      <section
        className="overflow-hidden rounded-xl border border-accent/35 bg-gradient-to-br from-accent/10 via-bg-surface to-bg-elevated/70 p-4 sm:p-5"
        aria-labelledby="playstyle-heading"
      >
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(280px,0.8fr)] lg:items-end">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="overline text-accent-cyan">Your archetype</span>
              <span
                className={[
                  "rounded-full border px-2.5 py-1 text-micro font-semibold",
                  fp.archetype.complete
                    ? "border-accent/45 bg-accent/10 text-accent-cyan"
                    : "border-warning/45 bg-warning/10 text-warning",
                ].join(" ")}
              >
                {fp.archetype.complete
                  ? "Complete profile"
                  : `${readyCount} of ${trackCount} tracks ready`}
              </span>
            </div>
            <h4
              id="playstyle-heading"
              className="mt-2 font-display text-h2 font-bold text-text"
            >
              {fp.archetype.name || fp.playstyle}
            </h4>
            <p className="mt-2 max-w-2xl text-body leading-relaxed text-text-muted">
              {fp.archetype.description}
            </p>
            {fp.archetype.components.length > 0 ? (
              <NameRationale fp={fp} />
            ) : null}
            <p className="mt-3 text-micro leading-relaxed text-text-dim">
              {windowSummary(fp, rangeLabel)}
            </p>
            {fp.strippedFilters.length > 0 ? (
              <p
                data-testid="fingerprint-stripped-filters"
                className="mt-2 text-micro leading-relaxed text-text-dim"
              >
                {strippedFilterNote(fp.strippedFilters)}
              </p>
            ) : null}
            {fp.status !== "complete" && onUseAllTime ? (
              <div className="mt-3">
                <button
                  type="button"
                  data-testid="fingerprint-use-all-time"
                  onClick={onUseAllTime}
                  className="min-h-[44px] rounded-lg border border-accent/45 bg-accent/10 px-4 py-2 text-caption font-semibold text-accent-cyan transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Use all time instead
                </button>
              </div>
            ) : null}
          </div>

          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-2">
            <HeroStat label="Matchup" value={fp.matchup} />
            <HeroStat
              label="Detected builds"
              value={
                axisAvailable(repertoire)
                  ? repertoireMeasures(fp, repertoire).distinct.toLocaleString()
                  : "Still forming"
              }
            />
            <HeroStat
              label="Effective pool"
              value={
                axisAvailable(repertoire)
                  ? formatOptionalEffective(
                      repertoireMeasures(fp, repertoire).effective,
                    )
                  : "Still forming"
              }
            />
            <HeroStat
              label="Avg game"
              value={
                axisAvailable(pace)
                  ? formatOptionalDuration(paceAverage(fp, pace))
                  : "Still forming"
              }
            />
            <HeroStat
              label="Time profile"
              value={
                axisAvailable(pace)
                  ? pace.categoryLabel ?? "Still forming"
                  : "Still forming"
              }
            />
            <HeroStat
              label="Matchup edge"
              value={
                axisAvailable(edge)
                  ? (edge.categoryLabel ?? "Still forming")
                  : "Still forming"
              }
            />
          </dl>
        </div>
      </section>

      <section aria-labelledby="spectra-heading">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h4 id="spectra-heading" className="text-body font-semibold text-text">
              Your playstyle spectra
            </h4>
            <p className="mt-0.5 text-micro text-text-dim">
              Each marker comes directly from the recent replays shown below it.
            </p>
          </div>
          <span className="rounded-full border border-border bg-bg-elevated px-2.5 py-1 text-micro font-semibold text-text-muted">
            {readyCount} of {trackCount} tracks ready
          </span>
        </div>
        <div className="mt-3 space-y-3">
          {taxonomyAxes.map((meta) => (
            <SpectrumRow
              key={meta.key}
              meta={meta}
              axis={axes.get(meta.key)}
              fp={fp}
            />
          ))}
        </div>
      </section>

      {/* Matchup performance owns a full-width row. Sharing a three-column
          row with the other two evidence cards left it about 110px per
          matchup, which is where its win rates spilled out of their boxes. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="lg:col-span-2">
          <MatchupEvidence fp={fp} />
        </div>
        <PaceEvidence fp={fp} />
        <BuildEvidence fp={fp} />
      </div>
      <MethodologyDetails fp={fp} />
      <ArchetypeVocabulary fp={fp} />
    </div>
  );
}

/**
 * Say which two traits produced the name. The old fixed table could not
 * explain itself; composition can, and a name you can trace is a name you
 * believe.
 */
function NameRationale({ fp }: { fp: FingerprintData }) {
  const named = fp.archetype.components.filter(
    (component) => component.role === "core" || component.role === "modifier",
  );
  if (named.length === 0) return null;
  const labelFor = (component: ArchetypeComponent) =>
    findCategory(fp, component.axis, component.category)?.label ??
    component.category;
  return (
    <p
      data-testid="fingerprint-name-rationale"
      className="mt-2 text-micro leading-relaxed text-text-dim"
    >
      Named for your most distinctive traits:{" "}
      {named.map((component) => labelFor(component)).join(" and ")}.
    </p>
  );
}

function HeroStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-bg-surface/70 px-3 py-2.5">
      <dt className="text-micro font-semibold uppercase tracking-wider text-text-dim">
        {label}
      </dt>
      <dd className="mt-1 break-words font-display text-caption font-bold leading-tight tabular-nums text-text">
        {value}
      </dd>
    </div>
  );
}

function SpectrumRow({
  meta,
  axis,
  fp,
}: {
  meta: TaxonomyAxis;
  axis: FingerprintAxis | undefined;
  fp: FingerprintData;
}) {
  const available = axisAvailable(axis);
  const legendGrid =
    meta.categories.length >= 7
      ? "grid-cols-2 sm:grid-cols-4 xl:grid-cols-7"
      : "grid-cols-2 sm:grid-cols-5";
  const trackTicks = [
    ...new Set(
      meta.categories
        .map((category) => category.trackPosition)
        .filter(
          (position): position is number =>
            typeof position === "number" && Number.isFinite(position),
        ),
    ),
  ];
  if (trackTicks.length === 0) trackTicks.push(50);

  return (
    <article
      data-testid={`fingerprint-axis-${meta.key}`}
      className="rounded-xl border border-border bg-bg-elevated/35 p-3.5 sm:p-4"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h5 className="text-caption font-semibold text-text">{meta.label}</h5>
          <p className="mt-0.5 text-micro leading-relaxed text-text-muted">
            {meta.description}
          </p>
        </div>
        {available && axis ? (
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <span className="rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 text-micro font-semibold text-accent-cyan">
              {axis.categoryLabel}
            </span>
            <span className="font-display text-caption font-bold tabular-nums text-text">
              {axisValueLabel(meta.key, axis)}
            </span>
          </div>
        ) : (
          <span className="self-start rounded-full border border-border bg-bg-surface px-2.5 py-1 text-micro font-semibold text-text-dim">
            Not enough data
          </span>
        )}
      </div>

      {available && axis ? (
        <>
          <div className="mt-4 px-1">
            <div
              className={`relative h-2.5 rounded-full bg-gradient-to-r ${
                TRACK_CLASS[meta.key] ?? DEFAULT_TRACK_CLASS
              }`}
              aria-hidden="true"
            >
              {trackTicks.map((position) => (
                <span
                  key={position}
                  className="absolute top-1/2 h-4 w-px -translate-x-1/2 -translate-y-1/2 bg-text/30"
                  style={{ left: `${position}%` }}
                />
              ))}
              <span
                data-testid={`fingerprint-marker-${meta.key}`}
                className="absolute top-1/2 h-5 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bg bg-text shadow-hard"
                style={{ left: `${clampPosition(axis.position)}%` }}
              />
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-micro font-medium leading-tight text-text-muted">
              <span>{meta.leftLabel}</span>
              <span className="text-center">{meta.centerLabel}</span>
              <span className="text-right">{meta.rightLabel}</span>
            </div>
            <ul className={`mt-3 grid gap-1.5 ${legendGrid}`}>
              {meta.categories.map((category) => {
                const current = category.key === axis.category;
                return (
                <li
                  key={category.key}
                  className={[
                    "rounded-md border px-2 py-1.5 text-center",
                    current
                      ? "border-accent/45 bg-accent/10"
                      : "border-border/75 bg-bg-surface/45",
                  ].join(" ")}
                >
                  <span className="block text-micro font-semibold leading-tight text-text-muted">
                    {category.label}
                  </span>
                  <span className="mt-0.5 block text-micro leading-tight tabular-nums text-text-dim">
                    {category.thresholdText}
                  </span>
                  {typeof category.score === "number" ? (
                    <span className="mt-0.5 block text-micro font-semibold tabular-nums text-text-dim">
                      Score {formatSignedScore(category.score)}
                    </span>
                  ) : null}
                </li>
                );
              })}
            </ul>
          </div>
          {/* A one-dimensional track cannot express a split distribution: a
              two-speed player sits dead centre, indistinguishable from a
              mid-game player. The share bar is what makes that category
              legible rather than looking like a labelling bug. */}
          {meta.key === "pace" && hasShares(axis.detail) ? (
            <PaceShareBar detail={axis.detail} />
          ) : null}
          <p className="mt-3 border-t border-border pt-3 text-caption leading-relaxed text-text-muted">
            {axisEvidence(meta.key, axis, fp)}
          </p>
        </>
      ) : (
        <div className="mt-3 rounded-lg border border-dashed border-border px-3 py-4 text-caption leading-relaxed text-text-dim">
          {missingAxisEvidence(meta.key, axis, fp)} Until then, this track stays
          unranked.
        </div>
      )}
    </article>
  );
}

function PaceShareBar({ detail }: { detail: AxisDetail }) {
  const segments = [
    { key: "early", label: "Early", share: detail.earlyShare ?? 0, cls: "bg-warning/70" },
    { key: "mid", label: "Mid", share: detail.midShare ?? 0, cls: "bg-accent/60" },
    { key: "late", label: "Late", share: detail.lateShare ?? 0, cls: "bg-accent-cyan/70" },
  ].filter((segment) => segment.share > 0);

  return (
    <div className="mt-3" data-testid="fingerprint-pace-shares">
      <div className="flex h-3 w-full overflow-hidden rounded-full border border-border">
        {segments.map((segment) => (
          <div
            key={segment.key}
            className={segment.cls}
            style={{ width: `${Math.round(segment.share * 100)}%` }}
            title={`${segment.label}: ${formatShare(segment.share)}`}
          />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-micro tabular-nums text-text-dim">
        {segments.map((segment) => (
          <span key={segment.key}>
            {segment.label} {formatShare(segment.share)}
          </span>
        ))}
      </div>
    </div>
  );
}

function MatchupEvidence({ fp }: { fp: FingerprintData }) {
  const edge = fp.axes.find((axis) => axis.key === "matchup_edge");
  const detail = edge?.detail;
  const signedEdge = firstFinite(
    detail?.signedEdge,
    fp.matchupSummary.signedEdge,
    edge?.value,
  );
  const tierScore = firstFinite(
    detail?.tierScore,
    fp.matchupSummary.tierScore,
  );
  const allMatchupSpread = firstFinite(
    detail?.allMatchupSpread,
    fp.matchupSummary.spread,
  );
  const strongCategory =
    edge?.category === "specialist" || edge?.category === "matchup_edge";
  const weakCategory =
    edge?.category === "blind_spot" || edge?.category === "matchup_hurdle";
  return (
    <section
      className="rounded-xl border border-border bg-bg-elevated/25 p-4"
      aria-labelledby="matchup-evidence-heading"
    >
      <div className="flex flex-col gap-1.5">
        <div className="min-w-0">
          <h4
            id="matchup-evidence-heading"
            className="text-caption font-semibold text-text"
          >
            Matchup performance
          </h4>
          <p className="mt-0.5 text-micro text-text-dim">
            Your win rates in all three matchups.
          </p>
        </div>
        {/* A wrapping row under the heading, not a right-aligned stack: three
            signed numbers pinned to the right edge crowded the heading on
            phones and pushed past it in a narrow column. */}
        {signedEdge != null || tierScore != null || allMatchupSpread != null ? (
          <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-micro font-semibold tabular-nums text-text-muted">
            {signedEdge != null && edge?.category !== "universalist" ? (
              <li>{formatSignedPoints(signedEdge)} vs your other matchups</li>
            ) : null}
            {tierScore != null ? (
              <li>Score {formatSignedScore(tierScore)}</li>
            ) : null}
            {allMatchupSpread != null ? (
              <li>{formatPointGap(allMatchupSpread)} best to worst</li>
            ) : null}
          </ul>
        ) : null}
      </div>

      {fp.matchupWinRates.length > 0 ? (
        // One box per row on phones, three across from `sm` up — safe now
        // that the section is full width at every breakpoint.
        <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {fp.matchupWinRates.map((row) => {
            const selected = row.matchup === fp.matchup;
            const strong = selected && strongCategory;
            const weak = selected && weakCategory;
            return (
              <div
                key={row.matchup}
                className={[
                  "min-w-0 rounded-lg border p-3",
                  strong
                    ? "border-accent/55 bg-accent/10"
                    : weak
                      ? "border-danger/35 bg-danger/5"
                      : selected
                        ? "border-border-strong bg-bg-surface"
                        : "border-border bg-bg-surface/55",
                ].join(" ")}
              >
                <dt className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                  <span className="font-display text-caption font-bold text-text">
                    {row.matchup}
                  </span>
                  <span className="text-micro font-semibold tabular-nums text-text-dim">
                    {row.decidedGames} decided
                  </span>
                </dt>
                <dd className="mt-2 font-display text-h4 font-bold leading-tight tabular-nums text-text">
                  {formatWinRate(row.winRate)}
                </dd>
                <dd className="mt-1 text-micro tabular-nums text-text-muted">
                  {row.wins}W · {row.losses}L
                  {row.ties > 0 ? ` · ${row.ties}T` : ""}
                </dd>
                {selected ? (
                  <dd
                    className={`mt-2 text-micro font-semibold ${
                      strong
                        ? "text-accent-cyan"
                        : weak
                          ? "text-danger"
                          : "text-text-muted"
                    }`}
                  >
                    Selected matchup
                  </dd>
                ) : null}
              </div>
            );
          })}
        </dl>
      ) : (
        <p className="mt-3 rounded-lg border border-dashed border-border p-4 text-caption text-text-dim">
          Matchup win rates will appear when qualifying games are available.
        </p>
      )}
    </section>
  );
}

function PaceEvidence({ fp }: { fp: FingerprintData }) {
  const pace = fp.axes.find((axis) => axis.key === "pace");
  const summary = fp.paceSummary;
  if (!summary || !pace) return null;
  const available = axisAvailable(pace);

  const bins = [
    { label: "Under 5:00", value: summary.belowFive },
    { label: "5:00–10:00", value: summary.fiveToTen },
    { label: "Over 10:00–15:00", value: summary.tenToFifteen },
    { label: "Over 15:00", value: summary.aboveFifteen },
  ];

  return (
    <section
      className="rounded-xl border border-border bg-bg-elevated/25 p-4"
      aria-labelledby="pace-evidence-heading"
    >
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h4 id="pace-evidence-heading" className="text-caption font-semibold text-text">
            Game-time distribution
          </h4>
          <p className="mt-0.5 text-micro text-text-dim">
            Real timed replays behind your pace profile.
          </p>
        </div>
        {summary.medianSec != null ? (
          <span className="text-micro font-semibold tabular-nums text-text-muted">
            {formatDuration(summary.medianSec)} median
          </span>
        ) : null}
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2">
        {bins.map((bin) => (
          <div
            key={bin.label}
            className="rounded-lg border border-border bg-bg-surface/55 p-2.5"
          >
            <dt className="text-micro font-medium text-text-dim">{bin.label}</dt>
            <dd className="mt-1 font-display text-caption font-bold tabular-nums text-text">
              {formatSharePercent(bin.value.percent)}
            </dd>
            <dd className="mt-0.5 text-micro tabular-nums text-text-muted">
              {bin.value.games} game{bin.value.games === 1 ? "" : "s"}
            </dd>
          </div>
        ))}
      </dl>

      <p className="mt-3 border-t border-border pt-3 text-caption leading-relaxed text-text-muted">
        {available
          ? paceProfileEvidence(pace, summary)
          : `${pace.sampleSize.toLocaleString()} valid timed replay${pace.sampleSize === 1 ? " is" : "s are"} available. The distribution is real, but the pace label stays unranked until ${pace.needed ?? "more"} are available.`}
      </p>
    </section>
  );
}

function BuildEvidence({ fp }: { fp: FingerprintData }) {
  const preview = fp.buildOrders.slice(0, 8);
  const remaining = fp.buildOrders.length - preview.length;
  const repertoire = fp.axes.find((axis) => axis.key === "repertoire");
  const { distinct: distinctBuilds, effective: effectiveBuilds } =
    repertoireMeasures(fp, repertoire);
  return (
    <section
      className="rounded-xl border border-border bg-bg-elevated/25 p-4"
      aria-labelledby="build-evidence-heading"
    >
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h4
            id="build-evidence-heading"
            className="text-caption font-semibold text-text"
          >
            Your recent builds
          </h4>
          <p className="mt-0.5 text-micro text-text-dim">
            Builds detected in your {fp.matchup} replays.
          </p>
        </div>
        <div className="text-right text-micro font-semibold tabular-nums text-text-muted">
          <span className="block">{distinctBuilds} distinct</span>
          {isFiniteNumber(effectiveBuilds) ? (
            <span className="block text-accent-cyan">
              {formatEffectiveBuilds(effectiveBuilds)} effective
            </span>
          ) : null}
        </div>
      </div>

      {fp.buildOrders.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2">
          {preview.map((build, index) => (
            <li
              key={`${build.name}-${index}`}
              className="inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-bg-surface/65 px-2.5 py-1.5 text-caption text-text"
            >
              <span className="min-w-0 truncate">{build.name}</span>
              <span className="flex-none rounded-full bg-bg-elevated px-1.5 py-0.5 text-micro font-semibold tabular-nums text-text-dim">
                {build.games}
              </span>
            </li>
          ))}
          {remaining > 0 ? (
            <li className="inline-flex items-center rounded-lg border border-dashed border-border px-2.5 py-1.5 text-caption font-semibold text-text-dim">
              +{remaining} more
            </li>
          ) : null}
        </ul>
      ) : (
        <p className="mt-3 rounded-lg border border-dashed border-border p-4 text-caption text-text-dim">
          No classified builds in this window yet.
        </p>
      )}
      {isFiniteNumber(effectiveBuilds) && fp.buildOrders.length > 0 ? (
        <p className="mt-3 border-t border-border pt-3 text-micro leading-relaxed text-text-muted">
          {distinctBuilds} detected names become {formatEffectiveBuilds(effectiveBuilds)} effective
          builds after weighting how evenly you used them. This is a diversity
          equivalent, not a fractional build.
        </p>
      ) : null}
    </section>
  );
}

function MethodologyDetails({ fp }: { fp: FingerprintData }) {
  const taxonomyAxes = fp.taxonomy?.axes ?? [];
  const repertoireAxis = fp.axes.find((axis) => axis.key === "repertoire");
  const paceAxis = fp.axes.find((axis) => axis.key === "pace");
  const edgeAxis = fp.axes.find((axis) => axis.key === "matchup_edge");
  const repertoireTaxonomy = taxonomyAxes.find(
    (axis) => axis.key === "repertoire",
  );
  const paceTaxonomy = taxonomyAxes.find((axis) => axis.key === "pace");
  const edgeTaxonomy = taxonomyAxes.find(
    (axis) => axis.key === "matchup_edge",
  );
  const repertoire = repertoireMeasures(fp, repertoireAxis);
  const repertoireFormula =
    fp.repertoireSummary?.formula ??
    repertoireAxis?.detail?.formula ??
    "exp(-sum(p_i * ln(p_i)))";
  const averageSec = paceAverage(fp, paceAxis);
  const medianSec = firstFinite(
    fp.paceSummary?.medianSec,
    paceAxis?.detail?.medianSec,
  );
  const selectedEdge = firstFinite(
    edgeAxis?.detail?.signedEdge,
    fp.matchupSummary.signedEdge,
    edgeAxis?.value,
  );
  const combinationCount = taxonomyCombinationCount(taxonomyAxes);
  return (
    <details className="group rounded-xl border border-border bg-bg-elevated/25">
      <summary className="flex min-h-[48px] cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2 text-caption font-semibold text-text transition-colors hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
        <CircleHelp className="h-4 w-4 flex-none text-accent-cyan" aria-hidden />
        <span>How this fingerprint is calculated</span>
        <ChevronDown
          className="ml-auto h-4 w-4 flex-none text-text-dim transition-transform group-open:rotate-180"
          aria-hidden
        />
      </summary>

      <div className="border-t border-border px-3 py-4 sm:px-4">
        <p className="text-caption leading-relaxed text-text-muted">
          Build variety and game length use {fp.games.toLocaleString()} {fp.matchup}{" "}
          1v1 replay{fp.games === 1 ? "" : "s"}. The matchup-edge track compares
          this matchup against separate windows for your other two. Each track
          needs enough games before it receives a rating.{" "}
          {fp.windowMode === "range"
            ? "These windows follow your dashboard date range."
            : `With no date range set, each window uses your latest ${fp.windowGames.toLocaleString()} games.`}{" "}
          Your race and matchup come from the picker above, not the dashboard
          race filter.
        </p>
        <p className="mt-2 text-caption leading-relaxed text-text-muted">
          Spectrum markers show the absolute replay measurement. The separate
          0&ndash;1 score used to choose the archetype name is calibrated against one
          recent fingerprint per player in {fp.matchup}: continuous measures use
          distance from the population median, while distribution signatures use
          how rare their tier is.
          {fp.populationCalibration?.status === "ready"
            ? ` The current reference contains ${(fp.populationCalibration.populationSize ?? 0).toLocaleString()} qualifying player profiles.`
            : " Population calibration is still building, so no marker position is treated as distinctive by itself."}
        </p>

        <ol className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
          <li className="rounded-lg border border-border bg-bg-surface/55 p-3">
            <p className="text-caption font-semibold text-text">1. Build variety</p>
            <div className="mt-1 space-y-2 text-micro leading-relaxed text-text-muted">
              <p>
                <strong className="text-text">Detected builds</strong> count each
                recognized build name once. <strong className="text-text">Effective
                builds</strong> measure how evenly you actually use those names. For
                each build, <em>p</em> is its share of classified games. Shannon
                diversity converts that entropy back to a build count with{" "}
                <strong className="font-mono text-text">
                  {repertoireFormula}
                </strong>
                , equivalent to exp(&minus;&Sigma; p &times; ln p).
              </p>
              <p>
                If every detected build appears equally often, the two counts are
                equal. Repeated favorites pull the effective count down, while
                occasional one-offs add much less diversity. A decimal is an
                equally-used-build equivalent, not a fractional build order.
              </p>
              {repertoire.distinct > 0 && isFiniteNumber(repertoire.effective) ? (
                <p className="rounded-md border border-accent/20 bg-accent/5 p-2 text-text-muted">
                  In this window, {repertoire.distinct.toLocaleString()} detected
                  build{repertoire.distinct === 1 ? "" : "s"} become{" "}
                  {formatEffectiveBuilds(repertoire.effective)} effective builds.
                  In plain English, your usage mix is as diverse as{" "}
                  {formatEffectiveBuilds(repertoire.effective)} builds used equally
                  often.
                </p>
              ) : (
                <p className="rounded-md border border-border bg-bg-elevated/40 p-2 text-text-dim">
                  {repertoire.distinct > 0
                    ? `${repertoire.distinct.toLocaleString()} detected build${repertoire.distinct === 1 ? " is" : "s are"} available, but an effective-build value was not returned for this window.`
                    : "No named build has been classified in this window yet, so effective diversity is unavailable."}
                </p>
              )}
              <p>
                The unrounded effective value selects one of the five server
                tiers below. Display rounding happens afterward, so it cannot
                move a result across a boundary. Unclassified replays do not
                enter <em>p</em>.
              </p>
              <MethodologyTaxonomyList axis={repertoireTaxonomy} />
            </div>
          </li>

          <li className="rounded-lg border border-border bg-bg-surface/55 p-3">
            <p className="text-caption font-semibold text-text">2. Game-time profile</p>
            <div className="mt-1 space-y-2 text-micro leading-relaxed text-text-muted">
              <p>
                We use the real duration distribution before falling back to the
                average. In order: a short/long split, an 80% over-15:00
                cluster, an 80% under-5:00 cluster, an 80% over-10:00 cluster,
                and an 80% 5:00&ndash;10:00 timing window get first claim. Only
                then do the under-5:00, 5:00&ndash;10:00, and over-10:00 average
                fallbacks apply.
              </p>
              <p>
                Boundaries are deliberate: the split-profile extremes are strictly under
                5:00 and over 15:00; exact 5:00 and 10:00 belong to the timing
                window; Flexible includes exact 5:00 and 10:00 averages. A real
                split can therefore override a misleading middle average.
              </p>
              {averageSec != null || medianSec != null ? (
                <p className="rounded-md border border-accent/20 bg-accent/5 p-2 text-text-muted">
                  This window averages {formatOptionalDuration(averageSec)}
                  {medianSec != null
                    ? ` with a ${formatDuration(medianSec)} median.`
                    : ". The median was not available."}
                  {paceAxis?.categoryLabel
                    ? ` The distribution selects ${paceAxis.categoryLabel}.`
                    : " The profile is still unranked."}
                </p>
              ) : (
                <p className="rounded-md border border-border bg-bg-elevated/40 p-2 text-text-dim">
                  No valid duration summary is available for this window.
                </p>
              )}
              <MethodologyTaxonomyList axis={paceTaxonomy} />
            </div>
          </li>

          <li className="rounded-lg border border-border bg-bg-surface/55 p-3">
            <p className="text-caption font-semibold text-text">3. Selected-matchup edge</p>
            <div className="mt-1 space-y-2 text-micro leading-relaxed text-text-muted">
              <p>
                We compare your {fp.matchup} win rate with the average of your
                other matchups that each have at least eight decided games.
                Positive means this matchup is stronger; negative means it is
                harder. One comparison matchup is enough for an edge or a
                hurdle; Universalist needs all three.
              </p>
              <p>
                Ahead by 10 points or more is Specialist (score +2); behind by
                10 or more is Blind Spot (score &minus;2). Smaller gaps are Edge
                (+1) or Hurdle (&minus;1). If all three matchups qualify and
                their best-to-worst spread is within 5 points, the result is
                Universalist (score 0) instead.
              </p>
              <p>
                The &plusmn;7.5 marks are visual anchors for a clear moderate
                edge, not extra tiers. An exact tie counts as the strength side,
                so every qualifying result gets one label. Ties are displayed
                but do not enter win rates.
              </p>
              {selectedEdge != null ? (
                <p className="rounded-md border border-accent/20 bg-accent/5 p-2 text-text-muted">
                  Your current selected-matchup delta is{" "}
                  {formatSignedPoints(selectedEdge)}
                  {edgeAxis?.detail?.tierScore != null
                    ? ` with score ${formatSignedScore(edgeAxis.detail.tierScore)}`
                    : ""}
                  {edgeAxis?.categoryLabel
                    ? `, selecting ${edgeAxis.categoryLabel}.`
                    : ". The track is still unranked."}
                </p>
              ) : null}
              <MethodologyTaxonomyList axis={edgeTaxonomy} showScores />
            </div>
          </li>
        </ol>

        <p className="mt-4 rounded-lg border border-accent/25 bg-accent/5 p-3 text-micro leading-relaxed text-text-muted">
          Your archetype is named after the two tracks where you are furthest
          from ordinary, so it describes what is distinctive about you rather
          than merely listing buckets. The response currently supplies{" "}
          {combinationCount > 0
            ? `${combinationCount.toLocaleString()} possible three-trait profiles`
            : "the available trait vocabulary"}
          ; names are composed from that same vocabulary, not maintained in a
          separate hardcoded catalog. If a track needs more games, your profile
          stays incomplete until the replay data is there.
        </p>
      </div>
    </details>
  );
}

function MethodologyTaxonomyList({
  axis,
  showScores = false,
}: {
  axis: TaxonomyAxis | undefined;
  showScores?: boolean;
}) {
  if (!axis || axis.categories.length === 0) {
    return (
      <p className="text-text-dim">
        Category rules were not returned for this track.
      </p>
    );
  }
  return (
    <ul className="space-y-1.5" data-testid={`methodology-tiers-${axis.key}`}>
      {axis.categories.map((category) => (
        <li key={category.key} className="rounded-md bg-bg-elevated/45 px-2 py-1.5">
          <span className="font-semibold text-text-muted">{category.label}</span>
          {showScores && typeof category.score === "number"
            ? ` (score ${formatSignedScore(category.score)})`
            : ""}
          {category.thresholdText ? ` — ${category.thresholdText}` : ""}
        </li>
      ))}
    </ul>
  );
}

/**
 * The trait vocabulary, rendered from the response. This replaces a browsable
 * grid of every possible archetype name: with composed names that list would
 * run to hundreds of entries and tell the reader nothing about themselves.
 */
function ArchetypeVocabulary({ fp }: { fp: FingerprintData }) {
  const taxonomyAxes = fp.taxonomy?.axes ?? [];
  const current = new Map(fp.axes.map((axis) => [axis.key, axis.category]));
  const components = new Map(
    fp.archetype.components.map((component) => [component.axis, component]),
  );
  const combinationCount = taxonomyCombinationCount(taxonomyAxes);

  return (
    <details
      data-testid="fingerprint-archetype-catalog"
      className="group rounded-xl border border-border bg-bg-elevated/25"
    >
      <summary className="flex min-h-[48px] cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2 text-caption font-semibold text-text transition-colors hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
        <Fingerprint className="h-4 w-4 flex-none text-accent-cyan" aria-hidden />
        <span>The archetype vocabulary</span>
        {combinationCount > 0 ? (
          <span className="rounded-full border border-border bg-bg-surface px-2 py-0.5 text-micro tabular-nums text-text-dim">
            {combinationCount.toLocaleString()} possible profiles
          </span>
        ) : null}
        <ChevronDown
          className="ml-auto h-4 w-4 flex-none text-text-dim transition-transform group-open:rotate-180"
          aria-hidden
        />
      </summary>

      <div className="border-t border-border px-3 py-4 sm:px-4">
        <p className="text-micro leading-relaxed text-text-dim">
          Every response-owned trait below can contribute to a compositional
          archetype name. Your current trait is highlighted with the role and
          distinctiveness that explain whether it shaped the name.
        </p>
        <ol className="mt-3 space-y-3">
          {taxonomyAxes.map((axis) => (
            <li
              key={axis.key}
              className="rounded-lg border border-border bg-bg-surface/45 p-3"
            >
              <p className="text-micro font-semibold uppercase tracking-wider text-text-dim">
                {axis.label}
              </p>
              <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
                {axis.categories.map((category) => {
                  const isCurrent = current.get(axis.key) === category.key;
                  const component = components.get(axis.key);
                  return (
                    <li
                      key={category.key}
                      data-testid="archetype-option"
                      aria-current={isCurrent ? "true" : undefined}
                      className={[
                        "rounded-lg border px-2.5 py-2",
                        isCurrent
                          ? "border-accent bg-accent/10"
                          : "border-border bg-bg-elevated/35",
                      ].join(" ")}
                    >
                      <span className="block text-caption font-semibold text-text">
                        {category.label}
                      </span>
                      <span className="mt-0.5 block text-micro text-text-dim">
                        {category.adjective} · {category.noun}
                      </span>
                      <span className="mt-1 block text-micro leading-relaxed text-text-muted">
                        {category.blurb}
                      </span>
                      <span className="mt-1 block text-micro tabular-nums text-text-dim">
                        {category.thresholdText}
                        {typeof category.score === "number"
                          ? ` · Score ${formatSignedScore(category.score)}`
                          : ""}
                      </span>
                      {isCurrent ? (
                        <span className="mt-1 inline-block rounded-full bg-accent/15 px-2 py-0.5 text-micro font-semibold text-accent-cyan">
                          Your trait
                          {component
                            ? ` · ${component.role} · ${formatNumber(component.distinctiveness, 2)} distinctive`
                            : ""}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}

function axisAvailable(
  axis: FingerprintAxis | undefined,
): axis is FingerprintAxis & { position: number; value: number } {
  return Boolean(
    axis &&
      typeof axis.position === "number" &&
      Number.isFinite(axis.position) &&
      typeof axis.value === "number" &&
      Number.isFinite(axis.value) &&
      axis.category &&
      axis.categoryLabel,
  );
}

function hasShares(detail: AxisDetail | null): detail is AxisDetail {
  return Boolean(
    detail &&
      typeof detail.earlyShare === "number" &&
      typeof detail.lateShare === "number",
  );
}

function findCategory(
  fp: FingerprintData,
  axisKey: string,
  categoryKey: string,
): TaxonomyCategory | undefined {
  return fp.taxonomy?.axes
    .find((axis) => axis.key === axisKey)
    ?.categories.find((category) => category.key === categoryKey);
}

function axisValueLabel(key: string, axis: FingerprintAxis): string {
  if (axis.value == null) return "—";
  if (key === "repertoire") {
    return `${Math.round(axis.value).toLocaleString()} detected`;
  }
  if (key === "pace") return `${formatDuration(axis.value)} avg`;
  if (key === "matchup_edge") {
    const score = axis.detail?.tierScore;
    return `${formatSignedPoints(axis.value)}${
      typeof score === "number" ? ` · score ${formatSignedScore(score)}` : ""
    }`;
  }
  return formatNumber(axis.value, 2);
}

/**
 * Explain an unrated track from the API's own `reason` / `have` / `needed`.
 * Thresholds are never restated here — they used to be, and drifted from the
 * service the moment a minimum moved.
 */
function missingAxisEvidence(
  key: string,
  axis: FingerprintAxis | undefined,
  fp: FingerprintData,
): string {
  const have = axis?.have ?? axis?.sampleSize ?? 0;
  const needed = axis?.needed ?? null;
  const progress = needed == null ? `${have} so far` : `${have} of ${needed}`;
  switch (axis?.reason) {
    case "needs_more_classified_builds":
      return `This track needs replays with a recognized build — ${progress}.`;
    case "needs_more_timed_games":
      return `This track needs replays with a valid game time — ${progress}.`;
    case "no_comparison_matchup":
      return `This track compares ${fp.matchup} with your other two matchups, and neither has enough decided games yet.`;
    case "needs_more_decided_games": {
      const counts = fp.matchupWinRates
        .map((row) => `${row.matchup} ${row.decidedGames}`)
        .join(" · ");
      return `This track needs ${needed ?? "more"} wins or losses in ${fp.matchup}${
        counts ? `. Right now: ${counts}.` : "."
      }`;
    }
    default:
      return key === "matchup_edge"
        ? "This track needs more decided games across your matchups."
        : `This track needs more replays — ${progress}.`;
  }
}

function axisEvidence(
  key: string,
  axis: FingerprintAxis,
  fp: FingerprintData,
): string {
  const sample = axis.sampleSize.toLocaleString();
  const plural = axis.sampleSize === 1 ? "" : "s";
  if (key === "repertoire") {
    const repertoire = repertoireMeasures(fp, axis);
    const base = `We detected ${repertoire.distinct.toLocaleString()} distinct build${repertoire.distinct === 1 ? "" : "s"} across ${sample} classified ${fp.matchup} replay${plural}.`;
    if (!isFiniteNumber(repertoire.effective)) {
      return `${base} The server selected ${axis.categoryLabel}, but did not return a frequency-adjusted effective count for this response.`;
    }
    const concentration =
      repertoire.topBuildShare != null
        ? ` The most-used build accounts for ${formatPercentValue(repertoire.topBuildShare)} of classified games.`
        : "";
    return `${base} Shannon diversity makes that mix equivalent to ${formatEffectiveBuilds(repertoire.effective)} equally used builds, which selects ${axis.categoryLabel}.${concentration}`;
  }
  if (key === "pace") {
    const average = paceAverage(fp, axis);
    const base = `Your ${sample} timed ${fp.matchup} replay${plural} averaged ${formatOptionalDuration(average)}.`;
    return fp.paceSummary
      ? `${base} The ${axis.categoryLabel} badge uses the real time-band counts in the distribution card below.`
      : `${base} The server selected ${axis.categoryLabel}.`;
  }
  if (key !== "matchup_edge") return `Based on ${sample} replay${plural}.`;

  const detail = axis.detail;
  const against = detail?.comparedAgainst?.length
    ? detail.comparedAgainst.join(" and ")
    : "your qualifying comparison matchups";
  const delta = firstFinite(detail?.signedEdge, axis.value) ?? 0;
  const score = firstFinite(detail?.tierScore, fp.matchupSummary.tierScore);
  const spread = firstFinite(
    detail?.allMatchupSpread,
    fp.matchupSummary.spread,
  );
  // One short sentence of numbers, then one short sentence of reasoning. The
  // endpoint / anchor / tie-break mechanics live in the methodology panel —
  // restating them here is what made this paragraph unreadable.
  const comparison = `You win ${fp.matchup} at ${formatWinRate(detail?.winRate ?? null)}, versus ${formatWinRate(detail?.comparatorWinRate ?? null)} across ${against}. That is ${formatSignedPoints(delta)} from ${sample} decided game${plural}.`;
  const label = axis.categoryLabel ?? "this tier";
  const withScore = score != null ? ` (score ${formatSignedScore(score)})` : "";

  if (axis.category === "specialist") {
    return `${comparison} Ahead by 10 points or more makes it ${label}${withScore}.`;
  }
  if (axis.category === "matchup_edge") {
    return delta === 0
      ? `${comparison} Dead level counts as the strength side, so it is ${label}${withScore}.`
      : `${comparison} Ahead, but by less than 10 points, so it is ${label}${withScore}.`;
  }
  if (axis.category === "blind_spot") {
    return `${comparison} Behind by 10 points or more makes it ${label}${withScore}.`;
  }
  if (axis.category === "matchup_hurdle") {
    return `${comparison} Behind, but by less than 10 points, so it is ${label}${withScore}.`;
  }
  if (axis.category === "universalist") {
    return `${comparison} All three matchups sit within ${formatPointGap(spread)} of each other, so it is ${label}${withScore}.`;
  }
  return comparison;
}

function paceProfileEvidence(
  axis: FingerprintAxis,
  summary: NonNullable<FingerprintData["paceSummary"]>,
): string {
  const sample = axis.sampleSize;
  const label = axis.categoryLabel ?? "this profile";
  if (axis.category === "two_speed") {
    return `${summary.belowFive.games}/${sample} (${formatSharePercent(summary.belowFive.percent)}) ended under 5:00 and ${summary.aboveFifteen.games}/${sample} (${formatSharePercent(summary.aboveFifteen.percent)}) ran over 15:00, meeting both quarter-share rules for ${label}.`;
  }
  if (axis.category === "late_game_master") {
    return `${summary.aboveFifteen.games}/${sample} (${formatSharePercent(summary.aboveFifteen.percent)}) ran over 15:00, meeting the 80% rule for ${label}.`;
  }
  if (axis.category === "mid_late_master") {
    return `${summary.aboveTen.games}/${sample} (${formatSharePercent(summary.aboveTen.percent)}) reached beyond 10:00, meeting the 80% rule for ${label}.`;
  }
  if (axis.category === "timing_attacker") {
    return `${summary.fiveToTen.games}/${sample} (${formatSharePercent(summary.fiveToTen.percent)}) finished from 5:00 through 10:00, meeting the 80% rule for ${label}.`;
  }
  if (axis.category === "cheeser") {
    if (axis.detail?.classificationMethod === "dominant_under_five") {
      return `${summary.belowFive.games}/${sample} (${formatSharePercent(summary.belowFive.percent)}) ended under 5:00, meeting the 80% rule for ${label}.`;
    }
    return `No stronger distribution signature fired, and the average is strictly under 5:00, so the fallback selects ${label}.`;
  }
  if (axis.category === "late_game") {
    return `The average is over 10:00 without an 80% long-game cluster, so the server selects ${label}.`;
  }
  if (axis.category === "flexible") {
    return `The average is from 5:00 through 10:00 and no stronger distribution pattern overrides it, so the server selects ${label}.`;
  }
  return `The server selected ${label} from the real duration distribution above.`;
}

/** One line describing which replays fed the profile. */
function windowSummary(fp: FingerprintData, rangeLabel: string): string {
  const games = fp.games.toLocaleString();
  const plural = fp.games === 1 ? "" : "s";
  if (fp.windowMode === "range") {
    const truncated = fp.windowTruncated
      ? ` Capped at the most recent ${fp.windowGames.toLocaleString()} per matchup.`
      : "";
    return `Based on ${games} ${fp.matchup} 1v1 replay${plural} in ${rangeLabel.toLowerCase()}.${truncated}`;
  }
  return `Based on ${games} recent ${fp.matchup} 1v1 replay${plural}, using up to your latest ${fp.windowGames.toLocaleString()}.`;
}

const STRIPPED_FILTER_NAMES: Record<string, string> = {
  build: "build",
  mmr_min: "MMR",
  mmr_max: "MMR",
  opp_strategy: "opponent strategy",
  leak: "macro leak",
  macro_min: "macro score",
  macro_max: "macro score",
  race: "race",
  opp_race: "opponent race",
  group_by_race_played: "race grouping",
};

/**
 * Name the filters the fingerprint ignored. Silence here reads as the original
 * bug from the other direction — a user who filtered to one build and saw
 * "Creative Genius" would rightly call it broken.
 */
function strippedFilterNote(stripped: string[]): string {
  const names = [...new Set(stripped.map((k) => STRIPPED_FILTER_NAMES[k] || k))];
  if (names.length === 0) return "";
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const verb = names.length === 1 ? "filter doesn't" : "filters don't";
  return `Your ${list} ${verb} apply here — the fingerprint needs your whole cohort to measure variety and matchup edge.`;
}

function clampPosition(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function firstFinite(...values: unknown[]): number | null {
  for (const value of values) {
    if (isFiniteNumber(value)) return value;
  }
  return null;
}

function repertoireMeasures(
  fp: FingerprintData,
  axis?: FingerprintAxis,
): {
  distinct: number;
  effective: number | null;
  topBuildShare: number | null;
} {
  const distinct = firstFinite(
    fp.repertoireSummary?.distinctBuilds,
    axis?.detail?.distinctBuilds,
    axis?.value,
    fp.buildOrders.length,
  );
  return {
    distinct: Math.max(0, Math.round(distinct ?? 0)),
    effective: firstFinite(
      fp.repertoireSummary?.effectiveBuilds,
      axis?.detail?.effectiveBuilds,
    ),
    topBuildShare: firstFinite(
      fp.repertoireSummary?.topBuildShare,
      axis?.detail?.topBuildShare,
    ),
  };
}

function paceAverage(
  fp: FingerprintData,
  axis?: FingerprintAxis,
): number | null {
  return firstFinite(
    fp.paceSummary?.averageSec,
    axis?.detail?.averageSec,
    axis?.detail?.meanSec,
    axis?.value,
  );
}

function taxonomyCombinationCount(axes: TaxonomyAxis[]): number {
  if (axes.length === 0 || axes.some((axis) => axis.categories.length === 0)) {
    return 0;
  }
  return axes.reduce((total, axis) => total * axis.categories.length, 1);
}

/**
 * Win rates and point gaps render to one decimal, not three. The API keeps
 * full precision — display precision is a layout decision, and "70.968%" both
 * overflowed the matchup boxes and read as false precision on a 31-game
 * sample.
 */
function formatWinRate(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${formatNumber(value, 1)}%`;
}

function formatSharePercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${formatNumber(value, 1)}%`;
}

function formatPercentValue(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const percent = Math.abs(value) <= 1 ? value * 100 : value;
  return `${formatNumber(percent, 1)}%`;
}

function formatPointGap(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${formatNumber(value, 1)} pts`;
}

function formatSignedPoints(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${formatNumber(Math.abs(value), 1)} pts`;
}

function formatSignedScore(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${formatNumber(value, 0)}`;
}

function formatEffectiveBuilds(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  const nearBoundary = [1.5, 2.5, 5, 10].some(
    (boundary) => Math.abs(value - boundary) > 0 && Math.abs(value - boundary) < 0.01,
  );
  return formatNumber(value, nearBoundary ? 6 : 2);
}

function formatOptionalEffective(value: number | null): string {
  return value == null ? "Unavailable" : formatEffectiveBuilds(value);
}

function formatShare(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${Math.round(value * 100)}%`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const totalHundredths = Math.round(seconds * 100);
  const minutes = Math.floor(totalHundredths / 6000);
  const remainderHundredths = totalHundredths % 6000;
  const wholeSeconds = Math.floor(remainderHundredths / 100);
  const hundredths = remainderHundredths % 100;
  const fraction =
    hundredths === 0
      ? ""
      : hundredths % 10 === 0
        ? `.${hundredths / 10}`
        : `.${String(hundredths).padStart(2, "0")}`;
  return `${minutes}:${String(wholeSeconds).padStart(2, "0")}${fraction}`;
}

function formatOptionalDuration(value: number | null): string {
  return value == null ? "Unavailable" : formatDuration(value);
}

function formatNumber(value: number, places: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: places,
  });
}

/** Compact two-sided matchup picker with visible group labels. */
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
    <div
      aria-label="Fingerprint matchup"
      className="flex max-w-full items-end gap-2 overflow-x-auto pb-1 sm:ml-auto sm:pb-0"
    >
      <ChipGroup
        label="You play"
        side="I play"
        active={my}
        onPick={(letter) => onChange(letter, vs)}
      />
      <span className="mb-3 text-micro font-bold text-text-dim">vs</span>
      <ChipGroup
        label="Opponent"
        side="Versus"
        active={vs}
        onPick={(letter) => onChange(my, letter)}
      />
    </div>
  );
}

function ChipGroup({
  label,
  side,
  active,
  onPick,
}: {
  label: string;
  side: string;
  active: RaceLetter;
  onPick: (letter: RaceLetter) => void;
}) {
  return (
    <fieldset className="flex-none">
      <legend className="mb-1 text-micro font-medium text-text-dim">{label}</legend>
      <div className="flex items-center gap-1">
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
                "flex h-11 w-11 items-center justify-center rounded-lg border text-caption font-bold",
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
    </fieldset>
  );
}
