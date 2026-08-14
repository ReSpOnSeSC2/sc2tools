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
  /** Why an unrated track is unrated. Null once the track has a category. */
  reason: AxisReason | string | null;
  have: number | null;
  needed: number | null;
};

/** Per-axis derived measures. `value` stays the axis's headline unit. */
type AxisDetail = {
  effectiveBuilds?: number;
  distinctBuilds?: number;
  topBuildShare?: number;
  earlyShare?: number;
  midShare?: number;
  lateShare?: number;
  medianSec?: number;
  meanSec?: number;
  winRate?: number;
  comparatorWinRate?: number;
  comparedAgainst?: string[];
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
  buildOrders: Array<{ name: string; games: number }>;
  matchupWinRates: MatchupWinRate[];
  matchupSummary: {
    spread: number | null;
    leaderGap: number | null;
    weakGap: number | null;
    strongestMatchup: string | null;
    weakestMatchup: string | null;
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

          <dl className="grid grid-cols-2 gap-2">
            <HeroStat label="Matchup" value={fp.matchup} />
            <HeroStat
              label="Build orders"
              value={
                axisAvailable(repertoire)
                  ? `${fp.buildOrders.length.toLocaleString()}${
                      repertoire.detail?.effectiveBuilds
                        ? ` · ${repertoire.detail.effectiveBuilds} effective`
                        : ""
                    }`
                  : "Still forming"
              }
            />
            <HeroStat
              label="Median game"
              value={axisAvailable(pace) ? formatDuration(pace.value) : "Still forming"}
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

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)]">
        <MatchupEvidence fp={fp} />
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
  const scale = meta.categories
    .map((category) => category.thresholdText)
    .filter(Boolean)
    .join(" · ");

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
              <span className="absolute left-1/2 top-1/2 h-4 w-px -translate-x-1/2 -translate-y-1/2 bg-text/35" />
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
            {scale ? (
              <p className="mt-2 text-center text-micro tabular-nums text-text-dim">
                {scale}
              </p>
            ) : null}
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
  return (
    <section
      className="rounded-xl border border-border bg-bg-elevated/25 p-4"
      aria-labelledby="matchup-evidence-heading"
    >
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
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
        {fp.matchupSummary.spread != null ? (
          <span className="text-micro font-semibold tabular-nums text-text-muted">
            {formatPercentGap(fp.matchupSummary.spread)} between best and worst
          </span>
        ) : null}
      </div>

      {fp.matchupWinRates.length > 0 ? (
        <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {fp.matchupWinRates.map((row) => {
            const selected = row.matchup === fp.matchup;
            const strong = selected && edge?.category === "edge_strong";
            const weak = selected && edge?.category === "edge_weak";
            return (
              <div
                key={row.matchup}
                className={[
                  "rounded-lg border p-3",
                  strong
                    ? "border-accent/55 bg-accent/10"
                    : weak
                      ? "border-danger/35 bg-danger/5"
                      : selected
                        ? "border-border-strong bg-bg-surface"
                        : "border-border bg-bg-surface/55",
                ].join(" ")}
              >
                <dt className="flex items-center justify-between gap-2">
                  <span className="font-display text-caption font-bold text-text">
                    {row.matchup}
                  </span>
                  <span className="text-micro font-semibold tabular-nums text-text-dim">
                    {row.decidedGames} decided
                  </span>
                </dt>
                <dd className="mt-2 font-display text-h4 font-bold tabular-nums text-text">
                  {formatWinRate(row.winRate)}
                </dd>
                <dd className="mt-1 text-micro tabular-nums text-text-muted">
                  {row.wins}W · {row.losses}L
                  {row.ties > 0 ? ` · ${row.ties}T` : ""}
                </dd>
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

function BuildEvidence({ fp }: { fp: FingerprintData }) {
  const preview = fp.buildOrders.slice(0, 8);
  const remaining = fp.buildOrders.length - preview.length;
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
        <span className="text-micro font-semibold tabular-nums text-text-muted">
          {fp.buildOrders.length} distinct
        </span>
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
    </section>
  );
}

function MethodologyDetails({ fp }: { fp: FingerprintData }) {
  const taxonomyAxes = fp.taxonomy?.axes ?? [];
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
          Build variety and game length use {fp.games} {fp.matchup} 1v1 replays.
          The matchup-edge track compares this matchup against separate windows
          for your other two. Each track needs enough games before it receives a
          rating.{" "}
          {fp.windowMode === "range"
            ? "These windows follow your dashboard date range."
            : `With no date range set, each window uses your latest ${fp.windowGames.toLocaleString()} games.`}{" "}
          Your race and matchup come from the picker above, not the dashboard
          race filter.
        </p>

        <ol className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
          {taxonomyAxes.map((axis, index) => (
            <li
              key={axis.key}
              className="rounded-lg border border-border bg-bg-surface/55 p-3"
            >
              <p className="text-caption font-semibold text-text">
                {index + 1}. {axis.label}
              </p>
              <p className="mt-1 text-micro leading-relaxed text-text-muted">
                {axis.description}
              </p>
              <ul className="mt-2 space-y-1">
                {axis.categories.map((category) => (
                  <li key={category.key} className="text-micro text-text-dim">
                    <span className="font-semibold text-text-muted">
                      {category.label}
                    </span>
                    {category.thresholdText ? ` — ${category.thresholdText}` : ""}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>

        <p className="mt-4 rounded-lg border border-accent/25 bg-accent/5 p-3 text-micro leading-relaxed text-text-muted">
          Your archetype is named after the two tracks where you are furthest
          from ordinary, so it describes what is distinctive about you rather
          than which bucket you happen to land in. If nothing stands out, you
          get a balanced name. If a track needs more games, your profile stays
          incomplete until the replay data is there.
        </p>
      </div>
    </details>
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

  return (
    <details
      data-testid="fingerprint-archetype-catalog"
      className="group rounded-xl border border-border bg-bg-elevated/25"
    >
      <summary className="flex min-h-[48px] cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2 text-caption font-semibold text-text transition-colors hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
        <Fingerprint className="h-4 w-4 flex-none text-accent-cyan" aria-hidden />
        <span>The archetype vocabulary</span>
        <ChevronDown
          className="ml-auto h-4 w-4 flex-none text-text-dim transition-transform group-open:rotate-180"
          aria-hidden
        />
      </summary>

      <div className="border-t border-border px-3 py-4 sm:px-4">
        <p className="text-micro leading-relaxed text-text-dim">
          Every trait below can contribute to an archetype name. Your current
          trait on each track is highlighted.
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
                      {isCurrent ? (
                        <span className="mt-1 inline-block rounded-full bg-accent/15 px-2 py-0.5 text-micro font-semibold text-accent-cyan">
                          Your trait
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
    const count = Math.round(axis.value);
    return `${count} build${count === 1 ? "" : "s"}`;
  }
  if (key === "pace") return `${formatDuration(axis.value)} median`;
  if (key === "matchup_edge") {
    const sign = axis.value > 0 ? "+" : "";
    return `${sign}${formatNumber(axis.value, 1)}%`;
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
    const count = Math.round(axis.value as number);
    const effective = axis.detail?.effectiveBuilds;
    const top = axis.detail?.topBuildShare;
    const concentration =
      effective != null && count > effective + 0.5
        ? ` Your games concentrate on fewer of them${
            top != null ? ` — your top build is ${formatShare(top)} of them` : ""
          }, so that counts as ${effective} effective build${effective === 1 ? "" : "s"}.`
        : "";
    return `We recognized ${count} different build${count === 1 ? "" : "s"} across ${sample} ${fp.matchup} replay${plural}.${concentration}`;
  }
  if (key === "pace") {
    const detail = axis.detail;
    const spread =
      detail && hasShares(detail)
        ? ` ${formatShare(detail.earlyShare ?? 0)} ended early and ${formatShare(detail.lateShare ?? 0)} ran long.`
        : "";
    return `Your ${sample} timed ${fp.matchup} replay${plural} have a median length of ${formatDuration(axis.value as number)}.${spread}`;
  }
  if (key === "matchup_edge") {
    const detail = axis.detail;
    const against = detail?.comparedAgainst?.length
      ? detail.comparedAgainst.join(" and ")
      : "your other matchups";
    const delta = axis.value as number;
    const direction =
      axis.category === "edge_strong"
        ? "better"
        : axis.category === "edge_weak"
          ? "worse"
          : "close to";
    if (axis.category === "edge_on_par") {
      return `You win ${fp.matchup} at ${formatPercentGap(detail?.winRate ?? null)}, ${direction} your ${against} average of ${formatPercentGap(detail?.comparatorWinRate ?? null)}. No clear edge either way, from ${sample} decided game${plural}.`;
    }
    return `You win ${fp.matchup} at ${formatPercentGap(detail?.winRate ?? null)} against ${formatPercentGap(detail?.comparatorWinRate ?? null)} in ${against} — ${formatNumber(Math.abs(delta), 1)} points ${direction}, from ${sample} decided game${plural}.`;
  }
  return `Based on ${sample} replay${plural}.`;
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
  return `Your ${list} ${verb} apply here — the fingerprint needs your whole cohort to measure variety and matchup shape.`;
}

function clampPosition(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function normalizeWinRate(value: number): number {
  return Math.abs(value) <= 1 ? value * 100 : value;
}

function formatWinRate(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${formatNumber(normalizeWinRate(value), 3)}%`;
}

function formatPercentGap(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${formatNumber(value, 3)}%`;
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
